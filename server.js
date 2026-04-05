const { WebSocketServer } = require("ws");
const http = require("http");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 8080;
const SECRET_KEY = process.env.SECRET_KEY || "change-me-in-railway";

// ─── State ────────────────────────────────────────────────────────────────────
//
//  servers  →  Map< serverId, ServerRoom >
//
//  ServerRoom = {
//    skins  : Map< playerId, Map< ItemName, { TextureID, updatedAt } > >
//    clients: Map< ws, ClientInfo >
//  }
//
const servers = new Map();

// ─── Room helpers ─────────────────────────────────────────────────────────────
function getRoom(serverId) {
  if (!servers.has(serverId)) {
    servers.set(serverId, { skins: new Map(), clients: new Map() });
  }
  return servers.get(serverId);
}

function cleanRoom(serverId) {
  const room = servers.get(serverId);
  if (room && room.clients.size === 0) {
    servers.delete(serverId);
    log("ROOM", `Server ${serverId} destroyed (empty)`);
  }
}

// ─── Skin helpers ─────────────────────────────────────────────────────────────
function playerSkinsToObj(room, playerId) {
  const map = room.skins.get(playerId);
  if (!map) return {};
  return Object.fromEntries(map);
}

function allSkinsToObj(room) {
  const out = {};
  for (const [pid] of room.skins) {
    out[pid] = playerSkinsToObj(room, pid);
  }
  return out;
}

