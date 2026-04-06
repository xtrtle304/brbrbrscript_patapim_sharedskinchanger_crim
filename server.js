// ─────────────────────────────────────────────────────────────────────────────
//  SkinSync — Railway WebSocket Server
//  node server.js
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket = require("ws");
const http      = require("http");

const PORT = process.env.PORT || 8080;

// ─── In-memory state ──────────────────────────────────────────────────────────
//
//  servers   Map<serverId, ServerEntry>
//
//  ServerEntry {
//    ws      : WebSocket
//    players : Map<userId, PlayerEntry>
//  }
//
//  PlayerEntry {
//    name  : string
//    skins : string[]   // index → SkinName
//  }
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, { ws: WebSocket, players: Map<string, { name: string, skins: string[] }> }>} */
const servers = new Map();

// ─── Utility ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(tag, ...args) {
  console.log(`[${ts()}] [${tag}]`, ...args);
}

/** Safe JSON send */
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Broadcast to every registered server.
 * @param {object}  payload
 * @param {string=} excludeServerId  — skip this server
 */
function broadcast(payload, excludeServerId = null) {
  for (const [sid, srv] of servers) {
    if (sid !== excludeServerId) {
      send(srv.ws, payload);
    }
  }
}

/** Flatten all players across all servers into a plain array */
function allPlayersSnapshot() {
  const list = [];
  for (const [sid, srv] of servers) {
    for (const [uid, p] of srv.players) {
      list.push({ serverId: sid, userId: uid, name: p.name, skins: p.skins });
    }
  }
  return list;
}

/** Build telemetry object */
function buildTelemetry() {
  const perServer = {};
  let total = 0;
  for (const [sid, srv] of servers) {
    perServer[sid] = srv.players.size;
    total += srv.players.size;
  }
  return {
    serverCount  : servers.size,
    totalPlayers : total,
    perServer,
    timestamp    : Date.now(),
  };
}

// ─── HTTP server  (REST telemetry endpoint) ───────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // GET /telemetry
  if (req.method === "GET" && req.url === "/telemetry") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, ...buildTelemetry() }, null, 2));
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, req) => {
  // Client passes its serverId as a query param:
  //   wss://your-app.railway.app?serverId=PlaceId_JobId
  const url      = new URL(req.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") || `srv_${Date.now()}`;

  log("CONNECT", `serverId=${serverId}`);

  // Register server slot
  servers.set(serverId, { ws, players: new Map() });

  // ── Tell the newcomer: "here's everyone currently online everywhere" ─────────
  send(ws, {
    type    : "WELCOME",
    serverId,
    players : allPlayersSnapshot(),   // all OTHER servers' players
  });

  // ── Message dispatcher ───────────────────────────────────────────────────────
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send(ws, { type: "ERROR", error: "invalid JSON" }); return; }

    const srv = servers.get(serverId);
    if (!srv) return;

    switch (msg.type) {

      // ── Bulk announce: "here are all players currently on my server" ─────────
      // Sent once right after connection, from the Luau script's initial sweep.
      case "ANNOUNCE_PLAYERS": {
        // msg.players: Array<{ userId, name, skins }>
        if (!Array.isArray(msg.players)) {
          send(ws, { type: "ERROR", error: "ANNOUNCE_PLAYERS.players must be an array" });
          return;
        }
        for (const p of msg.players) {
          if (!p.userId || !p.name || !Array.isArray(p.skins)) continue;
          srv.players.set(String(p.userId), { name: p.name, skins: p.skins });
        }
        log("ANNOUNCE_PLAYERS", `server=${serverId} count=${msg.players.length}`);

        // Let every other server know about this server's full roster
        broadcast({
          type     : "PLAYERS_ANNOUNCED",
          serverId ,
          players  : msg.players,
        }, serverId);

        send(ws, { type: "ANNOUNCE_ACK", count: msg.players.length });
        break;
      }

      // ── A single player joined ───────────────────────────────────────────────
      // msg: { userId, name, skins[] }
      case "PLAYER_JOIN": {
        const { userId, name, skins } = msg;
        if (!userId || !name || !Array.isArray(skins)) {
          send(ws, { type: "ERROR", error: "PLAYER_JOIN: userId, name, skins[] required" });
          return;
        }
        srv.players.set(String(userId), { name, skins });
        log("PLAYER_JOIN", `server=${serverId}  ${userId}(${name})  skins=${skins.length}`);

        // Tell every other server
        broadcast({ type: "PLAYER_JOINED", serverId, userId, name, skins }, serverId);

        // Confirm to origin + send fresh global roster
        send(ws, { type: "PLAYER_JOIN_ACK", userId });
        send(ws, { type: "ROSTER_SYNC", players: allPlayersSnapshot() });
        break;
      }

      // ── A player left ────────────────────────────────────────────────────────
      // msg: { userId }
      case "PLAYER_LEAVE": {
        const { userId } = msg;
        const player = srv.players.get(String(userId));
        if (!player) { send(ws, { type: "ERROR", error: "unknown userId" }); return; }

        srv.players.delete(String(userId));
        log("PLAYER_LEAVE", `server=${serverId}  ${userId}(${player.name})`);

        broadcast({ type: "PLAYER_LEFT", serverId, userId, name: player.name }, serverId);
        break;
      }

      // ── Player updated their skins ───────────────────────────────────────────
      // msg: { userId, skins[] }
      case "UPDATE_SKINS": {
        const { userId, skins } = msg;
        const player = srv.players.get(String(userId));
        if (!player || !Array.isArray(skins)) {
          send(ws, { type: "ERROR", error: "UPDATE_SKINS: unknown userId or invalid skins" });
          return;
        }
        player.skins = skins;
        log("UPDATE_SKINS", `server=${serverId}  ${userId}  skins=${skins.length}`);

        broadcast({ type: "SKINS_UPDATED", serverId, userId, name: player.name, skins }, serverId);
        send(ws, { type: "UPDATE_SKINS_ACK", userId, skins });
        break;
      }

      // ── Telemetry over WebSocket ─────────────────────────────────────────────
      case "GET_TELEMETRY": {
        send(ws, { type: "TELEMETRY", ...buildTelemetry() });
        break;
      }

      // ── Keepalive ────────────────────────────────────────────────────────────
      case "PING": {
        send(ws, { type: "PONG", ts: Date.now() });
        break;
      }

      default:
        send(ws, { type: "ERROR", error: `unknown type: ${msg.type}` });
    }
  });

  // ── Clean up when this game server disconnects ───────────────────────────────
  ws.on("close", () => {
    const srv = servers.get(serverId);
    if (!srv) return;

    log("DISCONNECT", `serverId=${serverId}  players=${srv.players.size}`);

    // Notify remaining servers
    for (const [uid, p] of srv.players) {
      broadcast(
        { type: "PLAYER_LEFT", serverId, userId: uid, name: p.name, reason: "server_closed" },
        serverId,
      );
    }
    servers.delete(serverId);
  });

  ws.on("error", (err) => log("WS_ERR", `server=${serverId}`, err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  log("READY", `Port=${PORT}`);
  log("READY", `WS  → ws://host:${PORT}?serverId=<id>`);
  log("READY", `API → GET /telemetry`);
});
