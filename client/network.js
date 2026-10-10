import { io } from 'socket.io-client';
import { EVENTS } from '../shared/events.js';

// Thin Socket.IO adapter: gameplay decisions never happen here, only inputs go
// up and authoritative room/game snapshots and feedback come back down.
export class GameNetwork {
  constructor(handlers = {}) {
    this.handlers = handlers;
    const configuredUrl = import.meta.env.VITE_SOCKET_URL?.trim();
    this.socket = io(configuredUrl || undefined, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    });

    this.socket.on('connect', () => this.handlers.onConnect?.(this.socket.id));
    this.socket.on('disconnect', (reason) => this.handlers.onDisconnect?.(reason));
    this.socket.on('connect_error', (error) => this.handlers.onConnectionError?.(error));

    this.socket.on(EVENTS.ROOM_STATE, (state) => this.handlers.onRoomState?.(state));
    this.socket.on(EVENTS.ROOM_ERROR, (error) => this.handlers.onRoomError?.(error));
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
  }

  get id() {
    return this.socket.id ?? null;
  }

  get connected() {
    return this.socket.connected;
  }

  createRoom(name) {
    this.socket.emit(EVENTS.CREATE_ROOM, { name });
  }

  joinRoom(code, name) {
    this.socket.emit(EVENTS.JOIN_ROOM, { code, name });
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

  returnToLobby() {
    this.socket.emit(EVENTS.RETURN_TO_LOBBY);
  }

  disconnect() {
    this.socket.disconnect();
  }
}
