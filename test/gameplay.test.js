import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENTS, ROOM_STATES } from '../shared/events.js';
import { GameState } from '../server/gameState.js';
import { castShot } from '../server/hitDetection.js';
import { RoomManager } from '../server/rooms.js';

function makeRoom() {
  return {
    code: 'ABC234',
    state: ROOM_STATES.PLAYING,
    players: new Map([
      ['alpha', { id: 'alpha', name: 'Alpha', color: '#57d6ff', ready: true, connectedAt: 1 }],
      ['bravo', { id: 'bravo', name: 'Bravo', color: '#ff657a', ready: true, connectedAt: 2 }],
    ]),
  };
}

function makeGame(now = 1_000_000) {
  const emitted = [];
  const game = new GameState(makeRoom(), {
    emitRoom: (event, data) => emitted.push({ channel: 'room', event, data }),
    emitPlayer: (id, event, data) => emitted.push({ channel: id, event, data }),
  }, now);
  const [shooter, target] = [...game.players.values()];
  shooter.x = 0;
  shooter.y = 0;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  target.x = 0;
  target.y = 0;
  target.z = -5;
  target.spawnProtectionUntil = now - 1;
  return { game, shooter, target, emitted, now };
}

class FakeIO {
  constructor() {
    this.events = [];
  }

  to(room) {
    return { emit: (event, data) => this.events.push({ room, event, data }) };
  }
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.data = {};
    this.events = [];
    this.joined = [];
  }

  join(room) { this.joined.push(room); }
  emit(event, data) { this.events.push({ event, data }); }
}

test('rooms issue unique six-character codes and keep room broadcasts isolated', () => {
  const io = new FakeIO();
  const rooms = new RoomManager(io);
  const hostA = new FakeSocket('host-a');
  const hostB = new FakeSocket('host-b');
  const guestA = new FakeSocket('guest-a');
  const first = rooms.createRoom(hostA, 'Alpha');
  const second = rooms.createRoom(hostB, 'Bravo');

  assert.match(first.code, /^[A-Z2-9]{6}$/);
  assert.notEqual(first.code, second.code);
  assert.deepEqual(hostA.joined, [first.code]);
  rooms.joinRoom(guestA, first.code, 'Guest');
  assert.equal(first.players.size, 2);
  assert.ok(io.events.filter((event) => event.room === first.code).every((event) => event.event === EVENTS.ROOM_STATE));
  assert.equal(io.events.some((event) => event.room === second.code && event.data.players.some((player) => player.id === 'guest-a')), false);

  rooms.setReady(hostA, true);
  rooms.setReady(guestA, true);
  assert.equal(rooms.startGame(hostA).room, first);
  assert.equal(first.state, ROOM_STATES.PLAYING);
  assert.equal(rooms.startGame(hostB).error, 'At least two players are needed to start.');
});

test('server input is bounded and movement is simulated with server time', () => {
  const { game, shooter, now } = makeGame();
  game.setInput(shooter.id, { seq: 1, forward: 5, strafe: 0, jump: false, yaw: 0, pitch: 0 }, now + 1);
  assert.equal(shooter.input.forward, 1);
  game.update(0.05, now + 51);
  assert.ok(Math.abs(shooter.z + 0.36) < 0.0001);

  const previousZ = shooter.z;
  game.setInput(shooter.id, { seq: 2, forward: 1, strafe: 1, yaw: 0, pitch: 3 }, now + 52);
  assert.equal(shooter.pitch, 1.45);
  assert.equal(game.setInput(shooter.id, { seq: 1, forward: -1, yaw: 0 }), undefined);
  assert.equal(shooter.input.forward, 1, 'stale packets cannot replace the latest input');
  game.update(0.05, now + 102);
  assert.notEqual(shooter.z, previousZ);
});

test('headshots deal 50 damage, a kill scores on the server, and respawn restores protection', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  game.shoot(shooter.id, now + 10);
  assert.equal(target.health, 50);
  assert.equal(emitted.find((event) => event.event === EVENTS.HIT_CONFIRMED)?.data.headshot, true);

  game.shoot(shooter.id, now + 160);
  assert.equal(target.alive, false);
  assert.equal(target.health, 0);
  const respawnDeadline = target.respawnAt;
  assert.equal(respawnDeadline, now + 160 + 3_000);
  assert.equal(shooter.kills, 1);
  assert.equal(target.deaths, 1);
  assert.ok(emitted.some((event) => event.event === EVENTS.PLAYER_DIED));
  assert.ok(emitted.some((event) => event.event === EVENTS.KILL_FEED_UPDATE));

  game.update(0.05, target.respawnAt);
  assert.equal(target.alive, true);
  assert.equal(target.health, 100);
  assert.equal(target.respawnAt, null);
  assert.equal(target.spawnProtectionUntil, respawnDeadline + 2_000);
});

test('spawn protection blocks damage and four confirmed body hits eliminate a player', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  target.spawnProtectionUntil = now + 2_000;
  game.shoot(shooter.id, now + 10);
  assert.equal(target.health, 100);
  assert.equal(emitted.find((event) => event.event === EVENTS.HIT_CONFIRMED)?.data.protected, true);

  shooter.pitch = -0.105;
  target.spawnProtectionUntil = now - 1;
  for (const offset of [160, 310, 460, 610]) game.shoot(shooter.id, now + offset);
  assert.equal(target.health, 0);
  assert.equal(target.alive, false);
  assert.equal(shooter.kills, 1);
  assert.ok(emitted.filter((event) => event.event === EVENTS.HIT_CONFIRMED && event.data.damage === 25).length >= 4);
});

test('the thirtieth kill marks the game finished and awards a winner', () => {
  const { game, shooter, target, now } = makeGame();
  shooter.kills = 29;
  shooter.pitch = -0.105;
  target.health = 25;
  game.shoot(shooter.id, now + 10);
  assert.equal(game.finished, true);
  assert.deepEqual(game.winner, { id: shooter.id, name: shooter.name, kills: 30 });
  assert.deepEqual(game.update(0.05, now + 50), { winner: game.winner });
});

test('raycast distinguishes head/body damage zones and blocks shots through cover', () => {
  const players = new Map([
    ['shooter', { id: 'shooter', x: 0, y: 0, z: 0, alive: true }],
    ['target', { id: 'target', x: 0, y: 0, z: -5, alive: true }],
  ]);
  const head = castShot({
    origin: { x: 0, y: 1.53, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    players,
    shooterId: 'shooter',
  });
  assert.equal(head?.headshot, true);

  const body = castShot({
    origin: { x: 0, y: 1.53, z: 0 },
    direction: { x: 0, y: -0.105, z: -1 },
    players,
    shooterId: 'shooter',
  });
  assert.equal(body?.headshot, false);

  const coveredPlayers = new Map([
    ['shooter', { id: 'shooter', x: -17, y: 0, z: 0, alive: true }],
    ['target', { id: 'target', x: -17, y: 0, z: -18, alive: true }],
  ]);
  const blocked = castShot({
    origin: { x: -17, y: 1.53, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    players: coveredPlayers,
    shooterId: 'shooter',
  });
  assert.equal(blocked, null);
});
