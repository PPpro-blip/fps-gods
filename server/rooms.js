import { createHash, randomBytes, randomInt } from 'node:crypto';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { DEFAULT_BUNDLE_ID, BUNDLE_UNLOCK_KILLS } from '../shared/bundles.js';
import { PLAYER } from '../shared/gameConfig.js';
import { PlayerProfileStore } from './profiles.js';
import { getBundleLoadout, isBundleId } from './weaponConfig.js';

export const ROOM_RECONNECT_GRACE_MS = 45_000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createResumeToken() {
  return randomBytes(32).toString('base64url');
}

function hashResumeToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
const PLAYER_COLORS = [
  '#57d6ff', '#ff657a', '#b18cff', '#ffc857',
  '#6be6a8', '#ff925c', '#67a2ff', '#ff72cc',
  '#d6ec62', '#64d9c4', '#fa7895', '#a0a8ff',
  '#e5a85c', '#71e2ff', '#d48cff', '#9ce37b',
];

function createRoomCode(existingRooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!existingRooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code. Please try again.');
}

function cleanName(value) {
  const characters = [...String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()];
  const requested = characters.slice(0, 16).join('').trim();
  return requested || `Ranger-${randomInt(100, 1000)}`;
}

function uniqueName(room, requestedName) {
  const used = new Set([...room.players.values()].map((player) => player.name.toLocaleLowerCase()));
  if (!used.has(requestedName.toLocaleLowerCase())) return requestedName;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const ending = ` ${suffix}`;
    const candidate = `${[...requestedName].slice(0, 16 - ending.length).join('')}${ending}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${[...requestedName].slice(0, 11).join('')} ${randomInt(100, 1000)}`;
}

// Owns room membership and state transitions. Each room has its own Socket.IO
// channel and its own game state; no broadcast is ever sent to a global channel.
export class RoomManager {
  constructor(io, profileStore = new PlayerProfileStore(null)) {
    this.io = io;
    this.profileStore = profileStore;
    this.rooms = new Map();
  }

  createRoom(socket, requestedName, selection = {}) {
    return this.createRoomWithState(socket, requestedName, ROOM_STATES.LOBBY, ROOM_MODES.MULTIPLAYER, true, selection);
  }

  createSoloBotsRoom(socket, requestedName, selection = {}) {
    return this.createRoomWithState(socket, requestedName, ROOM_STATES.PLAYING, ROOM_MODES.SOLO_VS_BOTS, false, selection);
  }

  createRoomWithState(socket, requestedName, state, mode, broadcast, selection = {}) {
    if (socket.data.roomCode) {
      this.emitError(socket, 'You are already in a room. Finish or leave that room first.');
      return null;
    }

    const profileSelection = this.resolveProfileSelection(socket, requestedName, selection);
    if (!profileSelection) return null;

    const code = createRoomCode(this.rooms);
    const room = {
      code,
      state,
      mode,
      hostId: socket.id,
      createdAt: Date.now(),
      players: new Map(),
      game: null,
      winner: null,
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, requestedName, profileSelection);
    if (broadcast) this.broadcastRoomState(room);
    return room;
  }

  joinRoom(socket, requestedCode, requestedName, selection = {}) {
    if (socket.data.roomCode) {
      this.emitError(socket, 'You are already in a room. Finish or leave that room first.');
      return null;
    }

    const code = String(requestedCode ?? '').trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      this.emitError(socket, 'Enter a valid six-character room code.');
      return null;
    }

    const room = this.rooms.get(code);
    if (!room) {
      this.emitError(socket, 'That room does not exist. Check the code and try again.');
      return null;
    }
    if (room.state !== ROOM_STATES.LOBBY) {
      this.emitError(socket, 'That match has already started. Ask the host to create a new room.');
      return null;
    }
    if (room.players.size >= PLAYER.maxPlayers) {
      this.emitError(socket, 'That room is full (16 players maximum).');
      return null;
    }

