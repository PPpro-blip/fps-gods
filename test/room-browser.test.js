import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { PLAYER } from '../shared/gameConfig.js';
import { RoomManager } from '../server/rooms.js';
import { createMemoryProfileStore } from '../server/profiles.js';

class FakeIO {
  constructor() {
    this.broadcasts = [];
  }

  to(room) {
    return { emit: (event, data) => this.broadcasts.push({ room, event, data }) };
  }
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.data = {};
    this.joined = [];
    this.events = [];
  }

  join(room) { this.joined.push(room); }
  emit(event, data) { this.events.push({ event, data }); }
  leave() {}
}

function makeManager() {
  return new RoomManager(new FakeIO(), createMemoryProfileStore());
}

test('the room browser lists public lobbies and never leaks join secrets', () => {
  const rooms = makeManager();
  const host = new FakeSocket('host-a');
  const guest = new FakeSocket('guest-b');
  const solo = new FakeSocket('solo-c');

  const lobby = rooms.createRoom(host, 'Host Alpha');
  rooms.joinRoom(guest, lobby.code, 'Guest Bravo');
  rooms.createSoloBotsRoom(solo, 'Solo Charlie');

  const listing = rooms.listRooms();
  assert.equal(listing.length, 1, 'solo bot rooms must stay private');
  const entry = listing[0];
  assert.equal(entry.code, lobby.code);
  assert.equal(entry.state, ROOM_STATES.LOBBY);
  assert.equal(entry.mode, ROOM_MODES.MULTIPLAYER);
  assert.equal(entry.players, 2);
  assert.equal(entry.maxPlayers, PLAYER.maxPlayers);
  assert.equal(entry.joinable, true);
  assert.equal(entry.hostName, 'Host Alpha');
  assert.ok(entry.ageMs >= 0);

  // Nothing token-shaped or profile-shaped may appear in the public payload.
  const serialized = JSON.stringify(listing);
  for (const secret of ['resumeToken', 'resumeTokenHash', 'profileId', 'lifetimeKills']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be published`);
  }
});

test('a running match is listed but not joinable, and full lobbies are disabled', () => {
  const rooms = makeManager();
  const host = new FakeSocket('host-a');
  const friend = new FakeSocket('friend-b');
  const room = rooms.createRoom(host, 'Host');
  rooms.joinRoom(friend, room.code, 'Friend');
  rooms.setReady(host, true);
  rooms.setReady(friend, true);
  const started = rooms.startGame(host);
  assert.equal(started.room.state, ROOM_STATES.PLAYING);

  const [playing] = rooms.listRooms();
  assert.equal(playing.state, ROOM_STATES.PLAYING);
  assert.equal(playing.joinable, false, 'the server rejects joins once a match starts');

  const fullRooms = makeManager();
  const seed = fullRooms.createRoom(new FakeSocket('host'), 'Host');
  for (let index = 1; index < PLAYER.maxPlayers; index += 1) {
    fullRooms.joinRoom(new FakeSocket(`guest-${index}`), seed.code, `Guest ${index}`);
  }
  const [full] = fullRooms.listRooms();
  assert.equal(full.players, PLAYER.maxPlayers);
  assert.equal(full.joinable, false);
});

test('disconnected seats are counted as seats but not as players', () => {
  const rooms = makeManager();
  const host = new FakeSocket('host-a');
  const guest = new FakeSocket('guest-b');
  const room = rooms.createRoom(host, 'Host');
  rooms.joinRoom(guest, room.code, 'Guest');
  rooms.handleDisconnect(guest, Date.now());

  const [entry] = rooms.listRooms();
  assert.equal(entry.players, 1, 'only connected operators are counted');
  assert.equal(entry.seats, 2, 'the reserved seat is still reported');
  assert.equal(entry.hostName, 'Host');
});

test('the browser asks for the list and receives a token-free ROOM_LIST payload', async () => {
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
  const viewer = await connect();
  try {
    const state = await new Promise((resolve, reject) => {
      host.once(EVENTS.ROOM_STATE, resolve);
      host.once(EVENTS.ROOM_ERROR, (error) => reject(new Error(error.message)));
      host.emit(EVENTS.CREATE_ROOM, { name: 'Browser Host' });
    });

    const listing = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ROOM_LIST within 5s')), 5_000);
      viewer.once(EVENTS.ROOM_LIST, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      viewer.emit(EVENTS.LIST_ROOMS);
    });

    assert.equal(listing.rooms.length, 1);
    assert.equal(listing.rooms[0].code, state.code);
    assert.equal(listing.rooms[0].players, 1);
    assert.equal(typeof listing.now, 'number');
    assert.equal(JSON.stringify(listing).includes('resumeToken'), false);
  } finally {
    host.close();
    viewer.close();
    await server.close();
  }
});
