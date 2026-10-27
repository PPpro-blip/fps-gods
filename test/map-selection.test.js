import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENTS, ROOM_STATES } from '../shared/events.js';
import { DEFAULT_MAP_ID, MAP_IDS, getMap } from '../shared/maps.js';
import { RoomManager } from '../server/rooms.js';
import { createMemoryProfileStore } from '../server/profiles.js';

class FakeIO {
  constructor() { this.broadcasts = []; }
  to(room) {
    return { emit: (event, data) => this.broadcasts.push({ room, event, data }) };
  }
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.data = {};
    this.events = [];
  }
  join() {}
  emit(event, data) { this.events.push({ event, data }); }
  leave() {}
}

function makeManager() {
  const io = new FakeIO();
  return { io, rooms: new RoomManager(io, createMemoryProfileStore()) };
}

const lastState = (io, code) => [...io.broadcasts]
  .reverse()
  .find((entry) => entry.event === EVENTS.ROOM_STATE && entry.room === code)?.data;

test('solo rooms use the requested map and never the requested-away one', () => {
  const { io, rooms } = makeManager();
  const socket = new FakeSocket('solo-a');

  const room = rooms.createSoloBotsRoom(socket, 'Solo', { mapId: MAP_IDS.DUSTLINE });
  assert.equal(room.mapId, MAP_IDS.DUSTLINE);
  assert.equal(getMap(room.mapId).name, getMap(MAP_IDS.DUSTLINE).name);
  // Solo rooms are private: creating one must not advertise it to the browser.
  assert.equal(io.broadcasts.length, 0);
  assert.deepEqual(rooms.listRooms(), []);
});

test('a solo room with no map id falls back to the documented default', () => {
  const { rooms } = makeManager();
  const room = rooms.createSoloBotsRoom(new FakeSocket('solo-b'), 'Solo');
  assert.equal(room.mapId, DEFAULT_MAP_ID);

  const junk = rooms.createSoloBotsRoom(new FakeSocket('solo-c'), 'Solo', { mapId: 'not-a-map' });
  assert.equal(junk.mapId, DEFAULT_MAP_ID, 'an unknown id is never accepted verbatim');
});

test('the host picks the arena and every lobby member sees it', () => {
  const { io, rooms } = makeManager();
  const host = new FakeSocket('host-a');
  const guest = new FakeSocket('guest-b');
  const room = rooms.createRoom(host, 'Host', { mapId: MAP_IDS.SKYBRIDGE });
  assert.equal(room.mapId, MAP_IDS.SKYBRIDGE, 'create-time choice is honoured');

  const updated = rooms.setRoomMap(host, MAP_IDS.DUSTLINE);
  assert.equal(updated.mapId, MAP_IDS.DUSTLINE);

  rooms.joinRoom(guest, room.code, 'Guest', { mapId: MAP_IDS.FOUNDRY });
  assert.equal(room.mapId, MAP_IDS.DUSTLINE, 'a joiner cannot override the host choice');

  const state = lastState(io, room.code);
  assert.equal(state.mapId, MAP_IDS.DUSTLINE);
  assert.equal(state.mapName, getMap(MAP_IDS.DUSTLINE).name);
});

test('only the host can change the arena, and only from the lobby', () => {
  const { rooms } = makeManager();
  const host = new FakeSocket('host-a');
  const guest = new FakeSocket('guest-b');
  const room = rooms.createRoom(host, 'Host');
  rooms.joinRoom(guest, room.code, 'Guest');

  const guestAttempt = rooms.setRoomMap(guest, MAP_IDS.DUSTLINE);
  assert.equal(guestAttempt, null);
  assert.equal(room.mapId, DEFAULT_MAP_ID, 'a non-host cannot move the room to another arena');
  assert.match(guest.events.at(-1).data.message, /host/i);

  const junk = rooms.setRoomMap(host, 'north-pole');
  assert.equal(junk, null);
  assert.equal(room.mapId, DEFAULT_MAP_ID, 'an unlisted map id is rejected outright');
  assert.match(host.events.at(-1).data.message, /arena does not exist/i);

  rooms.setReady(host, true);
  rooms.setReady(guest, true);
  assert.equal(rooms.startGame(host).room.state, ROOM_STATES.PLAYING);

  const late = rooms.setRoomMap(host, MAP_IDS.SKYBRIDGE);
  assert.equal(late, null, 'the arena is locked once the match starts');
  assert.equal(room.mapId, DEFAULT_MAP_ID);
});

test('the public room listing advertises the real arena', () => {
  const { rooms } = makeManager();
  const host = new FakeSocket('host-a');
  rooms.createRoom(host, 'Host', { mapId: MAP_IDS.SKYBRIDGE });
  const [entry] = rooms.listRooms();
  assert.equal(entry.mapId, MAP_IDS.SKYBRIDGE);
  assert.equal(entry.mapName, getMap(MAP_IDS.SKYBRIDGE).name);
});

