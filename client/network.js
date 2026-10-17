import { io } from 'socket.io-client';
import { EVENTS } from '../shared/events.js';

// How often the HUD-driven retry loop nudges a dead socket. Matches the
// "auto-retry every 3 seconds" contract of the connection indicator.
export const RETRY_INTERVAL_MS = 3_000;

function logError(scope, error) {
  console.error(`[FPS GODS] ${scope}:`, error?.message ?? error);
}

// Thin Socket.IO adapter: gameplay decisions never happen here, only inputs go
// up and authoritative room/game snapshots and feedback come back down.
export class GameNetwork {
  constructor(handlers = {}) {
    this.handlers = handlers;

    // 1. VITE_SOCKET_URL is the canonical game-server origin (Railway/Render).
    // 2. If the build has no VITE_SOCKET_URL, fall back to window.location.origin
    //    so same-origin/reverse-proxy deployments (and localhost) just work
    //    instead of throwing "CONNECTION LOST" against a static host.
    const configuredUrl = import.meta.env.VITE_SOCKET_URL?.trim();
    const fallbackUrl = typeof window !== 'undefined' ? window.location.origin : undefined;
    const serverUrl = configuredUrl || fallbackUrl;

    this.serverUrl = serverUrl ?? null;
    this.usingFallbackUrl = !configuredUrl;
    if (import.meta.env.PROD && this.usingFallbackUrl) {
      console.warn(
        '[FPS GODS] VITE_SOCKET_URL is not set; connecting to window.location.origin '
        + `(${serverUrl}). Set VITE_SOCKET_URL if the game server lives elsewhere.`,
      );
    }

    this.socket = io(serverUrl, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: RETRY_INTERVAL_MS,
      reconnectionDelayMax: RETRY_INTERVAL_MS,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
    });

    // Belt-and-braces retry: even if socket.io's reconnection gives up or the
    // browser dropped the socket while the laptop slept, nudge it every 3 s.
    this.retryTimer = setInterval(() => {
      if (!this.socket.connected && !this.socket.active) {
        console.warn('[FPS GODS] Connection lost — retrying…');
        this.socket.connect();
      }
    }, RETRY_INTERVAL_MS);

    this.socket.on('connect', () => {
      console.info('[FPS GODS] Connected to game server.', this.socket.id);
      this.handlers.onConnect?.(this.socket.id);
    });
    this.socket.on('disconnect', (reason) => {
      console.warn('[FPS GODS] Disconnected from game server:', reason);
      this.handlers.onDisconnect?.(reason);
    });
    this.socket.on('connect_error', (error) => {
      logError('Connection error', error);
      this.handlers.onConnectionError?.(error);
    });

    this.socket.on(EVENTS.ROOM_STATE, (state) => this.handlers.onRoomState?.(state));
    this.socket.on(EVENTS.ROOM_ERROR, (error) => {
      logError('Room error', error?.message);
      this.handlers.onRoomError?.(error);
    });
    this.socket.on(EVENTS.GAME_START, (data) => this.handlers.onGameStart?.(data));
    this.socket.on(EVENTS.GAME_STATE_UPDATE, (state) => this.handlers.onGameState?.(state));
    this.socket.on(EVENTS.GAME_END, (data) => this.handlers.onGameEnd?.(data));
    this.socket.on(EVENTS.RETURN_TO_LOBBY, (data) => this.handlers.onReturnToLobby?.(data));
    this.socket.on(EVENTS.PLAYER_DIED, (data) => this.handlers.onPlayerDied?.(data));
    this.socket.on(EVENTS.PLAYER_RESPAWNED, (data) => this.handlers.onPlayerRespawned?.(data));
    this.socket.on(EVENTS.KILL_FEED_UPDATE, (data) => this.handlers.onKillFeed?.(data));
    this.socket.on(EVENTS.SCORE_UPDATE, (data) => this.handlers.onScoreUpdate?.(data));
    this.socket.on(EVENTS.HIT_CONFIRMED, (data) => this.handlers.onHitConfirmed?.(data));
    this.socket.on(EVENTS.AMMO_UPDATE, (data) => this.handlers.onAmmoUpdate?.(data));
    this.socket.on(EVENTS.HEALTH_UPDATE, (data) => this.handlers.onHealthUpdate?.(data));
    this.socket.on(EVENTS.SWITCH_WEAPON, (data) => this.handlers.onWeaponSwitched?.(data));
  }

  get id() {
    return this.socket.id ?? null;
  }

  get connected() {
    return this.socket.connected;
  }

  identity(extra = {}) {
    return {
      name: extra.name,
      bundle: extra.bundle,
      lifetimeKills: extra.lifetimeKills ?? 0,
    };
  }

  createRoom(name, bundle, lifetimeKills) {
    this.socket.emit(EVENTS.CREATE_ROOM, this.identity({ name, bundle, lifetimeKills }));
  }

  joinRoom(code, name, bundle, lifetimeKills) {
    this.socket.emit(EVENTS.JOIN_ROOM, { ...this.identity({ name, bundle, lifetimeKills }), code });
  }

  playSolo(name, bundle, lifetimeKills) {
    this.socket.emit(EVENTS.PLAY_SOLO, this.identity({ name, bundle, lifetimeKills }));
  }

  setReady(ready) {
    this.socket.emit(EVENTS.PLAYER_READY, { ready: Boolean(ready) });
  }

  startGame() {
    this.socket.emit(EVENTS.START_GAME);
  }

  sendInput(input) {
    this.socket.emit(EVENTS.PLAYER_INPUT, input);
  }

  shoot() {
    this.socket.emit(EVENTS.SHOOT);
  }

  reload() {
    this.socket.emit(EVENTS.PLAYER_RELOAD);
  }

  switchWeapon(slot) {
    this.socket.emit(EVENTS.SWITCH_WEAPON, { slot });
  }

  returnToLobby() {
    this.socket.emit(EVENTS.RETURN_TO_LOBBY);
  }

  disconnect() {
    clearInterval(this.retryTimer);
    this.socket.disconnect();
  }
}
