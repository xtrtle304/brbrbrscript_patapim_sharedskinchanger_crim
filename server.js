const express    = require("express");
const http       = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ─── Init ─────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());

const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "changeme_secret_key";

// ─── State ────────────────────────────────────────────────────────────────────
// servers[instanceId] = {
//   players: { userId: { name, skins[], joinedAt, lastSeen } }
// }
const servers = {};

// Long-poll queues per instanceId: Map<instanceId, Set<(events) => void>>
const longPollQueues = new Map();

// WebSocket subscriptions per instanceId: Map<instanceId, Set<ws>>
const wsSubscriptions = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureServer(instanceId) {
  if (!servers[instanceId]) servers[instanceId] = { players: {} };
  return servers[instanceId];
}

function getServerPlayers(instanceId) {
  const srv = servers[instanceId];
  if (!srv) return [];
  return Object.entries(srv.players).map(([userId, d]) => ({
    userId, name: d.name, skins: d.skins, joinedAt: d.joinedAt,
  }));
}

// Stale player pruning (60 s without heartbeat)
setInterval(() => {
  const STALE = 60_000;
  const now   = Date.now();
  for (const [id, srv] of Object.entries(servers)) {
    for (const [uid, p] of Object.entries(srv.players)) {
      if (now - p.lastSeen > STALE) {
        console.log(`[prune] ${p.name} (${uid}) from ${id}`);
        delete srv.players[uid];
        pushEvent(id, { type: "PlayerLeft", userId: uid });
      }
    }
    if (!Object.keys(srv.players).length) {
      delete servers[id];
      console.log(`[prune] server ${id} empty - removed`);
    }
  }
}, 30_000);

// ─── Event Bus ────────────────────────────────────────────────────────────────
// Pushes an event to:
//   1. All WebSocket clients subscribed to instanceId
//   2. All hanging long-poll requests for instanceId
function pushEvent(instanceId, event) {
  const payload = JSON.stringify({ instanceId, ...event });

  // WebSocket subscribers
  const wsSubs = wsSubscriptions.get(instanceId);
  if (wsSubs) {
    for (const ws of wsSubs) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // Long-poll resolvers - resolve immediately, client reconnects for next event
  const lpQueue = longPollQueues.get(instanceId);
  if (lpQueue && lpQueue.size > 0) {
    for (const resolve of lpQueue) resolve([event]);
    lpQueue.clear();
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function authHttp(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY)
    return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
// Protocol (JSON messages):
//   Client -> Server:
//     { type: "auth",        key: string }
//     { type: "subscribe",   instanceId: string }
//     { type: "unsubscribe", instanceId: string }
//     { type: "ping" }
//   Server -> Client:
//     { type: "authOk" | "authFail" }
//     { type: "subscribed", instanceId }
//     { type: "pong" }
//     { instanceId, type: "PlayerJoined" | "PlayerLeft" | "SkinsUpdated" | "InitialSync", ...data }
wss.on("connection", (ws, req) => {
  ws.isAuthed     = false;
  ws.subscribedTo = new Set();

  console.log(`[ws] new connection from ${req.socket.remoteAddress}`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(1003, "bad json"); }

    // ── Auth ──
    if (msg.type === "auth") {
      if (msg.key === API_KEY) {
        ws.isAuthed = true;
        ws.send(JSON.stringify({ type: "authOk" }));
        console.log("[ws] client authenticated");
      } else {
        ws.send(JSON.stringify({ type: "authFail" }));
        ws.close(1008, "unauthorized");
      }
      return;
    }

    if (!ws.isAuthed) return ws.close(1008, "not authenticated");

    // ── Subscribe ──
    if (msg.type === "subscribe" && msg.instanceId) {
      if (!wsSubscriptions.has(msg.instanceId))
        wsSubscriptions.set(msg.instanceId, new Set());
      wsSubscriptions.get(msg.instanceId).add(ws);
      ws.subscribedTo.add(msg.instanceId);

      // Send current state immediately
      ws.send(JSON.stringify({
        type:       "InitialSync",
        instanceId: msg.instanceId,
        players:    getServerPlayers(msg.instanceId),
      }));
      ws.send(JSON.stringify({ type: "subscribed", instanceId: msg.instanceId }));
    }

    // ── Unsubscribe ──
    if (msg.type === "unsubscribe" && msg.instanceId) {
      wsSubscriptions.get(msg.instanceId)?.delete(ws);
      ws.subscribedTo.delete(msg.instanceId);
    }

    // ── Ping/Pong ──
    if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });

  ws.on("close", () => {
    for (const id of ws.subscribedTo) wsSubscriptions.get(id)?.delete(ws);
    console.log("[ws] client disconnected");
  });

  // Server-side keepalive ping every 30 s
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(keepalive);
  }, 30_000);
});

// ─── HTTP Routes (used by Roblox — no native WS support) ─────────────────────

