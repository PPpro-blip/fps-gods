import { io } from 'socket.io-client';
import { EVENTS } from '../shared/events.js';

// Retry forever with capped exponential backoff plus jitter. A fixed attempt cap
// (the `reconnectionAttempts: 10` often suggested for this outage) is the wrong
// trade for a game: ten tries at 1s covers ~10-20s, shorter than a Railway cold
// start or a redeploy, so the player is stranded on CONNECTION LOST and has to
// refresh mid-match. Unbounded retries with a delay ceiling recover on their own.
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Kept short: this runs on the failure path while a player stares at the badge.
const HEALTH_PROBE_TIMEOUT_MS = 4_000;
// A refused socket is normal for a few seconds while a host boots, so the
// provisional verdict waits this long before it is allowed to accuse the server.
const PROVISIONAL_REPORT_GRACE_MS = 1_200;

/**
 * Normalize the operator-supplied Socket.IO target.
 *
 * Pure and exported so it is unit-testable outside a browser. `VITE_SOCKET_URL`
 * is pasted out of a host dashboard, so it routinely arrives with a trailing
 * slash, a `ws://` scheme, or plain `http://` while the client is served over
 * HTTPS. Each of those silently kills the handshake and shows up as
 * "CONNECTION LOST", which is why this is not just `configuredUrl || origin`.
 */
