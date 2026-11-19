'use strict';

const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const express = require('express');
const { Server } = require('socket.io');
const rooms = require('./rooms');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    ...rooms.stats(),
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Route inconnue.' });
});

const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  pingInterval: 20_000,
  pingTimeout: 20_000,
});

/* ------------------------------------------------------------------ */
/* Diffusion                                                           */
/* ------------------------------------------------------------------ */

function broadcast(room) {
  for (const player of room.players) {
    if (!player.connected || !player.socketId) continue;
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) socket.emit('state', rooms.snapshotFor(room, player));
  }
}

rooms.setHooks({
  notify: broadcast,
  removed: (room, reason) => {
    io.to(`room:${room.code}`).emit('room:closed', { reason });
  },
});

function context(socket) {
  const room = rooms.findRoomBySocket(socket.id);
  if (!room) throw new rooms.RoomError('Salon introuvable.');
  const player = room.players.find((p) => p.socketId === socket.id);
  if (!player) throw new rooms.RoomError('Joueur introuvable.');
  return { room, player };
}

function attach(socket, room, player) {
  const previous = socket.data.roomCode;
  if (previous && previous !== room.code) socket.leave(`room:${previous}`);
  socket.join(`room:${room.code}`);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
}

function respond(socket, ack, fn) {
  try {
    const result = fn();
    if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
  } catch (err) {
    if (err instanceof rooms.RoomError) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
      else socket.emit('app:error', { message: err.message });
      return;
    }
    console.error('[wahliquiz]', err);
    if (typeof ack === 'function') ack({ ok: false, error: 'Erreur interne, réessayez.' });
  }
}

/* ------------------------------------------------------------------ */
/* Événements Socket.io                                                */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  socket.on('room:create', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = rooms.createRoom({
        name: payload?.name,
        playerId: payload?.playerId,
        socketId: socket.id,
      });
      attach(socket, room, player);
      broadcast(room);
      return { code: room.code, playerId: player.id };
    });
  });

  socket.on('room:join', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = rooms.joinRoom({
        code: payload?.code,
        name: payload?.name,
        playerId: payload?.playerId,
        socketId: socket.id,
      });
      attach(socket, room, player);
      broadcast(room);
      return { code: room.code, playerId: player.id };
    });
  });

  socket.on('room:sync', () => {
    respond(socket, null, () => {
      const { room, player } = context(socket);
      socket.emit('state', rooms.snapshotFor(room, player));
      return {};
    });
  });

  socket.on('room:leave', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      const code = room.code;
      rooms.leaveRoom(room, player.id);
      socket.leave(`room:${code}`);
      socket.data.roomCode = null;
      return {};
    });
  });

  socket.on('room:config', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.updateConfig(room, player.id, payload || {});
      return {};
    });
  });

  socket.on('room:avatar', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.setPlayerEmoji(room, player.id, payload?.emoji);
      return {};
    });
  });

  socket.on('game:start', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.startGame(room, player.id);
      return {};
    });
  });

  socket.on('game:answer', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.submitAnswer(room, player.id, payload || {});
      return {};
    });
  });

  socket.on('review:vote', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.castVote(room, player.id, payload || {});
      return {};
    });
  });

  socket.on('review:next', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.skipReview(room, player.id);
      return {};
    });
  });

  socket.on('review:previous', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.previousReview(room, player.id);
      return {};
    });
  });

  socket.on('game:replay', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.replayGame(room, player.id);
      return {};
    });
  });

  socket.on('game:restart', (payload, ack) => {
    respond(socket, ack, () => {
      const { room, player } = context(socket);
      rooms.restartGame(room, player.id);
      return {};
    });
  });

  socket.on('disconnect', () => {
    rooms.handleDisconnect(socket.id);
  });
});

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  WahliQuiz est lancé');
  console.log(`  → http://localhost:${PORT}`);
  for (const address of localAddresses()) {
    console.log(`  → http://${address}:${PORT}  (réseau local / mobile)`);
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} reçu : fermeture du serveur.`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, io };
