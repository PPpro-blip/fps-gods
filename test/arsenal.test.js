import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AimController, ADS_PROFILES } from '../client/aim.js';
import { WeaponEffects } from '../client/weapons.js';
import { GameState } from '../server/gameState.js';
import { WEAPONS } from '../server/weaponConfig.js';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';

function makeGame(attackerBundle = 'RUSHER', defenderBundle = 'HEAVY') {
  const now = 100_000;
  const emitted = [];
  const room = {
    code: 'ARS234', mode: ROOM_MODES.MULTIPLAYER, state: ROOM_STATES.PLAYING,
    players: new Map([
      ['a', { id: 'a', name: 'Attacker', connected: true, bundleId: attackerBundle }],
      ['b', { id: 'b', name: 'Defender', connected: true, bundleId: defenderBundle }],
    ]),
  };
  const game = new GameState(room, {
    emitRoom: (event, data) => emitted.push({ event, data }),
    emitPlayer: (id, event, data) => emitted.push({ id, event, data }),
  }, now);
  const attacker = game.players.get('a');
  const defender = game.players.get('b');
  Object.assign(attacker, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  Object.assign(defender, { x: 0, y: 0, z: -2, yaw: 0, pitch: 0, spawnProtectionUntil: now - 1 });
  game.cover = [];
  return { game, attacker, defender, emitted, now };
}

function centeredSpread(fn) {
  const random = Math.random;
  Math.random = () => 0.5;
  try { return fn(); } finally { Math.random = random; }
}

test('knife selection is loadout-validated and one swing has server-enforced range, cooldown and line of sight', () => centeredSpread(() => {
  const { game, attacker, defender, emitted, now } = makeGame();
  assert.equal(game.switchWeapon('a', '__proto__', now), false);
  assert.equal(game.switchWeapon('a', 'ROCKET', now), false);
  assert.equal(game.switchWeapon('a', 'KNIFE', now), true);
  defender.health = 500;
  game.shoot('a', now + 1, 11);
  assert.equal(defender.health, 400);
  game.shoot('a', now + 2, 12);
  assert.equal(defender.health, 400, 'a second packet during the swing cannot do damage');
  assert.equal(emitted.filter((event) => event.event === EVENTS.WEAPON_FIRED && event.data.shotId === 11).length, 1);
  defender.z = -4;
  game.shoot('a', now + 1 + WEAPONS.KNIFE.fireRate);
  assert.equal(defender.health, 400, 'out of range is a miss');
  defender.z = -2;
  game.cover = [{ id: 42, x: 0, z: -0.8, width: 2, depth: 0.2, height: 3 }];
  game.shoot('a', now + 1 + WEAPONS.KNIFE.fireRate * 2);
  assert.equal(defender.health, 400, 'a wall prevents melee damage');
  attacker.alive = false;
  game.shoot('a', now + 1 + WEAPONS.KNIFE.fireRate * 3);
  assert.equal(defender.health, 400, 'dead players cannot attack');
}));

test('rocket ammo and projectile travel, impact and reload are authoritative', () => centeredSpread(() => {
  const { game, attacker, defender, emitted, now } = makeGame('HEAVY', 'RUSHER');
  defender.z = -8;
  assert.equal(game.switchWeapon('a', 'ROCKET', now), true);
  game.shoot('a', now + 1, 3);
  assert.equal(game.projectiles.length, 1);
  assert.equal(attacker.ammo, 0);
  assert.equal(attacker.reloading, true);
  assert.equal(defender.health, 100, 'damage cannot happen at launch');
  game.shoot('a', now + 2, 4);
  assert.equal(game.projectiles.length, 1, 'empty/cooldown shots cannot spawn extra projectiles');
  game.update(0.05, now + 50);
  assert.ok(game.projectiles[0].z < -1 && game.projectiles[0].z > -3, 'rocket moved through space');
  assert.equal(defender.health, 100);
  for (let t = 100; t <= 300; t += 50) game.update(0.05, now + t);
  assert.equal(game.projectiles.length, 0);
  assert.equal(defender.health, 10, 'direct impact damage is server-derived');
  assert.equal(emitted.filter((entry) => entry.event === EVENTS.PROJECTILE_IMPACT).length, 1);
  assert.ok(emitted.some((entry) => entry.event === EVENTS.HIT_CONFIRMED && entry.data.damage === 90));
  game.update(0.05, now + 2_302);
  assert.equal(attacker.ammo, 1);
  assert.equal(attacker.reserveAmmo, 4);
}));

test('missed projectiles expire harmlessly and projectile count is bounded', () => centeredSpread(() => {
  const { game, attacker, emitted, now } = makeGame('HEAVY', 'RUSHER');
  attacker.pitch = 1.2;
  game.switchWeapon('a', 'ROCKET', now);
  game.shoot('a', now + 1);
  game.projectiles[0].expiresAt = now + 51;
  game.update(0.05, now + 100);
  assert.equal(game.projectiles.length, 0);
  assert.equal(emitted.some((entry) => entry.event === EVENTS.PROJECTILE_IMPACT), false);
  assert.ok(emitted.some((entry) => entry.event === EVENTS.HIT_CONFIRMED && entry.data.hit === false));

  attacker.weaponStates.ROCKET.ammo = 1;
  attacker.weaponStates.ROCKET.reloadUntil = null;
  attacker.weaponStates.ROCKET.nextShotAt = now;
  game.projectiles = Array.from({ length: 64 }, (_, i) => ({ id: `fake-${i}` }));
  game.shoot('a', now + 5_000);
  assert.equal(game.projectiles.length, 64);
  assert.equal(attacker.weaponStates.ROCKET.ammo, 1, 'capacity rejection does not consume ammo');
}));

test('blast line of sight prevents damage through intact cover', () => {
  const { game, attacker, defender, now } = makeGame('HEAVY', 'RUSHER');
  game.cover = [{ id: 8, x: 0, z: -1, width: 2, depth: 0.25, height: 3 }];
  game.explodeRocket(
    { id: 'server-projectile', source: { x: 0, y: 1.5, z: 3 } },
    attacker, WEAPONS.ROCKET, { point: { x: 0, y: 1.5, z: 0 } }, now + 1,
  );
  assert.equal(defender.health, 100);
});

test('shield blast direction uses the explosion location rather than the shooter', () => {
  const { game, attacker, defender, emitted, now } = makeGame('RUSHER', 'HEAVY');
  Object.assign(attacker, { x: 0, z: 5 }); // behind the defender
  Object.assign(defender, { x: 0, z: 0, yaw: 0 }); // faces toward -Z
  assert.equal(game.switchWeapon('b', 'COMBAT_SHIELD', now), true);
  game.setInput('b', { seq: 1, blocking: true, yaw: 0 }, now + 1);
  const rocket = { id: 'test-blast', source: { x: 0, y: 1.5, z: 5 } };
  game.explodeRocket(rocket, attacker, WEAPONS.ROCKET, { point: { x: 0, y: 1.5, z: -2 } }, now + 2);
  const frontal = emitted.findLast((entry) => entry.event === EVENTS.HIT_CONFIRMED);
  assert.equal(frontal.data.blockedByShield, true, 'a front-side blast is reduced even if its owner is behind');

  defender.health = 100;
  attacker.z = -5;
  game.explodeRocket(rocket, attacker, WEAPONS.ROCKET, { point: { x: 0, y: 1.5, z: 2 } }, now + 3);
  const rear = emitted.findLast((entry) => entry.event === EVENTS.HIT_CONFIRMED);
  assert.equal(rear.data.blockedByShield, false, 'a rear-side blast is not reduced');
  assert.ok(rear.data.damage > frontal.data.damage);
});

test('shield needs an equipped, fresh and limited-duration block with a release/cooldown', () => {
  const { game, defender, now } = makeGame();
  const shield = WEAPONS.COMBAT_SHIELD;
  game.setInput('b', { seq: 1, blocking: true, yaw: 0 }, now + 1);
  assert.equal(defender.shieldBlocking, false, 'a gun cannot block');
  assert.equal(game.switchWeapon('b', 'COMBAT_SHIELD', now + 2), true);
  game.setInput('b', { seq: 2, blocking: true, yaw: 0 }, now + 3);
  assert.equal(defender.shieldBlocking, true);
  game.setInput('b', { seq: 3, blocking: true, yaw: 0 }, now + 3 + shield.blockDurationMs);
  assert.equal(defender.shieldBlocking, false);
  assert.equal(defender.shieldNeedsRelease, true);
  game.setInput('b', { seq: 4, blocking: true, yaw: 0 }, now + 3 + shield.blockDurationMs + shield.blockCooldownMs + 10);
  assert.equal(defender.shieldBlocking, false, 'holding cannot silently restart after exhaustion');
  game.setInput('b', { seq: 5, blocking: false, yaw: 0 }, now + 3 + shield.blockDurationMs + shield.blockCooldownMs + 11);
  game.setInput('b', { seq: 6, blocking: true, yaw: 0 }, now + 3 + shield.blockDurationMs + shield.blockCooldownMs + 12);
  assert.equal(defender.shieldBlocking, true);
  game.setPlayerConnected('b', false, now + 6_000);
  assert.equal(defender.shieldBlocking, false, 'disconnect lowers the shield');
  game.setPlayerConnected('b', true, now + 6_100);
  game.respawn(defender, now + 7_000);
  assert.equal(defender.shieldBlocking, false);
  assert.equal(defender.shieldNeedsRelease, false);
});

test('ADS is time-based, uses per-weapon offsets, and clears on release or weapon change', () => {
  const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 125);
  const values = [];
  const aim = new AimController(camera, { setAim: (amount, profile) => values.push({ amount, profile }) }, 77);
  aim.setWeapon('SMG');
  aim.setHeld(true);
  for (let frame = 0; frame < 60; frame += 1) aim.update(1 / 60);
  assert.equal(aim.amount, 1);
  assert.ok(Math.abs(camera.fov - ADS_PROFILES.SMG.fov) < 0.1);
  assert.deepEqual(values.at(-1).profile.offset, ADS_PROFILES.SMG.offset);
  aim.reset(true);
  aim.setHeld(true);
  aim.update(0.5);
  assert.equal(aim.amount, 1, 'a slow frame catches up in elapsed time');
  assert.ok(Math.abs(camera.fov - ADS_PROFILES.SMG.fov) < 0.1);
  aim.setHeld(false);
  for (let frame = 0; frame < 60; frame += 1) aim.update(1 / 60);
  assert.equal(aim.amount, 0);
  assert.ok(Math.abs(camera.fov - 77) < 0.1);
  aim.setHeld(true);
  aim.update(0.05);
  aim.setWeapon('KNIFE');
  assert.equal(aim.held, false);
  aim.setHeld(true);
  assert.equal(aim.held, false, 'melee has no ADS');
  aim.setWeapon('COMBAT_SHIELD');
  aim.setHeld(true);
  assert.equal(aim.held, false, 'shield has no ADS');
  assert.equal(ADS_PROFILES.ROCKET.scope, null);
  assert.equal(ADS_PROFILES.SNIPER.scope, null);
  assert.notDeepEqual(ADS_PROFILES.ROCKET.offset, ADS_PROFILES.PISTOL.offset);
  aim.reset(true);
  assert.equal(aim.amount, 0);
});