// POST /api/join
// Body: { userId, playerName, serverInstanceId, skins[] }
// Returns: { success, players[] } — players already on this instance
app.post("/api/join", authHttp, (req, res) => {
  const { userId, playerName, serverInstanceId, skins } = req.body;
  if (!userId || !playerName || !serverInstanceId)
    return res.status(400).json({ success: false, error: "Missing fields" });

  const srv = ensureServer(serverInstanceId);
  const uid = String(userId);
  const now = Date.now();

  const existingPlayers = getServerPlayers(serverInstanceId).filter(p => p.userId !== uid);

  srv.players[uid] = {
    name:     playerName,
    skins:    Array.isArray(skins) ? skins : [],
    joinedAt: now,
    lastSeen: now,
  };

  console.log(`[join] ${playerName} (${uid}) -> ${serverInstanceId}`);

  // Broadcast via WebSocket and unblock long-poll clients
  pushEvent(serverInstanceId, {
    type:       "PlayerJoined",
    userId:     uid,
    playerName: playerName,
    skins:      srv.players[uid].skins,
  });

  res.json({ success: true, players: existingPlayers });
});

// POST /api/leave
// Body: { userId, serverInstanceId }
app.post("/api/leave", authHttp, (req, res) => {
  const { userId, serverInstanceId } = req.body;
  if (!userId || !serverInstanceId)
    return res.status(400).json({ success: false, error: "Missing fields" });

  const uid = String(userId);
  const srv = servers[serverInstanceId];
  if (srv) {
    const name = srv.players[uid]?.name ?? "unknown";
    delete srv.players[uid];
    console.log(`[leave] ${name} (${uid}) <- ${serverInstanceId}`);

    pushEvent(serverInstanceId, { type: "PlayerLeft", userId: uid });

    if (!Object.keys(srv.players).length) {
      delete servers[serverInstanceId];
      console.log(`[server] ${serverInstanceId} removed (empty)`);
    }
  }

  res.json({ success: true });
});

// PUT /api/skins
// Body: { userId, serverInstanceId, skins[] }
app.put("/api/skins", authHttp, (req, res) => {
  const { userId, serverInstanceId, skins } = req.body;
  if (!userId || !serverInstanceId || !Array.isArray(skins))
    return res.status(400).json({ success: false, error: "Missing fields" });

  const player = servers[serverInstanceId]?.players[String(userId)];
  if (!player)
    return res.status(404).json({ success: false, error: "Player not found" });

  player.skins    = skins;
  player.lastSeen = Date.now();
  console.log(`[skins] ${player.name} updated on ${serverInstanceId}`);

  pushEvent(serverInstanceId, {
    type:   "SkinsUpdated",
    userId: String(userId),
    skins,
  });

  res.json({ success: true });
});

// POST /api/heartbeat
// Body: { userId, serverInstanceId }
app.post("/api/heartbeat", authHttp, (req, res) => {
  const player = servers[req.body.serverInstanceId]?.players[String(req.body.userId)];
  if (player) player.lastSeen = Date.now();
  res.json({ success: true });
});

// GET /api/events/:instanceId?timeout=25
//
// HTTP long-poll — Roblox equivalent of a WebSocket subscription.
// Hangs open until an event is pushed OR timeout expires.
// Returns: { success, events: [...] }
// Empty events array means timeout; client should reconnect immediately.
app.get("/api/events/:instanceId", authHttp, (req, res) => {
  const { instanceId } = req.params;
  const timeout = Math.min(parseInt(req.query.timeout) || 25, 28) * 1000;

  if (!longPollQueues.has(instanceId))
    longPollQueues.set(instanceId, new Set());

  let resolved = false;

  const resolve = (events) => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    longPollQueues.get(instanceId)?.delete(resolve);
    res.json({ success: true, events });
  };

  const timer = setTimeout(() => resolve([]), timeout);
  longPollQueues.get(instanceId).add(resolve);

  req.on("close", () => {
    resolved = true;
    clearTimeout(timer);
    longPollQueues.get(instanceId)?.delete(resolve);
  });
});

// GET /api/server/:instanceId/players — snapshot (no hanging)
app.get("/api/server/:instanceId/players", authHttp, (req, res) => {
  res.json({ success: true, players: getServerPlayers(req.params.instanceId) });
});

// GET /api/telemetry
app.get("/api/telemetry", authHttp, (req, res) => {
  let totalPlayers = 0;
  const serverStats = {};

  for (const [id, srv] of Object.entries(servers)) {
    const count = Object.keys(srv.players).length;
    totalPlayers += count;
    serverStats[id] = {
      playerCount:  count,
      wsSubscribers: wsSubscriptions.get(id)?.size ?? 0,
      longPollWaiters: longPollQueues.get(id)?.size ?? 0,
      players: Object.entries(srv.players).map(([uid, d]) => ({
        userId: uid, name: d.name,
        joinedAt: d.joinedAt, lastSeen: d.lastSeen, skinCount: d.skins.length,
      })),
    };
  }

  res.json({
    success:      true,
    totalPlayers,
    totalServers: Object.keys(servers).length,
    wsClients:    wss.clients.size,
    servers:      serverStats,
    timestamp:    new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// GET /health (no auth)
app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime() })
);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`SkinSync server on port ${PORT}`);
  console.log(`  HTTP API : http://localhost:${PORT}/api/`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
});
