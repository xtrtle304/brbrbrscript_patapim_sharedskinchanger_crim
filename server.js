const WebSocket = require("ws");
const express = require("express");

const app = express();

// ✅ Railway порт
const PORT = process.env.PORT || 3000;

// HTTP сервер
const server = app.listen(PORT, () => {
  console.log("HTTP + WS server running on port", PORT);
});

// WebSocket сервер через HTTP
const wss = new WebSocket.Server({ server });

/*
Структура клиента:
{
  ws,
  serverId,
  userId,
  skins: []
}
*/
let clients = [];

// 📡 Бродкаст по серверу
function broadcastToServer(serverId, data, excludeWs = null) {
  clients.forEach(client => {
    if (client.serverId === serverId && client.ws !== excludeWs) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
      }
    }
  });
}

// 🔌 WebSocket подключение
wss.on("connection", (ws) => {
  console.log("New WS connection");

  let clientData = null;

  ws.on("message", (msg) => {
    let data;

    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.log("Invalid JSON");
      return;
    }

    // 🔹 Регистрация
    if (data.type === "register") {
      clientData = {
        ws,
        serverId: data.serverId,
        userId: data.userId,
        skins: data.skins || []
      };

      clients.push(clientData);

      console.log(`Player ${data.userId} joined server ${data.serverId}`);

      // 📤 Отправляем список игроков на сервере
      const players = clients
        .filter(c => c.serverId === data.serverId)
        .map(c => ({
          userId: c.userId,
          skins: c.skins
        }));

      ws.send(JSON.stringify({
        type: "init",
        players
      }));

      // 📡 Бродкаст входа
      broadcastToServer(data.serverId, {
        type: "player_join",
        userId: data.userId,
        skins: data.skins
      }, ws);
    }

    // 🔹 Обновление скинов
    if (data.type == "update_skins") {
        console.log(`update_skins: ${clientData.userId}`)
    }
    if (data.type === "update_skins" && clientData) {
      clientData.skins = data.skins;

      broadcastToServer(clientData.serverId, {
        type: "update_skins",
        userId: clientData.userId,
        skins: data.skins
      }, ws);
    }

    // 🔹 Pong (keep-alive)
    if (data.type === "pong") {
      ws.isAlive = true;
    }
  });

  ws.on("close", () => {
    console.log("WS disconnected");

    if (!clientData) return;

    clients = clients.filter(c => c.ws !== ws);

    broadcastToServer(clientData.serverId, {
      type: "player_leave",
      userId: clientData.userId
    });
  });

  ws.on("error", (err) => {
    console.error("WS ERROR:", err);
  });

  ws.isAlive = true;
});

// ❤️ Ping система (чтобы Railway не убивал соединение)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch (e) {
      console.log("Ping error:", e);
    }
  });
}, 20000);

// 📊 Телеметрия
app.get("/telemetry", (req, res) => {
  const total = clients.length;

  const perServer = {};
  clients.forEach(c => {
    perServer[c.serverId] = (perServer[c.serverId] || 0) + 1;
  });

  res.json({
    totalPlayers: total,
    servers: perServer
  });
});

// 🧨 Ловим краши
process.on("uncaughtException", (err) => {
  console.error("CRASH:", err);
});