    const profileSelection = this.resolveProfileSelection(socket, requestedName, selection);
    if (!profileSelection) return null;
    this.addPlayer(room, socket, requestedName, profileSelection);
    this.broadcastRoomState(room);
    return room;
  }

  resumeRoom(socket, payload = {}, now = Date.now()) {
    const code = String(payload.roomCode ?? '').trim().toUpperCase();
    const token = typeof payload.resumeToken === 'string' ? payload.resumeToken : '';
    const room = this.rooms.get(code);
    if (socket.data.roomCode || !room || !/^[A-Z2-9]{6}$/.test(code) || !/^[A-Za-z0-9_-]{40,48}$/.test(token)) {
      socket.emit(EVENTS.ROOM_RESUME_FAILED, { message: 'That room session has expired. Join the room again with its code.' });
      return null;
    }

    const tokenHash = hashResumeToken(token);
    const player = [...room.players.values()].find((candidate) => candidate.resumeTokenHash === tokenHash);
    const disconnectedTooLong = player && !player.connected
      && (player.disconnectedAt === null || now - player.disconnectedAt > ROOM_RECONNECT_GRACE_MS);
    if (!player || disconnectedTooLong
      || (socket.data.profileId && socket.data.profileId !== player.profileId)) {
      socket.emit(EVENTS.ROOM_RESUME_FAILED, { message: 'That room session has expired. Join the room again with its code.' });
      return null;
    }

    const previousId = player.id;
    if (room.game && !room.game.rebindPlayer(previousId, socket.id, now)) {
      socket.emit(EVENTS.ROOM_RESUME_FAILED, { message: 'That match can no longer be resumed. Create or join another room.' });
      return null;
    }
    const previousSocket = this.io.sockets?.sockets?.get(previousId);
    if (previousSocket && previousId !== socket.id) {
      previousSocket.leave(room.code);
      previousSocket.data.roomCode = undefined;
      previousSocket.data.playerId = undefined;
      previousSocket.disconnect(true);
    }
    room.players.delete(previousId);
    player.id = socket.id;
    player.connected = true;
    player.disconnectedAt = null;
    player.connectedAt = now;
    const resumeToken = createResumeToken();
    player.resumeTokenHash = hashResumeToken(resumeToken);
    room.players.set(player.id, player);
    if (room.hostId === previousId) room.hostId = socket.id;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = socket.id;
    socket.data.profileId = player.profileId;
    socket.emit(EVENTS.ROOM_SESSION, { roomCode: room.code, resumeToken });
    this.broadcastRoomState(room);
    if (room.state === ROOM_STATES.ENDED) {
      socket.emit(EVENTS.GAME_END, {
        code: room.code,
        winner: room.winner,
        scoreboard: room.game?.getScoreboard() ?? [],
      });
    }
    return room;
  }

  recoverSocket(socket, now = Date.now()) {
    const room = this.getRoomForSocket(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player) return false;
    player.connected = true;
    player.disconnectedAt = null;
    player.connectedAt = now;
    room.game?.setPlayerConnected(socket.id, true, now);
    const resumeToken = createResumeToken();
    player.resumeTokenHash = hashResumeToken(resumeToken);
    socket.emit(EVENTS.ROOM_SESSION, { roomCode: room.code, resumeToken });
    this.broadcastRoomState(room);
    return true;
  }

  resolveProfileSelection(socket, requestedName, selection = {}) {
    const callsign = cleanName(requestedName);
    const profile = this.profileStore.getOrCreate(
      selection?.profileId ?? socket.data.profileId,
      callsign,
    );
    const bundleId = typeof selection?.bundleId === 'string' ? selection.bundleId : DEFAULT_BUNDLE_ID;

    if (!isBundleId(bundleId)) {
      this.emitError(socket, 'Choose a valid weapon bundle before joining a room.');
      return null;
    }
    if (!this.profileStore.isBundleUnlocked(profile.profileId, bundleId)) {
      this.emitError(socket, `GODS TIER unlocks at ${BUNDLE_UNLOCK_KILLS} lifetime kills. Your profile has ${profile.lifetimeKills}.`);
      return null;
    }

    socket.data.profileId = profile.profileId;
    socket.emit(EVENTS.PROFILE_UPDATE, profile);
    return { profileId: profile.profileId, lifetimeKills: profile.lifetimeKills, bundleId, callsign };
  }

  addPlayer(room, socket, requestedName, profileSelection) {
    const player = {
      id: socket.id,
      profileId: profileSelection.profileId,
      lifetimeKills: profileSelection.lifetimeKills,
      bundleId: profileSelection.bundleId,
      currentWeaponId: getBundleLoadout(profileSelection.bundleId)[0].id,
      name: uniqueName(room, profileSelection.callsign || cleanName(requestedName)),
      color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
      ready: false,
      connected: true,
      connectedAt: Date.now(),
      disconnectedAt: null,
      resumeTokenHash: null,
    };
    const resumeToken = createResumeToken();
    player.resumeTokenHash = hashResumeToken(resumeToken);
    room.players.set(player.id, player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit(EVENTS.ROOM_SESSION, { roomCode: room.code, resumeToken });
  }

  setReady(socket, requestedReady) {
    const room = this.getRoomForSocket(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    if (room.state !== ROOM_STATES.LOBBY) {
      this.emitError(socket, 'Ready status can only be changed in the lobby.');
      return;
    }
    if (!player.connected) return;

    player.ready = requestedReady === true;
    this.broadcastRoomState(room);
  }

  startGame(socket) {
    const room = this.getRoomForSocket(socket);
    if (!room) return { error: 'Join a room before starting a match.' };
    if (room.hostId !== socket.id) return { error: 'Only the room host can start the match.' };
    if (room.state !== ROOM_STATES.LOBBY) return { error: 'This room is not waiting in the lobby.' };
    if ([...room.players.values()].some((player) => !player.connected)) {
      return { error: 'Wait for disconnected operators to reconnect or for their room session to expire.' };
    }
    if (room.players.size < PLAYER.minPlayers) return { error: 'At least two players are needed to start.' };
    if ([...room.players.values()].some((player) => !player.ready)) {
      return { error: 'Every player, including the host, must be ready first.' };
    }

    room.state = ROOM_STATES.PLAYING;
    room.winner = null;
    return { room };
  }

  returnToLobby(socket) {
    const room = this.getRoomForSocket(socket);
    if (!room) {
      this.emitError(socket, 'You are no longer in a room.');
      return null;
    }
    if (room.state !== ROOM_STATES.ENDED) {
      this.emitError(socket, 'A match must be over before returning to the lobby.');
      return null;
    }
    if (room.hostId !== socket.id) {
      this.emitError(socket, 'The host will return everyone to the lobby.');
      return null;
    }

    room.state = ROOM_STATES.LOBBY;
    room.game = null;
    room.winner = null;
    for (const player of room.players.values()) player.ready = false;

    this.io.to(room.code).emit(EVENTS.RETURN_TO_LOBBY, { code: room.code });
    this.broadcastRoomState(room);
    return room;
  }

  leaveRoom(socket) {
    const room = this.getRoomForSocket(socket);
    if (!room) {
      socket.emit(EVENTS.ROOM_LEFT, { roomCode: null });
      return null;
    }
    this.removePlayer(room, socket.id);
    socket.leave(room.code);
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;
    socket.emit(EVENTS.ROOM_LEFT, { roomCode: room.code });
    return room;
  }

  expireDisconnectedPlayers(now = Date.now()) {
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const player of [...room.players.values()]) {
        if (player.connected || player.disconnectedAt === null
          || now - player.disconnectedAt <= ROOM_RECONNECT_GRACE_MS) continue;
        this.removePlayer(room, player.id, false);
        changed = true;
      }
      if (room.players.size === 0) {
        this.rooms.delete(room.code);
      } else if (changed) {
        this.ensureHost(room);
        this.broadcastRoomState(room);
      }
    }
  }

  removePlayer(room, playerId, broadcast = true) {
    const player = room.players.get(playerId);
    if (!player) return false;
    room.players.delete(playerId);
    room.game?.removePlayer(playerId);
    if (room.hostId === playerId) this.ensureHost(room);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return true;
    }
    if (broadcast) this.broadcastRoomState(room);
    return true;
  }

  ensureHost(room) {
    const connectedPlayers = [...room.players.values()].filter((player) => player.connected);
    const candidates = connectedPlayers.length ? connectedPlayers : [...room.players.values()];
    if (!candidates.length) return;
    const nextHost = candidates.sort((left, right) => left.connectedAt - right.connectedAt)[0];
    room.hostId = nextHost.id;
  }

  getRoomForSocket(socket) {
    const code = socket.data.roomCode;
    return code ? this.rooms.get(code) ?? null : null;
  }

  broadcastRoomState(room) {
    const gamePlayers = room.game?.players;
    const players = gamePlayers
      ? [...gamePlayers.values()].map((player) => ({
          id: player.id,
          name: player.name,
          color: player.color,
          ready: room.players.get(player.id)?.ready ?? false,
          kills: player.kills,
          deaths: player.deaths,
          health: player.health,
          alive: player.alive,
          isBot: Boolean(player.isBot),
          connected: player.connected !== false,
          bundleId: player.bundleId,
          currentWeaponId: player.currentWeaponId,
          currentWeaponName: player.currentWeaponName,
          currentWeaponIcon: player.currentWeaponIcon,
        }))
      : [...room.players.values()].map((player) => ({
          id: player.id,
          name: player.name,
          color: player.color,
          ready: player.ready,
          kills: 0,
          deaths: 0,
          health: PLAYER.maxHealth,
          alive: true,
          connected: player.connected !== false,
          bundleId: player.bundleId,
          currentWeaponId: player.currentWeaponId,
        }));

    this.io.to(room.code).emit(EVENTS.ROOM_STATE, {
      code: room.code,
      state: room.state,
      mode: room.mode,
      hostId: room.hostId,
      players,
      minPlayers: PLAYER.minPlayers,
      maxPlayers: PLAYER.maxPlayers,
      targetKills: PLAYER.targetKills,
      winner: room.winner,
    });
  }

  endGame(room, winner) {
    if (room.state !== ROOM_STATES.PLAYING) return;
    room.state = ROOM_STATES.ENDED;
    room.winner = winner;
    this.io.to(room.code).emit(EVENTS.GAME_END, {
      code: room.code,
      winner,
      scoreboard: room.game?.getScoreboard() ?? [],
    });
    this.broadcastRoomState(room);
  }

  handleDisconnect(socket, now = Date.now()) {
    const room = this.getRoomForSocket(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;

    player.connected = false;
    player.disconnectedAt = now;
    room.game?.setPlayerConnected(socket.id, false, now);

    if (room.hostId === socket.id) this.ensureHost(room);
    this.broadcastRoomState(room);
  }

  emitError(socket, message) {
    socket.emit(EVENTS.ROOM_ERROR, { message });
  }
}
