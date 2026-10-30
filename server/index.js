import 'dotenv/config';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { PLAYER } from '../shared/gameConfig.js';
import { DEFAULT_GAME_SERVER_HOST, DEFAULT_GAME_SERVER_PORT } from '../shared/deployment.js';
import { GameDatabase } from './database.js';
import { EconomyService } from './economy.js';
import { createEmailProvider } from './emailProvider.js';
import {
  AuthService,
  buildClearSessionCookie,
  buildSessionCookie,
  extractRequestSessionToken,
  extractSocketSessionToken,
} from './auth.js';
import { GameState } from './gameState.js';
import { PlayerProfileStore } from './profiles.js';
import { ROOM_RECONNECT_GRACE_MS, RoomManager } from './rooms.js';
import { isCredentialOriginAllowed, socketCorsOptions } from './origins.js';

process.on('uncaughtException', (error) => {
  console.error('[FPS GODS] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FPS GODS] Unhandled rejection at:', promise, 'reason:', reason);
});

// Fixed 20 Hz simulation and state broadcast.
const TICK_RATE_MS = 50;

function resolveClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  return process.env.NODE_ENV === 'production';
}

/**
 * Build the Express app, HTTP server, and Socket.IO instance without binding a
 * port. Exported so deployment/integration tests can boot the real server on an
 * ephemeral port and shut the simulation timer + database down cleanly.
 */