// ─── Network helpers ──────────────────────────────────────────────────────────
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room, payload, exclude = null) {
  for (const [ws] of room.clients) {
    if (ws !== exclude) send(ws, payload);
  }
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── HTTP (health-check для Railway) ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    let totalPlayers = 0;
    for (const [, room] of servers) totalPlayers += room.clients.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", servers: servers.size, players: totalPlayers }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Roblox Skin Sync Server is running.");
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  log("CONNECT", `New connection from ${ip}`);

  const client = { playerId: null, serverId: null, authenticated: false };

  send(ws, {
    type   : "hello",
    message: "Send { type:'auth', key, playerId, serverId } to authenticate.",
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: "error", message: "Invalid JSON" }); return; }

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (msg.type === "auth") {
      if (msg.key !== SECRET_KEY) {
        send(ws, { type: "error", message: "Invalid secret key." });
        log("AUTH", `Failed auth from ${ip}`);
        return;
      }
      if (!msg.playerId || typeof msg.playerId !== "string") {
        send(ws, { type: "error", message: "playerId must be a non-empty string." });
        return;
      }
      if (!msg.serverId || typeof msg.serverId !== "string") {
        send(ws, { type: "error", message: "serverId must be a non-empty string." });
        return;
      }

      client.playerId      = msg.playerId;
      client.serverId      = msg.serverId;
      client.authenticated = true;

      const room = getRoom(msg.serverId);
      room.clients.set(ws, client);

      log("AUTH", `Player ${msg.playerId} joined server [${msg.serverId}]`);

      send(ws, { type: "auth_ok", playerId: msg.playerId, serverId: msg.serverId });
      // Снимок всех скинов на этом Roblox-сервере
      send(ws, { type: "skin_list", skins: allSkinsToObj(room) });
      return;
    }

    if (!client.authenticated) {
      send(ws, { type: "error", message: "Not authenticated. Send auth first." });
      return;
    }

    const room = getRoom(client.serverId);

    // ── SET_SKIN  (добавить / обновить один скин) ─────────────────────────────
    if (msg.type === "set_skin") {
      const { ItemName, TextureID } = msg;
      if (!ItemName  || typeof ItemName  !== "string") {
        send(ws, { type: "error", message: "ItemName must be a non-empty string." });
        return;
      }
      if (!TextureID || typeof TextureID !== "string") {
        send(ws, { type: "error", message: "TextureID must be a non-empty string." });
        return;
      }

      if (!room.skins.has(client.playerId)) room.skins.set(client.playerId, new Map());
      room.skins.get(client.playerId).set(ItemName, { TextureID, updatedAt: Date.now() });

      log("SET_SKIN", `[${client.serverId}] ${client.playerId} → "${ItemName}" = "${TextureID}"`);

      const updated = playerSkinsToObj(room, client.playerId);
      send(ws, { type: "skins_updated", playerId: client.playerId, skins: updated });
      broadcastRoom(room, { type: "skins_changed", playerId: client.playerId, skins: updated }, ws);
      return;
    }

    // ── SET_SKINS  (заменить весь набор скинов разом) ─────────────────────────
    if (msg.type === "set_skins") {
      if (!Array.isArray(msg.skins) || msg.skins.length === 0) {
        send(ws, { type: "error", message: "skins must be a non-empty array of { ItemName, TextureID }." });
        return;
      }

      const playerMap = new Map();
      for (const entry of msg.skins) {
        if (entry.ItemName && entry.TextureID) {
          playerMap.set(entry.ItemName, { TextureID: entry.TextureID, updatedAt: Date.now() });
        }
      }

      room.skins.set(client.playerId, playerMap);
      log("SET_SKINS", `[${client.serverId}] ${client.playerId} → ${playerMap.size} skin(s)`);

      const updated = playerSkinsToObj(room, client.playerId);
      send(ws, { type: "skins_updated", playerId: client.playerId, skins: updated });
      broadcastRoom(room, { type: "skins_changed", playerId: client.playerId, skins: updated }, ws);
      return;
    }

    // ── REMOVE_SKIN  (убрать один скин по ItemName) ───────────────────────────
    if (msg.type === "remove_skin") {
      if (!msg.ItemName || typeof msg.ItemName !== "string") {
        send(ws, { type: "error", message: "ItemName is required to remove a specific skin." });
        return;
      }

      const playerMap = room.skins.get(client.playerId);
      if (playerMap) {
        playerMap.delete(msg.ItemName);
        if (playerMap.size === 0) room.skins.delete(client.playerId);
      }

      log("REMOVE_SKIN", `[${client.serverId}] ${client.playerId} removed "${msg.ItemName}"`);

      const updated = playerSkinsToObj(room, client.playerId);
      send(ws, { type: "skins_updated", playerId: client.playerId, skins: updated });
      broadcastRoom(room, { type: "skins_changed", playerId: client.playerId, skins: updated }, ws);
      return;
    }

    // ── REMOVE_ALL_SKINS  (снять все скины) ──────────────────────────────────
    if (msg.type === "remove_all_skins") {
      room.skins.delete(client.playerId);
      log("REMOVE_ALL", `[${client.serverId}] ${client.playerId} cleared all skins`);

      send(ws, { type: "skins_updated", playerId: client.playerId, skins: {} });
      broadcastRoom(room, { type: "skins_changed", playerId: client.playerId, skins: {} }, ws);
      return;
    }

    // ── GET_SKINS  (скины конкретного игрока) ─────────────────────────────────
    if (msg.type === "get_skins") {
      const targetId = msg.playerId || client.playerId;
      send(ws, { type: "skin_data", playerId: targetId, skins: playerSkinsToObj(room, targetId) });
      return;
    }

    // ── GET_ALL_SKINS  (все скины сервера) ────────────────────────────────────
    if (msg.type === "get_all_skins") {
      send(ws, { type: "skin_list", skins: allSkinsToObj(room) });
      return;
    }

    // ── PING ──────────────────────────────────────────────────────────────────
    if (msg.type === "ping") {
      send(ws, { type: "pong", timestamp: Date.now() });
      return;
    }

    send(ws, { type: "error", message: `Unknown message type: "${msg.type}"` });
  });

  ws.on("close", () => {
    if (!client.authenticated) return;

    const room = getRoom(client.serverId);
    room.clients.delete(ws);
    room.skins.delete(client.playerId);
    log("LEAVE", `[${client.serverId}] Player ${client.playerId} left`);

    broadcastRoom(room, { type: "player_left", playerId: client.playerId });
    cleanRoom(client.serverId);
  });

  ws.on("error", (err) => log("WS_ERR", err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log("SERVER", `Listening on port ${PORT}`);
  log("SERVER", `SECRET_KEY = "${SECRET_KEY}"`);
});
