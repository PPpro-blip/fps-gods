import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { BUNDLE_UNLOCK_KILLS } from '../shared/bundles.js';
import { BOT, PLAYER } from '../shared/gameConfig.js';
import { BUNDLE_LOADOUTS, WEAPONS } from '../server/weaponConfig.js';
import { createMemoryProfileStore, PlayerProfileStore } from '../server/profiles.js';
import { GameState } from '../server/gameState.js';
import { castShot } from '../server/hitDetection.js';
import { ROOM_RECONNECT_GRACE_MS, RoomManager } from '../server/rooms.js';

function makeRoom() {
  return {
    code: 'ABC234',
    state: ROOM_STATES.PLAYING,
    players: new Map([
      ['alpha', { id: 'alpha', name: 'Alpha', color: '#57d6ff', ready: true, bundleId: 'GHOST', profileId: 'profile-alpha', connectedAt: 1 }],
      ['bravo', { id: 'bravo', name: 'Bravo', color: '#ff657a', ready: true, bundleId: 'GHOST', profileId: 'profile-bravo', connectedAt: 2 }],
    ]),
  };
}

function makeGame(now = 1_000_000, shooterBundle = 'GHOST', targetBundle = 'GHOST', onHumanKill = () => null) {
  const room = makeRoom();
  room.players.get('alpha').bundleId = shooterBundle;
  room.players.get('bravo').bundleId = targetBundle;
  const emitted = [];
  const game = new GameState(room, {
    emitRoom: (event, data) => emitted.push({ channel: 'room', event, data }),
    emitPlayer: (id, event, data) => emitted.push({ channel: id, event, data }),
    onHumanKill,
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

test('disconnected lobby players reserve their room briefly before cleanup', () => {
  const io = new FakeIO();
  const rooms = new RoomManager(io);
  const host = new FakeSocket('reconnecting-host');
  const room = rooms.createRoom(host, 'ReconnectHost');
  const session = host.events.find((event) => event.event === EVENTS.ROOM_SESSION)?.data;
  assert.ok(session?.resumeToken);

  rooms.handleDisconnect(host, 10_000);
  assert.equal(room.players.get(host.id).connected, false);
  assert.equal(rooms.rooms.get(room.code), room);
  rooms.expireDisconnectedPlayers(10_000 + ROOM_RECONNECT_GRACE_MS);
  assert.equal(rooms.rooms.get(room.code), room, 'the resume window includes the exact grace boundary');
  rooms.expireDisconnectedPlayers(10_001 + ROOM_RECONNECT_GRACE_MS);
  assert.equal(rooms.rooms.has(room.code), false);
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

test('SOLO_VS_BOTS creates five named bots and runs their movement brain at 10 Hz', () => {
  const now = 1_000_000;
  const room = {
    code: 'BOT234',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.SOLO_VS_BOTS,
    players: new Map([
      ['human', { id: 'human', name: 'Human', color: '#57d6ff', ready: true, connectedAt: 1 }],
    ]),
  };
  const game = new GameState(room, { emitRoom() {}, emitPlayer() {} }, now);
  const human = game.players.get('human');
  const bots = [...game.players.values()].filter((player) => player.isBot);
  const bot = bots[0];

  assert.equal(BOT.count, 5);
  assert.equal(bots.length, 5);
  assert.deepEqual(
    bots.map((player) => player.name),
    ['GOD_BOT_01', 'GOD_BOT_02', 'GOD_BOT_03', 'GOD_BOT_04', 'GOD_BOT_05'],
  );

  human.x = 0;
  human.z = -10;
  bot.x = 0;
  bot.y = 0;
  bot.z = 0;
  bot.yaw = 0;
  bot.botBrain.waypoint = { x: -8, z: 0 };
  bot.botBrain.nextWaypointAt = now + 10_000;

  game.update(0.05, now + 50);
  assert.equal(game.lastBotThinkAt, now, 'bots do not think on the 20 Hz simulation half-tick');
  game.update(0.05, now + 100);
  assert.equal(game.lastBotThinkAt, now + 100);
  assert.ok(Math.abs(bot.yaw) < 0.001, 'the bot faces its nearest human');
  assert.ok(bot.input.strafe < 0, 'the bot strafes toward its patrol waypoint while aiming');
  assert.ok(bot.x < 0, 'the bot moves toward the selected waypoint');
});

test('bot shots use the player hit pipeline and introduce a random offset on 30 percent of shots', () => {
  const now = 1_000_000;
  const room = {
    code: 'BOT234',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.SOLO_VS_BOTS,
    players: new Map([
      ['human', { id: 'human', name: 'Human', color: '#57d6ff', ready: true, connectedAt: 1 }],
    ]),
  };
  const emitted = [];
  const game = new GameState(room, {
    emitRoom: (event, data) => emitted.push({ channel: 'room', event, data }),
    emitPlayer: (id, event, data) => emitted.push({ channel: id, event, data }),
  }, now);
  const human = game.players.get('human');
  const [bot] = [...game.players.values()].filter((player) => player.isBot);
  bot.x = 0;
  bot.y = 0;
  bot.z = 0;
  bot.yaw = 0;
  bot.pitch = 0;
  human.x = 0;
  human.y = 0;
  human.z = -5;
  human.spawnProtectionUntil = now - 1;
  human.health = 1;

  const originalRandom = Math.random;
  try {
    Math.random = () => 0.5;
    game.shoot(bot.id, now + 1);
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(human.alive, false);
  assert.equal(bot.kills, 1);
  assert.ok(emitted.some((event) => event.channel === bot.id && event.event === EVENTS.HIT_CONFIRMED));
  const kill = emitted.find((event) => event.event === EVENTS.KILL_FEED_UPDATE);
  assert.equal(kill?.data.killerName, 'GOD_BOT_01');
  assert.equal(game.getScoreboard().find((player) => player.id === bot.id)?.isBot, true);

  const missGame = new GameState(room, { emitRoom() {}, emitPlayer() {} }, now);
  const missHuman = missGame.players.get('human');
  const missBot = [...missGame.players.values()].find((player) => player.isBot);
  missBot.x = 0;
  missBot.y = 0;
  missBot.z = 0;
  missBot.yaw = 0;
  missBot.pitch = 0;
  missHuman.x = 0;
  missHuman.y = 0;
  missHuman.z = -5;
  missHuman.spawnProtectionUntil = now - 1;
  const randomValues = [0.1, 0.1, 0.5];
  try {
    Math.random = () => randomValues.shift() ?? 0.5;
    missGame.shoot(missBot.id, now + 1);
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(missHuman.health, 100, 'the randomly offset shot misses the target');
});

test('bots respawn three seconds after being eliminated', () => {
  const now = 1_000_000;
  const room = {
    code: 'BOT234',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.SOLO_VS_BOTS,
    players: new Map([
      ['human', { id: 'human', name: 'Human', color: '#57d6ff', ready: true, connectedAt: 1 }],
    ]),
  };
  const game = new GameState(room, { emitRoom() {}, emitPlayer() {} }, now);
  const bot = [...game.players.values()].find((player) => player.isBot);
  bot.alive = false;
  bot.health = 0;
  bot.respawnAt = now + PLAYER.respawnMs;

  game.update(0.05, bot.respawnAt - 1);
  assert.equal(bot.alive, false);
  game.update(0.05, bot.respawnAt);
  assert.equal(bot.alive, true);
  assert.equal(bot.health, 100);
  assert.equal(bot.respawnAt, null);
});

test('each authoritative weapon defines all six server stats and the required magazine sizes', () => {
  const requiredStats = ['damage', 'fireRate', 'magSize', 'reloadTime', 'range', 'spread'];
  const allWeapons = Object.values(BUNDLE_LOADOUTS).flat();
  assert.equal(allWeapons.length, 12);
  for (const weapon of allWeapons) {
    for (const stat of requiredStats) assert.equal(Number.isFinite(weapon[stat]), true, `${weapon.id}.${stat}`);
  }
  assert.equal(WEAPONS.SMG.magSize, 30);
  assert.equal(WEAPONS.LMG.magSize, 60);
  assert.equal(WEAPONS.PISTOL.tracer, false);
  assert.equal(WEAPONS.SNIPER.headshotDamage, PLAYER.maxHealth);
  assert.equal(WEAPONS.RAILGUN.piercesCover, true);
  assert.equal(WEAPONS.MINIGUN.unlimitedAmmo, true);
  assert.equal(WEAPONS.MINIGUN.overheatsAfterMs, 5_000);
});

test('weapon switching is limited to the selected bundle and synchronizes the active weapon', () => {
  const now = 1_000_000;
  const { game, shooter, emitted } = makeGame(now, 'RUSHER', 'GHOST');
  assert.equal(shooter.currentWeaponId, 'SMG');
  assert.equal(shooter.ammo, 30);
  assert.equal(game.switchWeapon(shooter.id, 'SHOTGUN', now + 1), true);
  assert.equal(shooter.currentWeaponId, 'SHOTGUN');
  assert.equal(shooter.ammo, 6);
  assert.equal(shooter.maxAmmo, 6);
  assert.equal(game.switchWeapon(shooter.id, 'PISTOL', now + 2), false);
  const update = emitted.find((event) => event.event === EVENTS.WEAPON_UPDATE);
  assert.equal(update?.data.playerId, shooter.id);
  assert.equal(update?.data.weaponId, 'SHOTGUN');
  const publicPlayer = game.getPublicState(now + 3).players.find((player) => player.id === shooter.id);
  assert.equal(publicPlayer?.currentWeaponId, 'SHOTGUN');
  assert.equal(publicPlayer?.bundleId, 'RUSHER');
});

test('SMG fire rate and ammunition are enforced by the server', () => {
  const now = 1_000_000;
  const { game, shooter, target } = makeGame(now, 'RUSHER', 'GHOST');
  target.spawnProtectionUntil = now - 1;
  game.shoot(shooter.id, now + 1);
  const ammoAfterFirstShot = shooter.ammo;
  game.shoot(shooter.id, now + 50);
  assert.equal(shooter.ammo, ammoAfterFirstShot, 'an early second shot is rejected');
  game.shoot(shooter.id, now + 91);
  assert.equal(shooter.ammo, ammoAfterFirstShot - 1);
});

test('railgun hitscan ignores arena cover while ordinary weapons remain blocked', () => {
  const now = 1_000_000;
  const { game, shooter, target } = makeGame(now, 'GODS_TIER', 'GHOST');
  shooter.x = -17;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  target.x = -17;
  target.z = -18;
  target.spawnProtectionUntil = now - 1;
  assert.ok(game.cover.some((block) => block.id === 0));

  game.shoot(shooter.id, now + 1);
  assert.equal(target.alive, false);
  assert.ok(game.cover.some((block) => block.id === 0), 'the railgun pierces but does not destroy cover');
});

test('rocket splash damages nearby players and destroys the first cover block it hits', () => {
  const now = 1_000_000;
  const { game, shooter, target, emitted } = makeGame(now, 'HEAVY', 'RUSHER');
  shooter.x = -17;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  target.x = -13;
  target.z = -11;
  target.spawnProtectionUntil = now - 1;
  assert.ok(game.cover.some((block) => block.id === 0));
  assert.equal(game.switchWeapon(shooter.id, 'ROCKET', now), true);

  game.shoot(shooter.id, now + 1);
  assert.equal(game.cover.some((block) => block.id === 0), false);
  assert.ok(target.health < PLAYER.maxHealth, 'the explosion applies server-calculated splash damage');
  assert.ok(emitted.some((event) => event.event === EVENTS.COVER_DESTROYED && event.data.blockId === 0));
});

test('combat shield blocks frontal damage and leaves its rear arc vulnerable', () => {
  const now = 1_000_000;
  const { game, shooter, target, emitted } = makeGame(now, 'GHOST', 'HEAVY');
  shooter.x = 0;
  shooter.z = -10;
  shooter.yaw = Math.PI;
  target.x = 0;
  target.z = -5;
  target.yaw = 0;
  target.spawnProtectionUntil = now - 1;
  assert.equal(game.switchWeapon(target.id, 'COMBAT_SHIELD', now), true);

  game.shoot(shooter.id, now + 1);
  assert.equal(target.health, PLAYER.maxHealth);
  assert.ok(emitted.some((event) => event.event === EVENTS.HIT_CONFIRMED && event.data.blockedByShield));

  target.yaw = Math.PI;
  game.shoot(shooter.id, now + 151);
  assert.equal(target.health, 50);
});

test('smoke grenade creates a vision-blocking cloud in the server hit pipeline', () => {
  const now = 1_000_000;
  const { game, shooter, target } = makeGame(now, 'GHOST', 'RUSHER');
  shooter.x = 0;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  target.x = 0;
  target.z = -21.5;
  target.spawnProtectionUntil = now - 1;
  assert.equal(game.switchWeapon(shooter.id, 'SMOKE_GRENADE', now), true);

  game.shoot(shooter.id, now + 1);
  assert.equal(game.smokeClouds.length, 1);
  const blocked = castShot({
    origin: { x: shooter.x, y: shooter.y + 1.53, z: shooter.z },
    direction: { x: 0, y: 0, z: -1 },
    players: game.players,
    shooterId: shooter.id,
    maxDistance: 80,
    cover: game.cover,
    smokeClouds: game.smokeClouds,
  });
  assert.equal(blocked, null);
});

test('minigun has unlimited ammo and overheats after five seconds of continuous server fire', () => {
  const now = 1_000_000;
  const { game, shooter, target, emitted } = makeGame(now, 'GODS_TIER', 'GHOST');
  target.x = 14;
  target.z = -15;
  assert.equal(game.switchWeapon(shooter.id, 'MINIGUN', now), true);
  const firstShotAt = now + 1;
  for (let at = firstShotAt; at < firstShotAt + 5_000; at += WEAPONS.MINIGUN.fireRate) {
    game.shoot(shooter.id, at);
  }
  const overheatAt = firstShotAt + 5_000;
  game.shoot(shooter.id, overheatAt);

  assert.equal(shooter.weaponStates.MINIGUN.overheatedUntil, overheatAt + WEAPONS.MINIGUN.overheatCooldownMs);
  assert.equal(shooter.unlimitedAmmo, true);
  assert.equal(shooter.ammo, 0, 'unlimited ammunition does not use a magazine');
  assert.ok(emitted.some((event) => event.event === EVENTS.WEAPON_OVERHEATED));
});

test('God Fist one-punch kills and applies a large knockback impulse', () => {
  const now = 1_000_000;
  const { game, shooter, target } = makeGame(now, 'GODS_TIER', 'RUSHER');
  shooter.x = 0;
  shooter.z = 0;
  shooter.yaw = 0;
  shooter.pitch = 0;
  target.x = 0;
  target.z = -2;
  target.spawnProtectionUntil = now - 1;
  assert.equal(game.switchWeapon(shooter.id, 'GOD_FIST', now), true);

  game.shoot(shooter.id, now + 1);
  assert.equal(target.alive, false);
  assert.ok(Math.abs(target.knockbackVZ) >= 25);
  const beforeKnockback = target.z;
  game.update(0.05, now + 50);
  assert.ok(target.z < beforeKnockback - 0.5, 'the server integrates the knockback impulse after the kill');
});

test('lifetime kills unlock GODS TIER at thirty and are advanced by server-confirmed kills', () => {
  const profiles = createMemoryProfileStore();
  profiles.getOrCreate('profile-alpha', 'Alpha');
  const now = 1_000_000;
  const { game, shooter, target } = makeGame(
    now,
    'GHOST',
    'GHOST',
    (player) => profiles.recordLifetimeKill(player.profileId),
  );
  target.health = 25;
  target.spawnProtectionUntil = now - 1;
  shooter.pitch = -0.105;
  game.shoot(shooter.id, now + 1);
  assert.equal(shooter.lifetimeKills, 1);
  assert.equal(profiles.snapshot('profile-alpha').lifetimeKills, 1);

  for (let kill = 1; kill < BUNDLE_UNLOCK_KILLS - 1; kill += 1) profiles.recordLifetimeKill('profile-alpha');
  assert.equal(profiles.isBundleUnlocked('profile-alpha', 'GODS_TIER'), false);
  profiles.recordLifetimeKill('profile-alpha');
  assert.equal(profiles.snapshot('profile-alpha').lifetimeKills, BUNDLE_UNLOCK_KILLS);
  assert.equal(profiles.isBundleUnlocked('profile-alpha', 'GODS_TIER'), true);
});

test('lifetime-kill profiles survive a server profile-store reload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fps-gods-profile-test-'));
  const profilePath = join(directory, 'profiles.json');
  try {
    const firstStore = new PlayerProfileStore(profilePath);
    firstStore.getOrCreate('profile-persistent', 'Persistent');
    for (let kill = 0; kill < BUNDLE_UNLOCK_KILLS; kill += 1) firstStore.recordLifetimeKill('profile-persistent');

    const reloadedStore = new PlayerProfileStore(profilePath);
    assert.equal(reloadedStore.snapshot('profile-persistent').lifetimeKills, BUNDLE_UNLOCK_KILLS);
    assert.equal(reloadedStore.isBundleUnlocked('profile-persistent', 'GODS_TIER'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('room server rejects locked GODS TIER selection and accepts it after server profile progression', () => {
  const io = new FakeIO();
  const profiles = createMemoryProfileStore();
  const rooms = new RoomManager(io, profiles);
  const lockedPlayer = new FakeSocket('locked-player');
  const selection = { profileId: 'profile-locked', bundleId: 'GODS_TIER' };

  assert.equal(rooms.createRoom(lockedPlayer, 'Locked', selection), null);
  assert.equal(rooms.rooms.size, 0);
  assert.ok(lockedPlayer.events.some((event) => event.event === EVENTS.ROOM_ERROR));
  for (let kill = 0; kill < BUNDLE_UNLOCK_KILLS; kill += 1) profiles.recordLifetimeKill('profile-locked');

  const unlockedPlayer = new FakeSocket('unlocked-player');
  const room = rooms.createRoom(unlockedPlayer, 'Unlocked', selection);
  assert.equal(room.players.get(unlockedPlayer.id).bundleId, 'GODS_TIER');
  assert.equal(io.events.at(-1).data.players[0].bundleId, 'GODS_TIER');
});