test('host choice, late join, and start all agree over a real socket connection', async () => {
  const { io: ioClient } = await import('socket.io-client');
  const { createGameServer } = await import('../server/index.js');
  const server = createGameServer({ profileStore: createMemoryProfileStore() });
  const port = await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => resolve(server.httpServer.address().port));
  });

  const connect = () => new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['polling'], reconnection: false, timeout: 5_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

  const host = await connect();
  const guest = await connect();
  try {
    const lobby = await new Promise((resolve, reject) => {
      host.once(EVENTS.ROOM_STATE, resolve);
      host.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      host.emit(EVENTS.CREATE_ROOM, { name: 'Host', mapId: MAP_IDS.FOUNDRY });
    });

    const chosen = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ROOM_STATE after SET_ROOM_MAP')), 5_000);
      host.once(EVENTS.ROOM_STATE, (state) => {
        clearTimeout(timer);
        resolve(state);
      });
      host.emit(EVENTS.SET_ROOM_MAP, { mapId: MAP_IDS.DUSTLINE });
    });
    assert.equal(chosen.code, lobby.code);
    assert.equal(chosen.mapId, MAP_IDS.DUSTLINE);

    // The guest joins after the change, and must inherit the host's arena.
    const guestState = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guest never received ROOM_STATE')), 5_000);
      guest.once(EVENTS.ROOM_STATE, (state) => {
        clearTimeout(timer);
        resolve(state);
      });
      guest.emit(EVENTS.JOIN_ROOM, { code: lobby.code, name: 'Guest', mapId: MAP_IDS.SKYBRIDGE });
    });
    assert.equal(guestState.mapId, MAP_IDS.DUSTLINE, 'the join payload cannot steal the arena');

    // Both seats ready, then a single START_GAME: the start payload is the
    // contract every client builds its arena from.
    const startsPromise = Promise.all([host, guest].map((socket) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no GAME_START')), 5_000);
      socket.once(EVENTS.GAME_START, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    })));

    await new Promise((resolve) => {
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(); };
      host.once(EVENTS.ROOM_STATE, done);
      guest.once(EVENTS.ROOM_STATE, done);
      host.emit(EVENTS.PLAYER_READY, { ready: true });
      guest.emit(EVENTS.PLAYER_READY, { ready: true });
    });

    host.emit(EVENTS.START_GAME);
    const [hostStart, guestStart] = await startsPromise;
    assert.equal(hostStart.code, lobby.code);
    assert.equal(hostStart.mapId, MAP_IDS.DUSTLINE);
    assert.equal(hostStart.mapName, getMap(MAP_IDS.DUSTLINE).name);
    assert.equal(guestStart.mapId, hostStart.mapId, 'every client starts on the same arena');
  } finally {
    host.close();
    guest.close();
    await server.close();
  }
});

test('PLAY_NOW with no map id lands on the default arena', async () => {
  const { io: ioClient } = await import('socket.io-client');
  const { createGameServer } = await import('../server/index.js');
  const server = createGameServer({ profileStore: createMemoryProfileStore() });
  const port = await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => resolve(server.httpServer.address().port));
  });

  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['polling'], reconnection: false, timeout: 5_000,
  });
  try {
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no GAME_START')), 5_000);
      socket.once('connect', () => socket.emit(EVENTS.PLAY_NOW, { name: 'Solo' }));
      socket.once(EVENTS.GAME_START, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    assert.equal(started.mapId, DEFAULT_MAP_ID);
    assert.equal(started.mapName, getMap(DEFAULT_MAP_ID).name);
  } finally {
    socket.close();
    await server.close();
  }
});

test('a reconnect keeps the room on the same arena', () => {
  const { io, rooms } = makeManager();
  const host = new FakeSocket('host-a');
  const guest = new FakeSocket('guest-b');
  const room = rooms.createRoom(host, 'Host', { mapId: MAP_IDS.SKYBRIDGE });
  rooms.joinRoom(guest, room.code, 'Guest');

  const token = guest.events.find((entry) => entry.event === EVENTS.ROOM_SESSION)?.data.resumeToken;
  assert.equal(typeof token, 'string', 'the guest received a resume token');

  rooms.handleDisconnect(guest, Date.now());
  assert.equal(room.mapId, MAP_IDS.SKYBRIDGE, 'a disconnect never changes the arena');

  const resumed = new FakeSocket('guest-b-again');
  const after = rooms.resumeRoom(resumed, { roomCode: room.code, resumeToken: token });
  assert.equal(after?.code, room.code);
  assert.equal(room.mapId, MAP_IDS.SKYBRIDGE, 'the resumed seat is on the original arena');
  assert.equal(lastState(io, room.code).mapId, MAP_IDS.SKYBRIDGE);
});

test('GameState simulates the arena the room was created with', async () => {
  const { GameState } = await import('../server/gameState.js');
  const { PLAYER } = await import('../shared/gameConfig.js');
  const { ROOM_MODES } = await import('../shared/events.js');

  for (const mapId of Object.values(MAP_IDS)) {
    const { rooms } = makeManager();
    const socket = new FakeSocket(`solo-${mapId}`);
    const room = rooms.createSoloBotsRoom(socket, 'Solo', { mapId });
    const game = new GameState(room, {}, Date.now());
    const map = getMap(mapId);

    assert.equal(game.mapId, mapId);
    assert.equal(game.map.id, mapId);
    assert.equal(game.cover.length, map.cover.length);

    const insetX = map.bounds.halfWidth - map.bounds.wallThickness / 2 - PLAYER.radius;
    const insetZ = map.bounds.halfDepth - map.bounds.wallThickness / 2 - PLAYER.radius;
    assert.ok(game.players.size > 1, 'bots were spawned alongside the human');
    for (const player of game.players.values()) {
      assert.ok(Math.abs(player.x) <= insetX + 0.001, `${mapId} spawn x inside the walls`);
      assert.ok(Math.abs(player.z) <= insetZ + 0.001, `${mapId} spawn z inside the walls`);
    }

    // Bot navigation is bounded by the same map the client renders.
    for (let step = 0; step < 40; step += 1) {
      game.update(1_000 + step * 100);
      for (const player of game.players.values()) {
        assert.ok(Math.abs(player.x) <= insetX + 0.001, `${mapId} bot x stayed in bounds`);
        assert.ok(Math.abs(player.z) <= insetZ + 0.001, `${mapId} bot z stayed in bounds`);
      }
    }
  }
});