export function createGameServer(options = {}) {
  const ownsDatabase = !options.database;
  const database = options.database ?? new GameDatabase({ dbPath: options.dbPath });
  const emailProvider = createEmailProvider(options.emailProvider);
  const authService = new AuthService(database, emailProvider, options.authOptions);
  const economyService = new EconomyService(database);
  const profileStore = options.profileStore ?? new PlayerProfileStore(options.profileStorePath, authService);

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.path === '/health') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }
    res.vary('Origin');
    if (isCredentialOriginAllowed(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
    } else if (origin && req.path.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      return res.status(403).json({ ok: false, code: 'ORIGIN_FORBIDDEN' });
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  app.use('/api', express.json({ limit: '16kb' }));

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

  // Track connected sockets by verified accountId so wallet awards push live to
  // every active tab/session owned by that authenticated player.
  const accountSockets = new Map();
  function bindSocketAccount(socket, nextAccountId) {
    const prevAccountId = socket.data.accountId ?? null;
    if (prevAccountId && prevAccountId !== nextAccountId) {
      const prevSet = accountSockets.get(prevAccountId);
      if (prevSet) {
        prevSet.delete(socket.id);
        if (prevSet.size === 0) accountSockets.delete(prevAccountId);
      }
    }
    socket.data.accountId = nextAccountId || null;
    if (nextAccountId) {
      let set = accountSockets.get(nextAccountId);
      if (!set) {
        set = new Set();
        accountSockets.set(nextAccountId, set);
      }
      set.add(socket.id);
    }
  }

  function unbindSocketAccount(socket) {
    clearTimeout(socket.sessionExpiryTimer);
    socket.sessionExpiryTimer = null;
    const prevAccountId = socket.data.accountId ?? null;
    if (!prevAccountId) return;
    const set = accountSockets.get(prevAccountId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) accountSockets.delete(prevAccountId);
    }
    socket.data.accountId = null;
    socket.data.sessionId = null;
  }

  function bindSocketSession(socket, session) {
    bindSocketAccount(socket, session.accountId);
    socket.data.sessionId = session.sessionId;
    clearTimeout(socket.sessionExpiryTimer);
    const expire = () => {
      const remaining = session.expiresAt - Date.now();
      if (remaining > 0) {
        socket.sessionExpiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
        socket.sessionExpiryTimer.unref();
        return;
      }
      unbindSocketAccount(socket);
      socket.data.profileId = undefined;
      socket.emit(EVENTS.WALLET_UPDATE, { accountId: null, authenticated: false, balance: 0, recentTransactions: [] });
    };
    expire();
  }

  function emitWalletToAccount(accountId, rewardEvent = null) {
    if (!accountId) return;
    const socketIds = accountSockets.get(accountId);
    if (!socketIds || socketIds.size === 0) return;
    const wallet = economyService.getWallet(accountId, { historyLimit: 12 });
    if (!wallet) return;
    for (const sid of socketIds) {
      if (rewardEvent) {
        io.to(sid).emit(EVENTS.REWARD_EARNED, rewardEvent);
      }
      io.to(sid).emit(EVENTS.WALLET_UPDATE, wallet);
    }
  }

  const tickDeltasMs = [];
  function recordTickDelta(ms) {
    tickDeltasMs.push(ms);
    if (tickDeltasMs.length > 100) tickDeltasMs.shift();
  }

  app.get('/health', (_request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Cache-Control', 'no-store');
    const avgTickMs = tickDeltasMs.length
      ? +(tickDeltasMs.reduce((a, b) => a + b, 0) / tickDeltasMs.length).toFixed(2)
      : TICK_RATE_MS;
    const maxTickMs = tickDeltasMs.length ? +Math.max(...tickDeltasMs).toFixed(2) : TICK_RATE_MS;
    response.status(200).json({
      status: 'ok',
      service: 'fps-gods-game-server',
      nodeVersion: process.versions.node,
      uptime: process.uptime(),
      rooms: roomManager.rooms.size,
      connections: io.engine.clientsCount,
      tickRateHz: 1000 / TICK_RATE_MS,
      avgTickMs,
      maxTickMs,
      authConfigured: emailProvider.configured,
      persistence: database.getPersistenceSummary(),
      now: Date.now(),
    });
  });

  app.get('/', (_request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Cache-Control', 'no-store');
    response.status(200).json({
      status: 'ok',
      service: 'fps-gods-game-server',
      health: '/health',
    });
  });

  // --- Phase 5 & Phase 6 HTTP API (Email OTP Auth + Durable Accounts + Wallet) ---

  app.get('/api/auth/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      ...authService.getStatus(),
    });
  });

  app.post('/api/auth/otp/request', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await authService.requestOtp({
        email: req.body?.email,
        ip: resolveClientIp(req),
      });
      res.status(200).json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (error?.retryAfterSeconds) {
        res.set('Retry-After', String(error.retryAfterSeconds));
      }
      res.status(status).json({
        ok: false,
        code: error?.code || 'AUTH_REQUEST_ERROR',
        message: status >= 500 && status !== 503 && status !== 502
          ? 'Unable to process verification request.'
          : error.message,
        ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    }
  });

  app.post('/api/auth/otp/verify', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const verified = authService.verifyOtp({
        email: req.body?.email,
        code: req.body?.code,
        callsign: req.body?.callsign,
        selectedBundle: req.body?.selectedBundle,
        ip: resolveClientIp(req),
        userAgent: req.headers['user-agent'] || '',
      });
      res.set('Set-Cookie', buildSessionCookie(verified.sessionToken, {
        maxAgeSeconds: verified.maxAgeSeconds,
        secure: isSecureRequest(req),
      }));
      const wallet = economyService.getWallet(verified.account.accountId, { historyLimit: 12 });
      res.status(200).json({
        ok: true,
        isNewAccount: verified.isNewAccount,
        expiresAt: verified.sessionExpiresAt,
        account: verified.account,
        wallet,
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (error?.retryAfterSeconds) {
        res.set('Retry-After', String(error.retryAfterSeconds));
      }
      res.status(status).json({
        ok: false,
        code: error?.code || 'AUTH_VERIFY_ERROR',
        message: status >= 500 ? 'Unable to verify code right now.' : error.message,
        ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = extractRequestSessionToken(req);
    const session = token ? authService.verifySessionToken(token) : null;
    if (!session) {
      res.status(200).json({
        ok: true,
        authenticated: false,
        account: null,
        wallet: null,
        status: authService.getStatus(),
      });
      return;
    }
    const wallet = economyService.getWallet(session.accountId, { historyLimit: 12 });
    res.status(200).json({
      ok: true,
      authenticated: true,
      account: session.account,
      wallet,
      status: authService.getStatus(),
    });
  });

  app.post('/api/auth/profile', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = extractRequestSessionToken(req);
    const session = token ? authService.verifySessionToken(token) : null;
    if (!session) {
      res.status(401).json({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Sign in with Email OTP to update persistent account settings.',
      });
      return;
    }
    const updated = authService.updateAccountProfile(session.accountId, {
      callsign: req.body?.callsign,
      selectedBundle: req.body?.selectedBundle,
    });
    res.status(200).json({
      ok: true,
      account: updated,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = extractRequestSessionToken(req);
    const session = token ? authService.verifySessionToken(token) : null;
    if (token) authService.logout(token);
    if (session) {
      for (const id of [...(accountSockets.get(session.accountId) || [])]) {
        const socket = io.sockets.sockets.get(id);
        if (socket?.data.sessionId === session.sessionId) {
          unbindSocketAccount(socket);
          socket.data.profileId = undefined;
          socket.emit(EVENTS.WALLET_UPDATE, { accountId: null, authenticated: false, balance: 0, recentTransactions: [] });
        }
      }
    }
    res.set('Set-Cookie', buildClearSessionCookie({ secure: isSecureRequest(req) }));
    res.status(200).json({ ok: true });
  });

  app.get('/api/wallet', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = extractRequestSessionToken(req);
    const session = token ? authService.verifySessionToken(token) : null;
    if (!session) {
      res.status(401).json({
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Sign in to view your persistent Credits wallet.',
      });
      return;
    }
    const wallet = economyService.getWallet(session.accountId, { historyLimit: 20 });
    res.status(200).json({
      ok: true,
      wallet,
    });
  });

  function launchRoom(room) {
    const now = Date.now();
    room.game = new GameState(room, {
      emitRoom: (event, data) => io.to(room.code).emit(event, data),
      emitPlayer: (playerId, event, data) => io.to(playerId).emit(event, data),
      onHumanKill: (player) => profileStore.recordLifetimeKill(player.profileId, player.accountId),
      onElimination: ({
        matchId,
        killSeq,
        killer,
        victim,
        assisters,
        headshot,
        isSoloBots,
        now: eventNow,
      }) => {
        if (killer && !killer.isBot && killer.accountId) {
          const victimIdentity = victim?.isBot
            ? `bot:${victim.name}`
            : (victim?.accountId || victim?.profileId || victim?.id);
          const killReward = economyService.awardElimination({
            killerAccountId: killer.accountId,
            victimIdentity,
            isSoloBots,
            headshot,
            matchId,
            killSeq,
            now: eventNow,
          });
          if (killReward?.awarded) {
            emitWalletToAccount(killer.accountId, {
              amount: killReward.amount,
              balance: killReward.balance,
              reason: killReward.reason,
              headshot: Boolean(headshot),
            });
          }
        }
        for (const assister of assisters ?? []) {
          if (!assister?.accountId) continue;
          const assistReward = economyService.awardAssist({
            assisterAccountId: assister.accountId,
            killerAccountId: killer?.accountId ?? null,
            matchId,
            killSeq,
            now: eventNow,
          });
          if (assistReward?.awarded) {
            emitWalletToAccount(assister.accountId, {
              amount: assistReward.amount,
              balance: assistReward.balance,
              reason: assistReward.reason,
            });
          }
        }
      },
      onMatchFinished: ({
        matchId,
        winner,
        players,
        isSoloBots,
        now: eventNow,
      }) => {
        const winnerAccountId = winner && !winner.isBot ? (winner.accountId ?? null) : null;
        const summaryRewards = economyService.awardMatchSummary({
          matchId,
          winnerAccountId,
          participants: players,
          isSoloBots,
          now: eventNow,
        });
        for (const reward of summaryRewards) {
          emitWalletToAccount(reward.accountId, {
            amount: reward.amount,
            balance: reward.balance,
            reason: reward.reason,
          });
        }
      },
    }, now);
    io.to(room.code).emit(EVENTS.GAME_START, {
      code: room.code,
      mode: room.mode,
      mapId: room.game.mapId,
      mapName: room.game.map.name,
      botDifficulty: room.mode === ROOM_MODES.SOLO_VS_BOTS ? room.game.botDifficulty : null,
      targetKills: PLAYER.targetKills,
      playerCount: room.game.players.size,
    });
    roomManager.broadcastRoomState(room);
    // Push the initial authoritative snapshot immediately on launch so high-RTT
    // clients can move on frame 0 without waiting up to 50ms for the next tick.
    io.to(room.code).emit(EVENTS.GAME_STATE_UPDATE, room.game.getPublicState(now));
  }

  io.on('connection', (socket) => {
    const socketOrigin = socket.handshake.headers.origin;
    const initialToken = !socketOrigin || isCredentialOriginAllowed(socketOrigin)
      ? extractSocketSessionToken(socket) : null;
    const initialSession = initialToken ? authService.verifySessionToken(initialToken) : null;
    if (initialSession) {
      bindSocketSession(socket, initialSession);
      socket.data.profileId = initialSession.accountId;
      const profile = profileStore.getOrCreate(initialSession.accountId, '', initialSession.accountId);
      if (profile) socket.emit(EVENTS.PROFILE_UPDATE, profile);
      const wallet = economyService.getWallet(initialSession.accountId, { historyLimit: 12 });
      if (wallet) socket.emit(EVENTS.WALLET_UPDATE, wallet);
    } else {
      unbindSocketAccount(socket);
      socket.data.profileId = undefined;
    }

    if (socket.recovered && socket.data.roomCode && !roomManager.recoverSocket(socket)) {
      socket.emit(EVENTS.ROOM_RESUME_FAILED, { message: 'That room session has expired. Join the room again with its code.' });
    }

    socket.on(EVENTS.NET_PING, (payload = {}) => {
      socket.volatile.emit(EVENTS.NET_PONG, { pingId: payload?.pingId });
    });

    socket.on(EVENTS.AUTH_SYNC, (payload = {}) => {
      const candidateToken = typeof payload?.sessionToken === 'string' ? payload.sessionToken.trim() : null;
      const verified = candidateToken ? authService.verifySessionToken(candidateToken) : null;
      if (verified) {
        bindSocketSession(socket, verified);
        socket.data.profileId = verified.accountId;
        const profile = profileStore.getOrCreate(verified.accountId, '', verified.accountId);
        if (profile) socket.emit(EVENTS.PROFILE_UPDATE, profile);
        const wallet = economyService.getWallet(verified.accountId, { historyLimit: 12 });
        if (wallet) socket.emit(EVENTS.WALLET_UPDATE, wallet);
      } else {
        unbindSocketAccount(socket);
        if (typeof socket.data.profileId === 'string' && socket.data.profileId.startsWith('acct_')) {
          socket.data.profileId = undefined;
        }
        socket.emit(EVENTS.WALLET_UPDATE, { accountId: null, authenticated: false, balance: 0, recentTransactions: [] });
      }
    });

    socket.on(EVENTS.ROOM_RESUME, (payload = {}) => {
      roomManager.resumeRoom(socket, payload);
    });

    socket.on(EVENTS.LEAVE_ROOM, () => {
      roomManager.leaveRoom(socket);
    });

    socket.on(EVENTS.PROFILE_REQUEST, (payload = {}) => {
      const verifiedAccountId = socket.data.accountId ?? null;
      const profile = profileStore.getOrCreate(
        verifiedAccountId ?? payload.profileId,
        payload.callsign ?? payload.name,
        verifiedAccountId,
      );
      socket.data.profileId = profile.profileId;
      socket.emit(EVENTS.PROFILE_UPDATE, profile);
    });

    socket.on(EVENTS.CREATE_ROOM, (payload = {}) => {
      roomManager.createRoom(socket, payload.name, payload);
    });

    socket.on(EVENTS.JOIN_ROOM, (payload = {}) => {
      roomManager.joinRoom(socket, payload.code, payload.name, payload);
    });

    socket.on(EVENTS.SET_ROOM_MAP, (payload = {}) => {
      roomManager.setRoomMap(socket, payload.mapId);
    });

    socket.on(EVENTS.SET_BOT_DIFFICULTY, (payload = {}) => {
      roomManager.setBotDifficulty(socket, payload?.botDifficulty, Date.now());
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

    socket.on(EVENTS.LIST_ROOMS, () => {
      const now = Date.now();
      if (now - (socket.data.lastRoomListAt ?? 0) < 500) return;
      socket.data.lastRoomListAt = now;
      socket.emit(EVENTS.ROOM_LIST, { rooms: roomManager.listRooms(now), now });
    });

    socket.on(EVENTS.PLAYER_INPUT, (payload) => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.setInput(socket.id, payload, Date.now());
    });

    socket.on(EVENTS.SHOOT, (payload) => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.shoot(socket.id, Date.now(), payload?.shotId);
    });

    socket.on(EVENTS.PLAYER_RELOAD, () => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.reload(socket.id, Date.now());
    });

    socket.on(EVENTS.WEAPON_SWITCH, (payload = {}) => {
      const room = roomManager.getRoomForSocket(socket);
      if (room?.state === ROOM_STATES.PLAYING) room.game?.switchWeapon(socket.id, payload?.weaponId, Date.now());
    });

    socket.on(EVENTS.RETURN_TO_LOBBY, () => {
      roomManager.returnToLobby(socket);
    });

    socket.on(EVENTS.PLAY_AGAIN, (payload = {}) => {
      const result = roomManager.restartSoloMatch(socket, payload);
      if (result.error) {
        roomManager.emitError(socket, result.error);
        return;
      }
      launchRoom(result.room);
    });

    socket.on('disconnect', () => {
      unbindSocketAccount(socket);
      roomManager.handleDisconnect(socket);
    });
  });

  let lastTick = Date.now();
  let lastRoomCleanup = 0;
  const failingRooms = new Map();
  const pendingSnapshots = new Map();
  const simulationTimer = setInterval(() => {
    const now = Date.now();
    const rawDeltaMs = Math.max(0, now - lastTick);
    recordTickDelta(rawDeltaMs);
    const delta = Math.min(rawDeltaMs / 1_000, 0.1);
    lastTick = now;
    if (now - lastRoomCleanup >= 1_000) {
      roomManager.expireDisconnectedPlayers(now);
      lastRoomCleanup = now;
    }

    for (const room of roomManager.rooms.values()) {
      if (room.state !== ROOM_STATES.PLAYING || !room.game) continue;
      try {
        const result = room.game.update(delta, now);
        if (result?.winner) {
          roomManager.endGame(room, result.winner);
          continue;
        }
        const game = room.game;
        const snapshot = game.getPublicState(now);
        const pending = pendingSnapshots.get(room.code);
        if (pending) {
          pending.snapshot = snapshot;
          pending.game = game;
        } else {
          const entry = { snapshot, game };
          pendingSnapshots.set(room.code, entry);
          setImmediate(() => {
            pendingSnapshots.delete(room.code);
            if (room.state === ROOM_STATES.PLAYING && room.game === entry.game) {
              io.to(room.code).volatile.emit(EVENTS.GAME_STATE_UPDATE, entry.snapshot);
            }
          });
        }
        failingRooms.delete(room.code);
      } catch (error) {
        const strikes = (failingRooms.get(room.code) ?? 0) + 1;
        failingRooms.set(room.code, strikes);
        console.error(`[FPS GODS] room ${room.code} tick ${strikes} failed:`, error);
        if (strikes >= 2) {
          failingRooms.delete(room.code);
          room.state = ROOM_STATES.ENDED;
          io.to(room.code).emit(EVENTS.GAME_END, {
            code: room.code,
            mode: room.mode,
            winner: null,
            scoreboard: room.game?.getScoreboard?.() ?? [],
            reason: 'The match was stopped after a server-side error.',
          });
          roomManager.broadcastRoomState(room);
        }
      }
    }
  }, TICK_RATE_MS);

  /** Stop the simulation loop, close sockets, and close owned SQLite connection. */
  function close() {
    clearInterval(simulationTimer);
    return new Promise((resolve) => {
      const finalize = () => {
        if (ownsDatabase) database.close();
        resolve();
      };
      io.close(() => finalize());
      setTimeout(finalize, 2_000).unref();
    });
  }

  return {
    app,
    httpServer,
    io,
    roomManager,
    database,
    authService,
    economyService,
    profileStore,
    close,
  };
}

/** Bind the game server to HOST/PORT and install signal-based shutdown. */
export function startGameServer() {
  const server = createGameServer();
  const port = Number(process.env.PORT) || DEFAULT_GAME_SERVER_PORT;
  const host = process.env.HOST || DEFAULT_GAME_SERVER_HOST;

  server.httpServer.once('error', (error) => {
    const hint = error.code === 'EADDRINUSE'
      ? `port ${port} is already in use`
      : error.code === 'EACCES'
        ? `no permission to bind ${port}; privileged ports need a capability, not a fallback port`
        : 'bind failed';
    console.error(`[FPS GODS] cannot listen on ${host}:${port} (${hint})`, error);
    process.exitCode = 1;
    process.exit(1);
  });

  server.httpServer.listen(port, host, () => {
    const persistence = server.database.getPersistenceSummary();
    console.log(
      `FPS GODS server listening on http://${host}:${server.httpServer.address().port} `
      + `(Node v${process.versions.node}, sqlite: ${persistence.mode})`,
    );
  });

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

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) startGameServer();
