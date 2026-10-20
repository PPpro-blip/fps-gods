import { io } from 'socket.io-client';
import { EVENTS } from '../shared/events.js';

// Thin Socket.IO adapter: gameplay decisions never happen here, only inputs go
// up and authoritative room/game snapshots and feedback come back down.
export class GameNetwork {
  constructor(handlers = {}) {
    this.handlers = handlers;
    const configuredUrl = import.meta.env.VITE_SOCKET_URL?.trim();
    const socketUrl = configuredUrl || window.location.origin;

    this.socket = io(socketUrl, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 3_000,
      reconnectionDelayMax: 3_000,
      randomizationFactor: 0,
      timeout: 10_000,
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => this.handlers.onConnect?.(this.socket.id, this.socket.recovered));
    this.socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') console.error('[FPS GODS] Socket disconnected:', reason);
      this.handlers.onDisconnect?.(reason);
    });
    this.socket.on('connect_error', (error) => {
      console.error('[FPS GODS] Socket connection error:', error);
      this.handlers.onConnectionError?.(error);
    });
    this.socket.io.on('reconnect_error', (error) => {
      console.error('[FPS GODS] Socket reconnection error:', error);
    });
    this.socket.io.on('error', (error) => {
      console.error('[FPS GODS] Socket manager error:', error);
    });

    this.socket.on(EVENTS.ROOM_STATE, (state) => this.handlers.onRoomState?.(state));
    this.socket.on(EVENTS.ROOM_ERROR, (error) => this.handlers.onRoomError?.(error));
    this.socket.on(EVENTS.ROOM_SESSION, (session) => this.handlers.onRoomSession?.(session));
    this.socket.on(EVENTS.ROOM_RESUME_FAILED, (error) => this.handlers.onRoomResumeFailed?.(error));
    this.socket.on(EVENTS.ROOM_LEFT, (data) => this.handlers.onRoomLeft?.(data));
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
    this.socket.on(EVENTS.WEAPON_UPDATE, (data) => this.handlers.onWeaponUpdate?.(data));
    this.socket.on(EVENTS.WEAPON_OVERHEATED, (data) => this.handlers.onWeaponOverheated?.(data));
    this.socket.on(EVENTS.WEAPON_FIRED, (data) => this.handlers.onWeaponFired?.(data));
    this.socket.on(EVENTS.PROFILE_UPDATE, (data) => this.handlers.onProfileUpdate?.(data));
    this.socket.on(EVENTS.SMOKE_UPDATE, (data) => this.handlers.onSmokeUpdate?.(data));
    this.socket.on(EVENTS.COVER_DESTROYED, (data) => this.handlers.onCoverDestroyed?.(data));
  }

  get id() {
    return this.socket.id ?? null;
  }

  get connected() {
    return this.socket.connected;
  }

  requestProfile(profileId, callsign) {
    this.socket.emit(EVENTS.PROFILE_REQUEST, { profileId, callsign });
  }

  resumeRoom(session) {
    if (!session?.roomCode || !session?.resumeToken) return;
    this.socket.emit(EVENTS.ROOM_RESUME, session);
  }

  leaveRoom() {
    this.socket.emit(EVENTS.LEAVE_ROOM);
  }

  createRoom(name, bundleId, profileId) {
    this.socket.emit(EVENTS.CREATE_ROOM, { name, bundleId, profileId });
  }

  joinRoom(code, name, bundleId, profileId) {
    this.socket.emit(EVENTS.JOIN_ROOM, { code, name, bundleId, profileId });
  }

  playNow(name, bundleId, profileId) {
    this.socket.emit(EVENTS.PLAY_NOW, { name, bundleId, profileId });
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

  switchWeapon(weaponId) {
    this.socket.emit(EVENTS.WEAPON_SWITCH, { weaponId });
  }

  returnToLobby() {
    this.socket.emit(EVENTS.RETURN_TO_LOBBY);
  }

  playAgain() {
    this.socket.emit(EVENTS.PLAY_AGAIN);
  }

  disconnect() {
    this.socket.disconnect();
  }
}