test('predicted melee presentation and server projectile effects clean up without duplicating shared resources', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const library = {
    getLength: () => 0.5,
    onReady: () => {},
    createModel: (id) => { const group = new THREE.Group(); group.userData.weaponId = id; return group; },
  };
  const effects = new WeaponEffects(scene, camera, library);
  try {
    effects.setWeapon('KNIFE', 'RUSHER', false);
    effects.presentFire(1_000, 'KNIFE', 'RUSHER');
    effects.update(1_130, 0.016);
    assert.ok(Math.abs(effects.viewModel.rotation.z) > 0.2, 'a swing is visible before any hit confirmation');
    assert.equal(effects.tracers.length, 0);
    effects.updateProjectiles([{ id: 'rocket-1', x: 0, y: 1, z: -1, direction: { x: 0, y: 0, z: -1 }, speed: 38 }], 2_000);
    effects.updateProjectiles([{ id: 'rocket-1', x: 0, y: 1, z: -2, direction: { x: 0, y: 0, z: -1 }, speed: 38 }], 2_050);
    assert.equal(effects.projectileMeshes.size, 1);
    effects.showImpact({ id: 'rocket-1', point: { x: 0, y: 1, z: -3 }, radius: 5 }, 2_100);
    assert.equal(effects.projectileMeshes.size, 0);
    assert.equal(effects.impacts.length, 1);
    effects.update(2_400, 0.016);
    assert.equal(effects.impacts.length, 0);
  } finally {
    effects.dispose();
  }
});

test('local shot feedback suppresses only the matching authoritative echo and remains bounded', async () => {
  const { ShotFeedback } = await import('../client/shotFeedback.js');
  const delayed = new ShotFeedback();
  delayed.remember(99, 0);
  delayed.expire(2_500);
  assert.equal(delayed.consume(99), true, 'a delayed own echo is still suppressed');
  const feedback = new ShotFeedback({ ttlMs: 100, limit: 2 });
  feedback.remember(1, 0);
  assert.equal(feedback.consume(1), true);
  assert.equal(feedback.consume(1), false, 'the same echo is consumed once');
  assert.equal(feedback.consume(3), false, 'unpredicted remote or server-only shots still render');
  feedback.remember(2, 1);
  feedback.remember(3, 2);
  feedback.remember(4, 3);
  assert.equal(feedback.consume(2), false, 'the pending set is capped');
  feedback.expire(104);
  assert.equal(feedback.consume(3), false, 'rejected shots expire without a hit');
  assert.equal(feedback.consume(4), false);
  feedback.remember(5, 105);
  feedback.clear();
  assert.equal(feedback.consume(5), false, 'leaving a match discards pending echoes');
});
