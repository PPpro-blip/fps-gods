import { randomInt } from 'node:crypto';
import { EVENTS, ROOM_STATES, ROOM_TYPES } from '../shared/events.js';
import { BOTS, PLAYER } from '../shared/gameConfig.js';
import { BOT_BUNDLE_IDS, GODS_TIER_UNLOCK_KILLS, getBundle, isBundleUnlocked } from '../shared/weapons.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_COLORS = [
  '#57d6ff', '#ff657a', '#b18cff', '#ffc857',
  '#6be6a8', '#ff925c', '#67a2ff', '#ff72cc',
  '#d6ec62', '#64d9c4', '#fa7895', '#a0a8ff',
  '#e5a85c', '#71e2ff', '#d48cff', '#9ce37b',
];
const BOT_COLORS = ['#ff657a', '#b18cff', '#ffc857', '#6be6a8', '#ff925c', '#67a2ff', '#d6ec62', '#d48cff'];

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

function cleanBundle(value) {
  const requested = String(value ?? '').trim().toLowerCase();
  try {
    return getBundle(requested).id;
  } catch {
    return 'rusher';
  }
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
// Solo drop-in matches live here too: private SOLO_VS_BOTS rooms whose bots
// only exist as ordinary players inside the game state.
export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    // Best-effort lifetime eliminations per callsign. Seeded from the total the
    // browser has saved locally (there are no accounts) and updated on every
    // match end so the GODS TIER unlock survives server restarts in spirit.
    this.lifetimeKills = new Map();
  }

  seedLifetimeKills(name, claimedKills) {
    const key = cleanName(name).toLocaleLowerCase();
    const claimed = Number.isFinite(Number(claimedKills))
      ? Math.max(0, Math.min(999_999, Math.trunc(Number(claimedKills))))
      : 0;
    const current = this.lifetimeKills.get(key) ?? 0;
    if (claimed > current) this.lifetimeKills.set(key, claimed);
  }

  lifetimeKillsFor(name) {
    return this.lifetimeKills.get(cleanName(name).toLocaleLowerCase()) ?? 0;
  }

  recordMatchKills(room) {
    if (!room.game) return;
    for (const player of room.game.players.values()) {
      if (player.isBot || player.kills <= 0) continue;
      const key = player.name.toLocaleLowerCase();
      this.lifetimeKills.set(key, (this.lifetimeKills.get(key) ?? 0) + player.kills);
    }
  }

  ensureBundleUnlocked(socket, name, bundleId) {
    if (bundleId !== 'gods') return true;
    if (isBundleUnlocked('gods', this.lifetimeKillsFor(name))) return true;
    this.emitError(socket, `GODS TIER unlocks at ${GODS_TIER_UNLOCK_KILLS} lifetime kills. Keep fighting.`);
    return false;
  }

  createRoom(socket, requestedName, requestedBundle, claimedKills = 0) {
    if (socket.data.roomCode) {
      this.emitError(socket, 'You are already in a room. Finish or leave that room first.');
      return null;
    }

    const name = cleanName(requestedName);
    const bundleId = cleanBundle(requestedBundle);
    this.seedLifetimeKills(name, claimedKills);
    if (!this.ensureBundleUnlocked(socket, name, bundleId)) return null;

    const code = createRoomCode(this.rooms);
    const room = {
      code,
      type: ROOM_TYPES.MULTIPLAYER,
      state: ROOM_STATES.LOBBY,
      hostId: socket.id,
      createdAt: Date.now(),
      players: new Map(),
      game: null,
      winner: null,
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, name, bundleId);
    this.broadcastRoomState(room);
    return room;
  }

  joinRoom(socket, requestedCode, requestedName, requestedBundle, claimedKills = 0) {
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
    if (room.type === ROOM_TYPES.SOLO_VS_BOTS) {
      this.emitError(socket, 'Solo matches are private. Use PLAY NOW for your own bot arena.');
      return null;
    }
    if (room.state !== ROOM_STATES.LOBBY) {
      this.emitError(socket, 'That match has already started. Ask the host to create a new room.');
      return null;
    }
    if (this.humanCount(room) >= PLAYER.maxPlayers) {
      this.emitError(socket, 'That room is full (16 players maximum).');
      return null;
    }

    const name = cleanName(requestedName);
    const bundleId = cleanBundle(requestedBundle);
    this.seedLifetimeKills(name, claimedKills);
    if (!this.ensureBundleUnlocked(socket, name, bundleId)) return null;

    this.addPlayer(room, socket, name, bundleId);
    this.broadcastRoomState(room);
    return room;
  }

  // Instant drop-in: one human, five bots, straight into PLAYING. No code is
  // shared and nobody can join a SOLO_VS_BOTS room.
  playSolo(socket, requestedName, requestedBundle, claimedKills = 0) {
    if (socket.data.roomCode) {
      this.emitError(socket, 'You are already in a room. Finish or leave that room first.');
      return null;
    }

    const name = cleanName(requestedName);
    const bundleId = cleanBundle(requestedBundle);
    this.seedLifetimeKills(name, claimedKills);
    if (!this.ensureBundleUnlocked(socket, name, bundleId)) return null;

    const code = createRoomCode(this.rooms);
    const room = {
      code,
      type: ROOM_TYPES.SOLO_VS_BOTS,
      state: ROOM_STATES.LOBBY,
      hostId: socket.id,
      createdAt: Date.now(),
      players: new Map(),
      game: null,
      winner: null,
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, name, bundleId);
    const human = room.players.get(socket.id);
    if (human) human.ready = true;

    for (let index = 0; index < BOTS.count; index += 1) {
      const botId = `bot-${index + 1}`;
      room.players.set(botId, {
        id: botId,
        name: `${BOTS.namePrefix}${String(index + 1).padStart(2, '0')}`,
        color: BOT_COLORS[index % BOT_COLORS.length],
        ready: true,
        connectedAt: Date.now() + index,
        isBot: true,
        bundleId: BOT_BUNDLE_IDS[randomInt(BOT_BUNDLE_IDS.length)],
      });
    }

    room.state = ROOM_STATES.PLAYING;
    room.winner = null;
    return { room };
  }

  addPlayer(room, socket, name, bundleId) {
    const player = {
      id: socket.id,
      name: uniqueName(room, name),
      color: PLAYER_COLORS[this.humanCount(room) % PLAYER_COLORS.length],
      ready: false,
      connectedAt: Date.now(),
      isBot: false,
      bundleId,
    };
    room.players.set(player.id, player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    return player;
  }

  humanCount(room) {
    let count = 0;
    for (const player of room.players.values()) {
      if (!player.isBot) count += 1;
    }
    return count;
  }

  setReady(socket, requestedReady) {
    const room = this.getRoomForSocket(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    if (room.state !== ROOM_STATES.LOBBY) {
      this.emitError(socket, 'Ready status can only be changed in the lobby.');
      return;
    }

    player.ready = requestedReady === true;
    this.broadcastRoomState(room);
  }

  startGame(socket) {
    const room = this.getRoomForSocket(socket);
    if (!room) return { error: 'Join a room before starting a match.' };
    if (room.hostId !== socket.id) return { error: 'Only the room host can start the match.' };
    if (room.state !== ROOM_STATES.LOBBY) return { error: 'This room is not waiting in the lobby.' };

    const minimum = room.type === ROOM_TYPES.SOLO_VS_BOTS ? 1 : PLAYER.minPlayers;
    if (this.humanCount(room) < minimum) return { error: 'At least two players are needed to start.' };
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
    for (const player of room.players.values()) player.ready = player.isBot === true;

    this.io.to(room.code).emit(EVENTS.RETURN_TO_LOBBY, { code: room.code });
    this.broadcastRoomState(room);
    return room;
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
          isBot: player.isBot,
          bundleId: player.bundleId,
          weaponId: player.slots[player.slot].weaponId,
          ready: room.players.get(player.id)?.ready ?? player.isBot,
          kills: player.kills,
          deaths: player.deaths,
          health: player.health,
          alive: player.alive,
        }))
      : [...room.players.values()].map((player) => ({
          id: player.id,
          name: player.name,
          color: player.color,
          isBot: player.isBot === true,
          bundleId: player.bundleId,
          weaponId: null,
          ready: player.ready,
          kills: 0,
          deaths: 0,
          health: PLAYER.maxHealth,
          alive: true,
        }));

    this.io.to(room.code).emit(EVENTS.ROOM_STATE, {
      code: room.code,
      type: room.type,
      state: room.state,
      hostId: room.hostId,
      players,
      minPlayers: room.type === ROOM_TYPES.SOLO_VS_BOTS ? 1 : PLAYER.minPlayers,
      maxPlayers: PLAYER.maxPlayers,
      targetKills: PLAYER.targetKills,
      winner: room.winner,
    });
  }

  endGame(room, winner) {
    if (room.state !== ROOM_STATES.PLAYING) return;
    room.state = ROOM_STATES.ENDED;
    room.winner = winner;
    this.recordMatchKills(room);
    this.io.to(room.code).emit(EVENTS.GAME_END, {
      code: room.code,
      type: room.type,
      winner,
      scoreboard: room.game?.getScoreboard() ?? [],
    });
    this.broadcastRoomState(room);
  }

  handleDisconnect(socket) {
    const code = socket.data.roomCode;
    const room = code ? this.rooms.get(code) : null;
    if (!room) return;

    room.players.delete(socket.id);
    room.game?.removePlayer(socket.id);
    socket.data.roomCode = undefined;
    socket.data.playerId = undefined;

    // Bots are not connections: a room survives only while humans remain.
    if (this.humanCount(room) === 0) {
      this.rooms.delete(room.code);
      return;
    }

    if (room.hostId === socket.id) {
      const nextHost = [...room.players.values()]
        .filter((player) => !player.isBot)
        .sort((left, right) => left.connectedAt - right.connectedAt)[0];
      room.hostId = nextHost?.id ?? room.hostId;
    }

    this.broadcastRoomState(room);
  }

  emitError(socket, message) {
    socket.emit(EVENTS.ROOM_ERROR, { message });
  }
}
