import 'dotenv/config';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { EVENTS, ROOM_STATES } from '../shared/events.js';
import { PLAYER } from '../shared/gameConfig.js';
import { DEFAULT_GAME_SERVER_HOST, DEFAULT_GAME_SERVER_PORT } from '../shared/deployment.js';
import { GameState } from './gameState.js';
import { PlayerProfileStore } from './profiles.js';
import { ROOM_RECONNECT_GRACE_MS, RoomManager } from './rooms.js';
import { ALLOWED_ORIGIN, socketCorsOptions } from './origins.js';

// Fixed 20 Hz simulation and state broadcast. The server derives its own delta
// time and caps long pauses so clients can never supply movement speed or dt.
const TICK_RATE_MS = 50;

/**
 * Build the Express app, HTTP server, and Socket.IO instance without binding a
 * port. Exported so deployment/integration tests can boot the real server on an
 * ephemeral port and shut the simulation timer down again.
 */
export function createGameServer(options = {}) {
  const profileStore = options.profileStore ?? new PlayerProfileStore(options.profileStorePath);
  const app = express();
  app.disable('x-powered-by');

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: socketCorsOptions(),
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 16_384,
    connectionStateRecovery: {
      maxDisconnectionDuration: ROOM_RECONNECT_GRACE_MS,
      skipMiddlewares: true,
    },
  });
  const roomManager = new RoomManager(io, profileStore);

  // Health check for host supervisors (Railway/Render) and for `curl` checks when
  // a player reports CONNECTION LOST. Registered after `roomManager` exists so it
  // cannot observe an uninitialized binding. `uptime` and the socket counts tell
  // you whether the process is merely awake or actually holding connections.
  // The CORS header matters: the client probes this endpoint from the browser to
  // tell "the server is down" apart from "the client is aimed at the wrong host",
  // and an opaque response would make a live server look dead.
  app.get('/health', (_request, response) => {
    response.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    response.set('Cache-Control', 'no-store');
    response.status(200).json({
      status: 'ok',
      service: 'fps-gods-game-server',
      uptime: process.uptime(),
      rooms: roomManager.rooms.size,
      connections: io.engine.clientsCount,
      now: Date.now(),
    });
  });

  function launchRoom(room) {
    const now = Date.now();
    room.game = new GameState(room, {
      emitRoom: (event, data) => io.to(room.code).emit(event, data),
      emitPlayer: (playerId, event, data) => io.to(playerId).emit(event, data),
      onHumanKill: (player) => profileStore.recordLifetimeKill(player.profileId),
    }, now);
    io.to(room.code).emit(EVENTS.GAME_START, {
      code: room.code,
      mode: room.mode,
      targetKills: PLAYER.targetKills,
      playerCount: room.game.players.size,
    });
    roomManager.broadcastRoomState(room);
  }

  // Socket handlers validate room membership before any input can reach a game.
  io.on('connection', (socket) => {
    if (socket.recovered && socket.data.roomCode && !roomManager.recoverSocket(socket)) {
      socket.emit(EVENTS.ROOM_RESUME_FAILED, { message: 'That room session has expired. Join the room again with its code.' });
    }

    socket.on(EVENTS.ROOM_RESUME, (payload = {}) => {
      roomManager.resumeRoom(socket, payload);
    });

    socket.on(EVENTS.LEAVE_ROOM, () => {
      roomManager.leaveRoom(socket);
    });

    socket.on(EVENTS.PROFILE_REQUEST, (payload = {}) => {
      const profile = profileStore.getOrCreate(payload.profileId, payload.callsign ?? payload.name);
      socket.data.profileId = profile.profileId;
      socket.emit(EVENTS.PROFILE_UPDATE, profile);
    });

    socket.on(EVENTS.CREATE_ROOM, (payload = {}) => {
      roomManager.createRoom(socket, payload.name, payload);
    });

    socket.on(EVENTS.JOIN_ROOM, (payload = {}) => {
      roomManager.joinRoom(socket, payload.code, payload.name, payload);
    });

    socket.on(EVENTS.PLAYER_READY, (payload = {}) => {
      roomManager.setReady(socket, payload.ready);
    });

    socket.on(EVENTS.START_GAME, () => {
      const result = roomManager.startGame(socket);
      if (result.error) {
        roomManager.emitError(socket, result.error);
        return;
      }

      launchRoom(result.room);
    });

    socket.on(EVENTS.PLAY_NOW, (payload = {}) => {
      const room = roomManager.createSoloBotsRoom(socket, payload.name, payload);
      if (room) launchRoom(room);
    });

    socket.on(EVENTS.PLAYER_INPUT, (payload) => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.setInput(socket.id, payload, Date.now());
    });

    socket.on(EVENTS.SHOOT, () => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.shoot(socket.id, Date.now());
    });

    socket.on(EVENTS.PLAYER_RELOAD, () => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.reload(socket.id, Date.now());
    });

    socket.on(EVENTS.WEAPON_SWITCH, (payload = {}) => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.switchWeapon(socket.id, payload.weaponId, Date.now());
    });

    socket.on(EVENTS.RETURN_TO_LOBBY, () => {
      roomManager.returnToLobby(socket);
    });

    // Solo bot rooms cannot use the shared lobby (they never have a second
    // human), so their end screen requests a fresh authoritative match instead.
    socket.on(EVENTS.PLAY_AGAIN, () => {
      const result = roomManager.restartSoloMatch(socket);
      if (result.error) {
        roomManager.emitError(socket, result.error);
        return;
      }
      launchRoom(result.room);
    });

    socket.on('disconnect', () => {
      roomManager.handleDisconnect(socket);
    });
  });

  let lastTick = Date.now();
  let lastRoomCleanup = 0;
  const simulationTimer = setInterval(() => {
    const now = Date.now();
    const delta = Math.min((now - lastTick) / 1_000, 0.1);
    lastTick = now;
    if (now - lastRoomCleanup >= 1_000) {
      roomManager.expireDisconnectedPlayers(now);
      lastRoomCleanup = now;
    }

    for (const room of roomManager.rooms.values()) {
      if (room.state !== ROOM_STATES.PLAYING || !room.game) continue;
      const result = room.game.update(delta, now);
      if (result?.winner) {
        roomManager.endGame(room, result.winner);
        continue;
      }
      io.to(room.code).volatile.emit(EVENTS.GAME_STATE_UPDATE, room.game.getPublicState(now));
    }
  }, TICK_RATE_MS);

  /** Stop the simulation loop and close every socket. Resolves when shut down. */
  function close() {
    clearInterval(simulationTimer);
    return new Promise((resolve) => {
      io.close(() => resolve());
      setTimeout(resolve, 2_000).unref();
    });
  }

  return { app, httpServer, io, roomManager, close };
}

/** Bind the game server to HOST/PORT and install signal-based shutdown. */
export function startGameServer() {
  const server = createGameServer();
  // Number() matters: hosts inject PORT as a string, and a string passed to
  // listen() is interpreted as a named pipe. The fallback below is a local-dev
  // default ONLY - Railway/Render always set PORT (Railway's is commonly 8080),
  // so this value never decides the production port and must not be edited as a
  // fix for a host routing problem. See shared/deployment.js.
  //
  // 38ec5ac set this to a literal 3000 on main; that intent is preserved here by
  // DEFAULT_GAME_SERVER_PORT, which is also what Vite's dev proxy now derives its
  // target from, so the two can no longer be edited apart.
  const port = Number(process.env.PORT) || DEFAULT_GAME_SERVER_PORT;
  const host = process.env.HOST || DEFAULT_GAME_SERVER_HOST;

  server.httpServer.listen(port, host, () => {
    console.log(`FPS GODS server listening on http://${host}:${server.httpServer.address().port}`);
  });

  // Let container/process managers stop the timer and socket connections cleanly.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Only bind a port when this file is the process entrypoint, so importing it in
// tests does not start a second server or leak signal handlers.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) startGameServer();
