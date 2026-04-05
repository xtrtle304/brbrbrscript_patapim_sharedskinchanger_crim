const { WebSocketServer } = require("ws");
const http = require("http");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const SECRET_KEY = process.env.SECRET_KEY || "change-me-in-railway";

// ─── State ────────────────────────────────────────────────────────────────────
// Map<playerId, { ItemName, TextureID, updatedAt }>
const skins = new Map();

// Map<ws, { playerId, authenticated }>
const clients = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(payload, exclude = null) {
  for (const [ws] of clients) {
    if (ws !== exclude) send(ws, payload);
  }
}

function log(tag, msg, extra = "") {
  const time = new Date().toISOString();
  console.log(`[${time}] [${tag}] ${msg}`, extra);
}

// ─── HTTP Server (health check для Railway) ───────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", players: skins.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Roblox Skin Sync Server is running.");
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  log("CONNECT", `New connection from ${ip}`);

  clients.set(ws, { playerId: null, authenticated: false });

  // Send welcome + требуем аутентификацию
  send(ws, { type: "hello", message: "Send { type: 'auth', key: SECRET, playerId: '...' } to authenticate." });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const client = clients.get(ws);

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (msg.type === "auth") {
      if (msg.key !== SECRET_KEY) {
        send(ws, { type: "error", message: "Invalid secret key." });
        log("AUTH", `Failed auth from ${ip}`);
        return;
      }
      if (!msg.playerId || typeof msg.playerId !== "string") {
        send(ws, { type: "error", message: "playerId is required." });
        return;
      }

      client.playerId = msg.playerId;
      client.authenticated = true;
      log("AUTH", `Player ${msg.playerId} authenticated from ${ip}`);

      // Отправить текущие скины новому игроку
      const allSkins = Object.fromEntries(skins);
      send(ws, { type: "auth_ok", playerId: msg.playerId });
      send(ws, { type: "skin_list", skins: allSkins });
      return;
    }

    // Все остальные сообщения требуют авторизации
    if (!client.authenticated) {
      send(ws, { type: "error", message: "Not authenticated. Send auth first." });
      return;
    }

    // ── SET_SKIN ──────────────────────────────────────────────────────────────
    if (msg.type === "set_skin") {
      const { ItemName, TextureID } = msg;

      if (!ItemName || typeof ItemName !== "string") {
        send(ws, { type: "error", message: "ItemName is required (string)." });
        return;
      }
      if (!TextureID || typeof TextureID !== "string") {
        send(ws, { type: "error", message: "TextureID is required (string)." });
        return;
      }

      const skinData = {
        ItemName,
        TextureID,
        updatedAt: Date.now(),
      };

      skins.set(client.playerId, skinData);
      log("SET_SKIN", `Player ${client.playerId} → ItemName: "${ItemName}", TextureID: "${TextureID}"`);

      // Подтвердить отправителю
      send(ws, { type: "skin_updated", playerId: client.playerId, skin: skinData });

      // Разослать всем остальным
      broadcast(
        { type: "skin_changed", playerId: client.playerId, skin: skinData },
        ws
      );
      return;
    }

    // ── GET_SKIN ──────────────────────────────────────────────────────────────
    if (msg.type === "get_skin") {
      const targetId = msg.playerId || client.playerId;
      const skin = skins.get(targetId) || null;
      send(ws, { type: "skin_data", playerId: targetId, skin });
      return;
    }

    // ── GET_ALL_SKINS ─────────────────────────────────────────────────────────
    if (msg.type === "get_all_skins") {
      send(ws, { type: "skin_list", skins: Object.fromEntries(skins) });
      return;
    }

    // ── REMOVE_SKIN ───────────────────────────────────────────────────────────
    if (msg.type === "remove_skin") {
      skins.delete(client.playerId);
      log("REMOVE", `Player ${client.playerId} removed their skin`);
      send(ws, { type: "skin_removed", playerId: client.playerId });
      broadcast({ type: "skin_removed", playerId: client.playerId }, ws);
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
    const client = clients.get(ws);
    if (client?.playerId) {
      log("DISCONNECT", `Player ${client.playerId} disconnected`);
    }
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    log("ERROR", err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  log("SERVER", `Listening on port ${PORT}`);
  log("SERVER", `SECRET_KEY = "${SECRET_KEY}"`);
});
