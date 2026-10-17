import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENTS, ROOM_STATES, ROOM_TYPES } from '../shared/events.js';
import { BOTS, PLAYER } from '../shared/gameConfig.js';
import { GameState } from '../server/gameState.js';
import { castShot, hasLineOfSight } from '../server/hitDetection.js';
import { RoomManager } from '../server/rooms.js';

function makeRoom({ bots = 0, code = 'ABC234' } = {}) {
  const players = new Map([
    ['alpha', {
      id: 'alpha', name: 'Alpha', color: '#57d6ff', ready: true, connectedAt: 1,
      isBot: false, bundleId: 'ghost',
    }],
    ['bravo', {
      id: 'bravo', name: 'Bravo', color: '#ff657a', ready: true, connectedAt: 2,
      isBot: false, bundleId: 'ghost',
    }],
  ]);
  for (let index = 0; index < bots; index += 1) {
    const id = `bot-${index + 1}`;
    players.set(id, {
      id,
      name: `${BOTS.namePrefix}${String(index + 1).padStart(2, '0')}`,
      color: '#ffc857',
      ready: true,
      connectedAt: 3 + index,
      isBot: true,
      bundleId: 'ghost',
    });
  }
  return {
    code,
    type: bots > 0 ? ROOM_TYPES.SOLO_VS_BOTS : ROOM_TYPES.MULTIPLAYER,
    state: ROOM_STATES.PLAYING,
    players,
  };
}

function makeGame(now = 1_000_000, options = {}) {
  const emitted = [];
  const game = new GameState(makeRoom(options), {
    emitRoom: (event, data) => emitted.push({ channel: 'room', event, data }),
    emitPlayer: (id, event, data) => emitted.push({ channel: id, event, data }),
  }, now);
  const [shooter, target] = [...game.players.values()];
  shooter.x = 0;
  shooter.y = 0;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.spawnProtectionUntil = now - 1;
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
  const first = rooms.createRoom(hostA, 'Alpha', 'rusher');
  const second = rooms.createRoom(hostB, 'Bravo', 'ghost');

  assert.match(first.code, /^[A-Z2-9]{6}$/);
  assert.notEqual(first.code, second.code);
  assert.deepEqual(hostA.joined, [first.code]);
  rooms.joinRoom(guestA, first.code, 'Guest', 'heavy');
  assert.equal(first.players.size, 2);
  assert.ok(io.events.filter((event) => event.room === first.code).every((event) => event.event === EVENTS.ROOM_STATE));
  assert.equal(io.events.some((event) => event.room === second.code && event.data.players.some((player) => player.id === 'guest-a')), false);

  rooms.setReady(hostA, true);
  rooms.setReady(guestA, true);
  assert.equal(rooms.startGame(hostA).room, first);
  assert.equal(first.state, ROOM_STATES.PLAYING);
  assert.equal(rooms.startGame(hostB).error, 'At least two players are needed to start.');
});

test('PLAY NOW drops into a private SOLO_VS_BOTS room with five named bots', () => {
  const io = new FakeIO();
  const rooms = new RoomManager(io);
  const solo = new FakeSocket('solo-hero');
  const result = rooms.playSolo(solo, 'Ranger', 'rusher', 12);
  const room = result.room;

  assert.equal(room.type, ROOM_TYPES.SOLO_VS_BOTS);
  assert.equal(room.state, ROOM_STATES.PLAYING);
  assert.equal(room.players.size, 1 + BOTS.count);

  const bots = [...room.players.values()].filter((player) => player.isBot);
  assert.equal(bots.length, 5);
  assert.deepEqual(bots.map((bot) => bot.name), [
    'GOD_BOT_01', 'GOD_BOT_02', 'GOD_BOT_03', 'GOD_BOT_04', 'GOD_BOT_05',
  ]);

  // Solo matches are private: nobody can join with the code.
  const intruder = new FakeSocket('intruder');
  rooms.joinRoom(intruder, room.code, 'Sneak', 'rusher');
  assert.ok(intruder.events.some((event) => event.event === EVENTS.ROOM_ERROR));
});