export function resolveSocketTarget(configuredValue, pageOrigin) {
  const configured = typeof configuredValue === 'string' ? configuredValue.trim() : '';

  // No override: same-origin, which is right for Vite's dev proxy and for any
  // deployment that reverse-proxies /socket.io to the Node process. Whether that
  // fallback is correct here is decided at failure time by probeHealth(), not
  // assumed now, because the same value is both the dev default and the symptom
  // of a split deployment whose build-time URL was never set.
  if (!configured) return { url: pageOrigin, source: 'same-origin' };

  // `new URL` resolves almost anything when given a base, so a stray "not a url"
  // would quietly become a same-origin request to a junk path. Accept an
  // absolute URL, or a bare host that is safe to default to https. A scheme must
  // be `://`, not merely a colon, or `localhost:3000` reads as if `localhost:`
  // were the scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured);
  const bareHost = /^[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(configured);
  const candidate = hasScheme
    ? configured
    : bareHost
      ? `https://${configured}`
      : null;
  if (!candidate) {
    console.error('[FPS GODS] VITE_SOCKET_URL is not a usable URL:', configured, '- falling back to same-origin.');
    return { url: pageOrigin, source: 'invalid-override' };
  }

  let target;
  try {
    // `ws://`/`wss://` are accepted by socket.io-client but normalize them to the
    // http form so the origin comparisons and the rebuild below behave the same.
    const schemeless = candidate.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    target = new URL(schemeless);
  } catch {
    console.error('[FPS GODS] VITE_SOCKET_URL is not a usable URL:', configured, '- falling back to same-origin.');
    return { url: pageOrigin, source: 'invalid-override' };
  }

  if (!/^https?:$/.test(target.protocol)) {
    console.error('[FPS GODS] VITE_SOCKET_URL must be http(s) or ws(s); got', target.protocol, '- falling back to same-origin.');
    return { url: pageOrigin, source: 'invalid-override' };
  }

  // Socket.IO always appends its own `path` (default /socket.io) to whatever URL
  // it is given, so a pasted endpoint that already includes it must have it
  // removed or the client requests /socket.io/socket.io and gets a 404. A
  // trailing slash is the same class of mistake.
  const path = target.pathname
    .replace(/\/socket\.io\/?$/i, '')
    .replace(/\/+$/, '');

  // A base path in front of the engine.io endpoint is legitimate behind a reverse
  // proxy, so only strip what belongs to Socket.IO itself.
  let url = `${target.origin}${path}`;

  // Mixed content: a browser refuses an insecure subresource on a secure page,
  // and the failure looks identical to the server being down.
  let upgradedFromInsecure = false;
  if (pageOrigin.startsWith('https:') && target.protocol === 'http:') {
    url = url.replace(/^http:/, 'https:');
    upgradedFromInsecure = true;
    console.warn('[FPS GODS] VITE_SOCKET_URL used http:// on an https:// page; retrying over https:// to avoid a blocked mixed-content handshake.');
  }

  return { url, source: upgradedFromInsecure ? 'override-upgraded' : 'override' };
}

export function resolveApiUrl(baseUrl, pathname) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const cleanPath = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${cleanBase}${cleanPath}`;
}

// Thin Socket.IO adapter: gameplay decisions never happen here, only inputs go
// up and authoritative room/game snapshots and feedback come back down.
export class GameNetwork {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.lastIssueSignature = null;
    this.probeInFlight = false;
    this.graceElapsed = false;
    this.graceTimer = null;
    this.issue = null;
    // `import.meta.env` only exists under Vite; the optional chain keeps the
    // module importable by the Node test suite and by any non-bundled consumer.
    const configuredUrl = import.meta.env?.VITE_SOCKET_URL;
    const target = resolveSocketTarget(configuredUrl, window.location.origin);
    this.target = target;
    const socketUrl = target.url;

    // Which address we are actually dialling, so a production CONNECTION LOST is
    // diagnosable from the console without redeploying with extra logging.
    console.info(`[FPS GODS] Socket.IO target: ${socketUrl} (source: ${target.source})`);

    this.socket = io(socketUrl, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
      randomizationFactor: 0.4,
      timeout: CONNECT_TIMEOUT_MS,
      withCredentials: true,
    });

    this.socket.on('connect', () => {
      // A fresh handshake clears the dedupe so a later outage is reported again.
      this.lastIssueSignature = null;
      this.issue = null;
      this.handlers.onConnect?.(this.socket.id, this.socket.recovered);
    });
    this.socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') console.error('[FPS GODS] Socket disconnected:', reason);
      this.handlers.onDisconnect?.(reason);
      // A drop is the moment players ask "did the arena die or did I?" - ask it.
      if (reason !== 'io client disconnect') void this.refineAfterDrop();
    });
    this.socket.on('connect_error', (error) => this.reportConnectionIssue(error));
    this.socket.io.on('reconnect_error', (error) => {
      console.error('[FPS GODS] Socket reconnection error:', error);
    });
    this.socket.io.on('error', (error) => {
      console.error('[FPS GODS] Socket manager error:', error);
    });

    this.socket.on(EVENTS.ROOM_STATE, (state) => this.handlers.onRoomState?.(state));
    this.socket.on(EVENTS.ROOM_LIST, (payload) => this.handlers.onRoomList?.(payload));
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
    this.socket.on(EVENTS.HITBOX_TRACE, (data) => this.handlers.onHitboxTrace?.(data));
    this.socket.on(EVENTS.OPPONENT_HEALTH, (data) => this.handlers.onOpponentHealth?.(data));
    this.socket.on(EVENTS.AMMO_UPDATE, (data) => this.handlers.onAmmoUpdate?.(data));
    this.socket.on(EVENTS.HEALTH_UPDATE, (data) => this.handlers.onHealthUpdate?.(data));
    this.socket.on(EVENTS.WEAPON_UPDATE, (data) => this.handlers.onWeaponUpdate?.(data));
    this.socket.on(EVENTS.WEAPON_OVERHEATED, (data) => this.handlers.onWeaponOverheated?.(data));
    this.socket.on(EVENTS.WEAPON_FIRED, (data) => this.handlers.onWeaponFired?.(data));
    this.socket.on(EVENTS.PROJECTILE_IMPACT, (data) => this.handlers.onProjectileImpact?.(data));
    this.socket.on(EVENTS.PROFILE_UPDATE, (data) => this.handlers.onProfileUpdate?.(data));
    this.socket.on(EVENTS.SMOKE_UPDATE, (data) => this.handlers.onSmokeUpdate?.(data));
    this.socket.on(EVENTS.COVER_DESTROYED, (data) => this.handlers.onCoverDestroyed?.(data));
    this.socket.on(EVENTS.NET_PONG, (data) => this.handlers.onPong?.(data));
    this.socket.on(EVENTS.WALLET_UPDATE, (data) => this.handlers.onWalletUpdate?.(data));
    this.socket.on(EVENTS.REWARD_EARNED, (data) => this.handlers.onRewardEarned?.(data));
  }

  get id() {
    return this.socket.id ?? null;
  }

  get connected() {
    return this.socket.connected;
  }

  /** The address this client dials plus where that address came from. */
  get connectionTarget() {
    return { url: this.target.url, source: this.target.source, connected: this.socket.connected };
  }

  /**
   * Ask the arena directly whether it is alive, using the same origin the socket
   * dials. `GET /health` is the discriminator because the Socket.IO error object
   * is useless for this: over the websocket transport every failure - connection
   * refused, DNS error, and a 404 from a static host that is not the game server -
   * arrives as an identical `Error("websocket error")` with no status. Only the
   * polling fallback reports one (`error.description`).
   */
  async probeHealth() {
    if (typeof fetch !== 'function') return { kind: 'unavailable' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
      : null;
    try {
      const response = await fetch(`${this.target.url}/health`, {
        signal: controller?.signal,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (response.ok && body?.status === 'ok') {
        return {
          kind: 'server-alive',
          status: response.status,
          uptime: body.uptime,
          rooms: body.rooms,
          connections: body.connections,
        };
      }
      return { kind: 'not-game-server', status: response.status };
    } catch (error) {
      // An abort is a host that accepted nothing in time; either way nothing
      // useful answered, which is what "offline" means to a player.
      return { kind: 'server-unreachable', reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Map a probe verdict onto the two things a player can act on. `unreachable`
   * renders as SERVER OFFLINE (wait for the host); `offline` renders as
   * CONNECTION LOST (the client is asking the wrong address, so waiting will not
   * help anyone).
   */
  classifyProbe(probe) {
    if (probe.kind === 'server-alive') {
      return {
        badge: 'offline',
        message: 'The arena process is up but its Socket.IO handshake is not reaching this browser - the proxy in front of the server is not upgrading /socket.io.',
      };
    }
    if (probe.kind === 'not-game-server') {
      return {
        badge: 'offline',
        status: probe.status,
        message: this.target.source === 'same-origin'
          ? this.misconfigurationHint()
          : `VITE_SOCKET_URL points at ${this.target.url}, which answered HTTP ${probe.status} without a Socket.IO server - that host is not the arena.`,
      };
    }
    if (probe.kind === 'unavailable') {
      return { badge: 'unreachable', message: 'Cannot reach the arena server. Retrying automatically…' };
    }
    return {
      badge: 'unreachable',
      message: probe.reason === 'timeout'
        ? 'The arena server is not answering - it may be asleep or cold-starting. Reconnecting automatically.'
        : 'The arena server is offline: nothing is listening at its address. Reconnecting automatically.',
    };
  }

  /** Fast, transport-level read of the failure, used before the probe returns. */
  classifyTransportError(error) {
    const status = typeof error?.description === 'number' ? error.description : null;
    if (status === 0 || status === null) {
      return {
        badge: this.target.source === 'same-origin' ? 'offline' : 'unreachable',
        message: this.target.source === 'same-origin'
          ? this.misconfigurationHint()
          : 'Cannot reach the arena server. Retrying automatically…',
      };
    }
    return {
      badge: 'offline',
      status,
      message: this.target.source === 'same-origin'
        ? this.misconfigurationHint()
        : `The Socket.IO handshake got HTTP ${status} from ${this.target.url} - that address is not answering as the arena server.`,
    };
  }

  /**
   * A same-origin fallback with no handshake is the signature of a split
   * deployment (static client on one host, game server on another) where the
   * build-time VITE_SOCKET_URL was never set, so the client is politely asking
   * its own static file host to run a WebSocket server.
   */
  misconfigurationHint() {
    if (this.target.source === 'invalid-override') {
      return 'VITE_SOCKET_URL is set but could not be parsed - fix the value in the host environment, then rebuild the client so it is baked into the bundle.';
    }
    return 'VITE_SOCKET_URL was not baked into this build, so the client fell back to its own origin. Set it to the public game-server URL and redeploy the client - the value is read at build time, so editing the environment variable alone changes nothing.';
  }

  /** Report an issue only when it differs from the last one, so retries stay quiet. */
  emitIssue(detail) {
    const signature = `${detail.badge}:${detail.message}`;
    if (signature === this.lastIssueSignature) return false;
    this.lastIssueSignature = signature;
    this.issue = detail;
    this.handlers.onConnectionError?.(detail);
    return true;
  }

  reportConnectionIssue(error) {
    console.error('[FPS GODS] Socket connection error:', error?.message ?? error, this.target);
    const provisional = this.classifyTransportError(error);

    // The transport reports a refused connection immediately, which on a
    // free-tier host usually just means "still booting". Hold the provisional
    // verdict briefly so a cold start reads as CONNECTING rather than a
    // definitive SERVER OFFLINE; a probe confirming the outage still shows it.
    if (!this.graceElapsed) {
      this.graceTimer ??= setTimeout(() => {
        this.graceElapsed = true;
        this.graceTimer = null;
        if (!this.socket.connected) this.emitIssue(provisional);
      }, PROVISIONAL_REPORT_GRACE_MS);
    } else {
      this.emitIssue(provisional);
    }

    if (this.probeInFlight || this.socket.connected) return;
    this.probeInFlight = true;
    this.probeHealth().then((probe) => {
      this.probeInFlight = false;
      if (this.socket.connected) return;
      const refined = this.classifyProbe(probe);
      console.warn('[FPS GODS] Health probe:', probe.kind, '-> badge', refined.badge);
      clearTimeout(this.graceTimer);
      this.graceElapsed = true;
      this.graceTimer = null;
      this.emitIssue(refined);
    });
  }

  /** After a mid-match drop, say whether the arena died or the route did. */
  async refineAfterDrop() {
    const probe = await this.probeHealth();
    if (this.socket.connected || probe.kind === 'unavailable') return;
    if (probe.kind === 'server-alive') {
      this.emitIssue({
        badge: 'offline',
        message: 'Connection to the arena dropped while the server stayed up. Reconnecting automatically…',
      });
      return;
    }
    this.emitIssue(this.classifyProbe(probe));
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

  /** Ask the server for its read-only lobby browser. */
  listRooms() {
    this.socket.emit(EVENTS.LIST_ROOMS);
  }

  createRoom(name, bundleId, profileId, mapId = null) {
    this.socket.emit(EVENTS.CREATE_ROOM, { name, bundleId, profileId, mapId });
  }

  joinRoom(code, name, bundleId, profileId) {
    this.socket.emit(EVENTS.JOIN_ROOM, { code, name, bundleId, profileId });
  }

  playNow(name, bundleId, profileId, mapId = null, botDifficulty = null) {
    this.socket.emit(EVENTS.PLAY_NOW, {
      name,
      bundleId,
      profileId,
      mapId,
      ...(botDifficulty ? { botDifficulty } : {}),
    });
  }

  /** Host-only, lobby-only arena change. The server re-validates and rebroadcasts. */
  setRoomMap(mapId) {
    this.socket.emit(EVENTS.SET_ROOM_MAP, { mapId });
  }

  /** Host-only solo bot difficulty preset update. */
  setBotDifficulty(botDifficulty) {
    this.socket.emit(EVENTS.SET_BOT_DIFFICULTY, { botDifficulty });
  }

  setReady(ready) {
    this.socket.emit(EVENTS.PLAYER_READY, { ready: Boolean(ready) });
  }

  startGame() {
    this.socket.emit(EVENTS.START_GAME);
  }

  sendInput(input) {
    if (!this.socket.connected) return;
    // InputCadence already rate-limits packets to server tick cadence + edge
    // transitions (~20 pkt/s while moving, 0 while idle). Reliable emit keeps
    // inputAck monotonic so local prediction never replays stale windows.
    this.socket.emit(EVENTS.PLAYER_INPUT, input);
  }

  sendPing(payload) {
    if (!this.socket.connected) return;
    this.socket.volatile.emit(EVENTS.NET_PING, payload);
  }

  clearSocketAuth() {
    if (this.socket.connected) this.socket.emit(EVENTS.AUTH_SYNC, {});
  }

  async apiRequest(pathname, { method = 'GET', body, signal } = {}) {
    const url = resolveApiUrl(this.target.url, pathname);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const error = new Error(data?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = data?.code || 'HTTP_ERROR';
      error.payload = data;
      throw error;
    }
    return data;
  }

  shoot(shotId) {
    if (this.socket.connected) this.socket.emit(EVENTS.SHOOT, { shotId });
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

  playAgain(botDifficulty = null) {
    this.socket.emit(EVENTS.PLAY_AGAIN, botDifficulty ? { botDifficulty } : {});
  }

  disconnect() {
    this.socket.disconnect();
  }
}
