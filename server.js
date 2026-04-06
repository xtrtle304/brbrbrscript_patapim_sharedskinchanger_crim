const WebSocket = require("ws");
const express = require("express");

const app = express();
const wss = new WebSocket.Server({ port: 3000 });

/*
Структура:
{
  ws,
  serverId,
  userId,
  skins: []
}
*/
let clients = [];

function broadcastToServer(serverId, data, excludeWs = null) {
  clients.forEach(client => {
    if (client.serverId === serverId && client.ws !== excludeWs) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

wss.on("connection", (ws) => {
  let clientData = null;

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    // 🔹 Регистрация игрока
    if (data.type === "register") {
      clientData = {
        ws,
        serverId: data.serverId,
        userId: data.userId,
        skins: data.skins || []
      };

      clients.push(clientData);

      // Отправляем текущих игроков сервера новому
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

      // Бродкаст входа
      broadcastToServer(data.serverId, {
        type: "player_join",
        userId: data.userId,
        skins: data.skins
      }, ws);
    }

    // 🔹 Обновление скинов
    if (data.type === "update_skins" && clientData) {
      clientData.skins = data.skins;

      broadcastToServer(clientData.serverId, {
        type: "update_skins",
        userId: clientData.userId,
        skins: data.skins
      }, ws);
    }
  });

  ws.on("close", () => {
    if (!clientData) return;

    clients = clients.filter(c => c.ws !== ws);

    broadcastToServer(clientData.serverId, {
      type: "player_leave",
      userId: clientData.userId
    });
  });
});

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

app.listen(8080, () => {
  console.log("HTTP telemetry on 8080");
});