test('GODS TIER is rejected below 30 lifetime kills and accepted after', () => {
  const io = new FakeIO();
  const rooms = new RoomManager(io);
  const poor = new FakeSocket('poor');
  rooms.createRoom(poor, 'Newblood', 'gods', 29);
  assert.ok(poor.events.some((event) => event.event === EVENTS.ROOM_ERROR));
  assert.equal(rooms.rooms.size, 0);

  const rich = new FakeSocket('rich');
  const room = rooms.createRoom(rich, 'Veteran', 'gods', 30);
  assert.equal(room.players.get('rich').bundleId, 'gods');
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

test('pistol headshots deal 50, a kill scores on the server, and respawn restores protection', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  assert.equal(game.getActiveSlot(shooter).weaponId, 'pistol');
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

test('body shots deal 25 and spawn protection absorbs the first volley', () => {
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
  assert.deepEqual(game.winner, { id: shooter.id, name: shooter.name, kills: 30, isBot: false });
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

test('the railgun pierces walls and players along the beam', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  shooter.bundleId = 'gods';
  shooter.slots = [
    { weaponId: 'railgun', ammo: 4, reloadUntil: null, nextShotAt: now },
    { weaponId: 'minigun', ammo: Infinity, reloadUntil: null, nextShotAt: now },
    { weaponId: 'fist', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  shooter.x = -17;
  shooter.pitch = -0.05;
  target.x = -17;
  target.z = -18;
  game.shoot(shooter.id, now + 10);

  const hit = emitted.find((event) => event.event === EVENTS.HIT_CONFIRMED && event.channel === shooter.id)?.data;
  assert.equal(hit.hit, true);
  assert.equal(hit.targetId, target.id);
  assert.equal(hit.headshot, false);
  assert.equal(target.health, 100 - 85, 'cover no longer stops the beam');
});

test('sniper headshots kill instantly and body shots leave 40 hp', () => {
  const { game, shooter, target, now } = makeGame();
  game.switchWeapon(shooter.id, 1, now); // ghost: pistol → sniper
  assert.equal(game.getActiveSlot(shooter).weaponId, 'sniper');

  game.shoot(shooter.id, now + 10);
  assert.equal(target.alive, false, 'sniper headshot is a one-shot');
  assert.equal(shooter.kills, 1);

  const respawnAt = target.respawnAt;
  game.update(0.05, respawnAt);
  target.x = 0;
  target.y = 0;
  target.z = -5;
  target.spawnProtectionUntil = now - 1;
  shooter.pitch = -0.105;
  game.shoot(shooter.id, respawnAt + 1_400);
  assert.equal(target.health, 100 - 60, 'sniper body shot deals 60');
});

test('the knife is an instant-kill melee and the god fist knocks back', () => {
  const { game, shooter, target, now } = makeGame();
  shooter.bundleId = 'rusher';
  shooter.slots = [
    { weaponId: 'smg', ammo: 30, reloadUntil: null, nextShotAt: now },
    { weaponId: 'shotgun', ammo: 6, reloadUntil: null, nextShotAt: now },
    { weaponId: 'knife', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  game.switchWeapon(shooter.id, 2, now);
  target.z = -1.6;
  game.shoot(shooter.id, now + 10);
  assert.equal(target.alive, false, 'knife is instant kill');
  assert.equal(shooter.kills, 1);

  const respawnAt = target.respawnAt;
  game.update(0.05, respawnAt);
  target.spawnProtectionUntil = now - 1;
  shooter.bundleId = 'gods';
  shooter.slots = [
    { weaponId: 'railgun', ammo: 4, reloadUntil: null, nextShotAt: now },
    { weaponId: 'minigun', ammo: Infinity, reloadUntil: null, nextShotAt: now },
    { weaponId: 'fist', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  game.switchWeapon(shooter.id, 2, respawnAt);
  shooter.x = 0;
  shooter.z = 0;
  target.x = 0;
  target.z = -1.8;
  game.shoot(shooter.id, respawnAt + 500);
  assert.equal(target.alive, false, 'god fist is instant kill');
  assert.notEqual(target.z, -1.8, 'huge knockback displaces the victim');
  assert.ok(Math.abs(target.z) > 5, 'the body flies across the arena');
});

test('rockets splash anyone near the blast, including bystanders', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  shooter.bundleId = 'heavy';
  shooter.slots = [
    { weaponId: 'lmg', ammo: 60, reloadUntil: null, nextShotAt: now },
    { weaponId: 'rocket', ammo: 2, reloadUntil: null, nextShotAt: now },
    { weaponId: 'shield', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  game.switchWeapon(shooter.id, 1, now);

  const bystander = {
    id: 'bystander', name: 'Bystander', color: '#6be6a8', ready: true, connectedAt: 4,
    isBot: false, bundleId: 'heavy',
  };
  game.players.set('bystander', {
    ...bystander,
    ...{
      x: 1.6, y: 0, z: -4, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
      health: PLAYER.maxHealth, kills: 0, deaths: 0, alive: true, grounded: true,
      input: { forward: 0, strafe: 0, jump: false }, lastInputAt: now, lastInputSequence: -1,
      wasJumping: false, spawnProtectionUntil: now - 1, respawnAt: null,
      slot: 0,
      slots: [
        { weaponId: 'lmg', ammo: 60, reloadUntil: null, nextShotAt: now },
        { weaponId: 'rocket', ammo: 2, reloadUntil: null, nextShotAt: now },
        { weaponId: 'shield', ammo: 0, reloadUntil: null, nextShotAt: now },
      ],
      heat: 0, overheatedUntil: null, lastHeatShotAt: 0,
    },
  });

  game.shoot(shooter.id, now + 10);
  assert.equal(game.projectiles.length, 1, 'rocket flies as a server projectile');

  let time = now + 60;
  for (let step = 0; step < 20 && game.projectiles.length > 0; step += 1) {
    time += 50;
    game.update(0.05, time);
  }
  assert.equal(game.projectiles.length, 0, 'rocket detonates on contact');
  assert.ok(target.health < 100, 'direct target takes splash damage');
  assert.ok(game.players.get('bystander').health < 100, 'bystander takes falloff damage');
  assert.ok(emitted.some((event) => event.event === EVENTS.HIT_CONFIRMED && event.data.splash));
});

test('the combat shield blocks frontal hitscan but not back shots', () => {
  const { game, shooter, target, emitted, now } = makeGame();
  target.bundleId = 'heavy';
  target.slots = [
    { weaponId: 'lmg', ammo: 60, reloadUntil: null, nextShotAt: now },
    { weaponId: 'rocket', ammo: 2, reloadUntil: null, nextShotAt: now },
    { weaponId: 'shield', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  game.switchWeapon(target.id, 2, now);
  assert.equal(game.getPublicState(now).players.find((p) => p.id === target.id).shieldActive, true);

  // Target at z=-5, shooter at the origin: facing +Z (yaw = π) is "frontal".
  target.yaw = Math.PI;
  game.shoot(shooter.id, now + 10);
  assert.equal(target.health, 100, 'frontal hitscan is blocked');
  assert.ok(
    emitted.some((event) => event.event === EVENTS.HIT_CONFIRMED && event.data.blocked === true),
    'the shooter sees a BLOCKED marker',
  );

  target.yaw = 0; // turned around, shield useless
  shooter.pitch = -0.105;
  game.getActiveSlot(shooter).nextShotAt = now + 160;
  game.shoot(shooter.id, now + 170);
  assert.equal(target.health, 75, 'back shots land');
});

test('the minigun overheats after 5 seconds of continuous fire', () => {
  const { game, shooter, now } = makeGame();
  shooter.bundleId = 'gods';
  shooter.slots = [
    { weaponId: 'railgun', ammo: 4, reloadUntil: null, nextShotAt: now },
    { weaponId: 'minigun', ammo: Infinity, reloadUntil: null, nextShotAt: now },
    { weaponId: 'fist', ammo: 0, reloadUntil: null, nextShotAt: now },
  ];
  game.switchWeapon(shooter.id, 1, now);

  for (let elapsed = 10; elapsed <= 7_000; elapsed += 55) {
    game.shoot(shooter.id, now + elapsed);
  }
  assert.ok(shooter.overheatedUntil !== null, 'barrel eventually overheats');
  assert.ok(shooter.overheatedUntil > now + 7_000, 'cooldown outlasts the test window');

  const blockedAt = now + 7_100;
  game.getActiveSlot(shooter).nextShotAt = now;
  game.shoot(shooter.id, blockedAt);
  assert.equal(game.getActiveSlot(shooter).nextShotAt, now, 'no shots while overheated');
});

test('weapon switches sync the active weapon into the public state', () => {
  const { game, shooter, now } = makeGame();
  game.switchWeapon(shooter.id, 1, now);
  const state = game.getPublicState(now);
  const me = state.players.find((player) => player.id === shooter.id);
  assert.equal(me.weaponId, 'sniper');
  assert.equal(me.slot, 1);
  assert.equal(me.bundleId, 'ghost');

  game.switchWeapon(shooter.id, 99, now + 1);
  assert.equal(game.getActiveSlot(shooter).weaponId, 'sniper', 'out-of-range slots are ignored');
});

test('the pistol empties its magazine and reloads server-side', () => {
  const { game, shooter, target, now } = makeGame();
  shooter.pitch = -0.105;
  target.health = 1_000_000;
  target.maxHealth = 1_000_000;
  for (let shot = 0; shot < 12; shot += 1) {
    game.shoot(shooter.id, now + 10 + shot * 160);
  }
  const slot = game.getActiveSlot(shooter);
  assert.equal(slot.ammo, 0);
  assert.ok(slot.reloadUntil !== null, 'empty mag triggers the reload');

  game.update(0.05, slot.reloadUntil);
  assert.equal(slot.ammo, 12, 'reload restores the magazine');
});

test('smoke grenades deploy a server cloud that blocks line of sight', () => {
  const { game, shooter, now } = makeGame();
  game.switchWeapon(shooter.id, 2, now); // smoke
  shooter.pitch = -0.12;
  game.shoot(shooter.id, now + 10);
  assert.equal(game.projectiles.length, 1);

  let time = now + 60;
  for (let step = 0; step < 30 && game.projectiles.length > 0; step += 1) {
    time += 50;
    game.update(0.05, time);
  }
  assert.equal(game.smokes.length, 1, 'grenade lands and deploys smoke');
  assert.ok(game.smokes[0].radius > 3);

  const eye = { x: 0, y: 1.53, z: 0 };
  const far = { x: 0, y: 1.53, z: -20 };
  assert.equal(hasLineOfSight(eye, far, []), true);
  game.smokes[0].x = 0;
  game.smokes[0].z = -10;
  game.smokes[0].y = 1.4;
  assert.equal(hasLineOfSight(eye, far, game.smokes), false, 'smoke blinds the sightline');

  game.update(0.05, game.smokes[0].expiresAt + 1);
  assert.equal(game.smokes.length, 0, 'clouds expire');
});

test('bots path, face the nearest human and fire through the shared shoot pipeline', () => {
  const { game, shooter, target, emitted, now } = makeGame(1_000_000, { bots: 2 });
  const bots = [...game.players.values()].filter((player) => player.isBot);
  assert.equal(bots.length, 2);
  assert.ok(game.bots, 'bot controller exists');

  const bot = bots[0];
  bot.x = 4.2;
  bot.z = -2.2;
  bot.spawnProtectionUntil = now - 1;
  shooter.alive = false; // only 'bravo' (target) is a live human
  target.spawnProtectionUntil = now - 1;

  const originalRandom = Math.random;
  Math.random = () => 0.9; // never the 30% deliberate miss
  try {
    for (let tick = 0; tick < 30; tick += 1) {
      game.update(0.1, now + tick * 100);
    }
  } finally {
    Math.random = originalRandom;
  }

  assert.notEqual(bot.yaw, 0, 'bot rotates toward the human');
  assert.ok(
    Math.abs(bot.input.forward) > 0 || Math.abs(bot.input.strafe) > 0,
    'bot walks its waypoints',
  );
  assert.ok(
    emitted.some((event) => event.event === EVENTS.HIT_CONFIRMED && event.channel === bot.id && event.data.hit),
    'bot damage flows through HIT_CONFIRMED like a human',
  );
  assert.equal(target.alive, false, 'bot guns down the stationary human');
  const scoreboard = game.getScoreboard();
  const botRows = scoreboard.filter((row) => row.isBot);
  assert.equal(botRows.length, 2);
  assert.ok(botRows.reduce((sum, row) => sum + row.kills, 0) >= 1, 'bots score the kill');
});

test('bots respawn after three seconds like real players', () => {
  const { game, target, now } = makeGame(1_000_000, { bots: 1 });
  const bot = [...game.players.values()].find((player) => player.isBot);
  game.killPlayer(target, bot, false, now + 10, 'pistol');
  assert.equal(bot.alive, false);
  assert.equal(bot.respawnAt, now + 10 + 3_000);

  game.update(0.05, bot.respawnAt);
  assert.equal(bot.alive, true);
  assert.equal(bot.health, PLAYER.maxHealth);
});
