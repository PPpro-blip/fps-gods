import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildAnimationSet, CharacterRig } from '../client/animation.js';
import { createOperator } from '../client/operator.js';
import { COMBAT_HITBOXES } from '../shared/combatHitboxes.js';
import { PLAYER } from '../shared/gameConfig.js';
import { castShot } from '../server/hitDetection.js';
import { GameState } from '../server/gameState.js';
import { EVENTS, ROOM_STATES } from '../shared/events.js';

function shot(x, y, target, opts = {}) {
  return castShot({ origin: { x, y, z: 0 }, direction: { x: 0, y: 0, z: -1 }, players: new Map([[target.id, target]]), shooterId: 'me', maxDistance: 140, cover: [], ...opts });
}

test('torso edge, miss, head precision, distance, yaw and jump offsets', () => {
  const t = { id: 'target', x: 0, y: 0, z: -10, yaw: 2, alive: true, connected: true };
  assert.equal(PLAYER.radius, 0.38, 'movement collider unchanged');
  assert.equal(shot(0.41, 1.2, t)?.headshot, false);
  assert.equal(shot(0.421, 1.2, t), null);
  assert.equal(shot(0.25, 1.65, t)?.headshot, true);
  assert.equal(shot(0.261, 1.65, t), null);
  assert.equal(shot(0.37, 0.4, t)?.headshot, false);
  assert.equal(shot(0.381, 0.4, t), null);
  assert.equal(shot(0, 1.48, t)?.headshot, false);
  assert.equal(shot(0, 1.5, t)?.headshot, true);
  t.z = -80; assert.equal(shot(0.41, 1.2, t)?.target, t);
  t.x = 2; t.y = 0.8; t.z = -8;
  assert.equal(shot(2.41, 2.0, t)?.headshot, false);
  assert.equal(shot(2, 2.45, t)?.headshot, true);
  assert.equal(shot(0, 1.2, t), null);
  t.alive = false; assert.equal(shot(2, 2, t), null);
  t.alive = true; t.connected = false; assert.equal(shot(2, 2, t), null);
});

test('cover occludes hits and enlarged volume cannot protrude through a wall', () => {
  const target = { id: 't', x: 0, y: 0, z: -5, alive: true };
  const wall = { x: 0, z: -4.5, width: 2, depth: 0.2, height: 3 };
  assert.equal(shot(0, 1.2, target, { cover: [wall] }), null);
  assert.equal(shot(0, 1.2, target, { cover: [wall], ignoreCover: true })?.target, target);
  // The centre is 0.38m beyond this wall: movement collision is clear,
  // but the 0.42m torso extends 0.04m through it and is met before the wall.
  const nearWall = { x: 0, z: -4.61, width: 2, depth: 0.02, height: 3 };
  assert.equal(shot(0, 1.2, target, { cover: [] })?.target, target);
  assert.equal(shot(0, 1.2, target, { cover: [nearWall] }), null);
});

test('shipped model, bind bones and animated head remain within the combat body envelope', async () => {
  const b = readFileSync('client/assets/characters/character.glb');
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', resolve, reject));
  const animationSet = buildAnimationSet(gltf.scene, gltf.animations);
  const rig = new CharacterRig(gltf.scene, animationSet);
  const operator = createOperator(rig);
  const head = rig.getBone('mixamorigHead');
  assert.ok(head);
  for (const state of ['idle', 'walk', 'run', 'jump']) {
    rig.setState(state, { fade: 0 });
    for (let i = 0; i < 15; i++) {
      rig.update(0.1); operator.group.updateMatrixWorld(true);
      const p = head.getWorldPosition(new THREE.Vector3());
      assert.ok(COMBAT_HITBOXES.some(v => p.y >= v.bottom && p.y <= v.top && Math.hypot(p.x, p.z) <= v.radius), `${state} head point ${p.toArray()} must lie in a combat volume`);
    }
  }
  operator.dispose();
});

test('server deduplicates identified shots; confirmed hits alone trigger combat intelligence', () => {
  const records = ['a', 'b'].map(id => [id, { id, name: id, bundleId: 'GHOST', connected: true }]);
  const events = [];
  const game = new GameState({ code: 'TEST', state: ROOM_STATES.PLAYING, players: new Map(records) }, { emitPlayer: (id, event, data) => events.push({ id, event, data }) }, 1000);
  const a = game.players.get('a'), b = game.players.get('b');
  Object.assign(a, { x: 0, y: 0, z: 0, yaw: 0, pitch: -0.07 });
  Object.assign(b, { x: 0, y: 0, z: -5, spawnProtectionUntil: 0 });
  game.cover = [];
  const random = Math.random; Math.random = () => 0.5;
  try {
    game.shoot('a', 2000, 41);
    const health = b.health;
    assert.ok(health < 100);
    assert.equal(events.filter(e => e.event === EVENTS.HIT_CONFIRMED && e.data.hit).length, 1);
    assert.equal(events.filter(e => e.event === EVENTS.OPPONENT_HEALTH).length, 1);
    game.shoot('a', 3000, 41);
    assert.equal(b.health, health);
    assert.equal(events.filter(e => e.event === EVENTS.HIT_CONFIRMED && e.data.hit).length, 1);
    b.x = 5;
    game.shoot('a', 4000, 42);
    assert.equal(events.filter(e => e.event === EVENTS.HIT_CONFIRMED && !e.data.hit).length, 1);
    assert.equal(events.filter(e => e.event === EVENTS.OPPONENT_HEALTH).length, 1);
    b.alive = false; b.x = 0;
    assert.equal(shot(0, 1.2, b), null);
    game.respawn(b, 5000);
    b.x = 0; b.y = 1; b.z = -5;
    assert.equal(shot(0, 2.2, b)?.target, b);
  } finally { Math.random = random; }
});

test('dev traces report actual player, cover and miss endpoints and production disables them', () => {
  const t = { id: 't', x: 0, y: 0, z: -5, alive: true };
  let trace;
  shot(0, 1.2, t, { onTrace: t => { trace = t; } });
  assert.equal(trace.kind, 'player'); assert.equal(trace.targetId, 't');
  shot(0, 1.2, t, { cover: [{ x: 0, z: -2, width: 2, depth: 1, height: 3 }], onTrace: t => { trace = t; } });
  assert.equal(trace.kind, 'cover'); assert.equal(trace.point.z, -1.5);
  shot(2, 1.2, t, { onTrace: t => { trace = t; } });
  assert.equal(trace.kind, 'miss'); assert.equal(trace.point.z, -140);
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const g = new GameState({ code: 'TEST', state: ROOM_STATES.PLAYING, players: new Map() }, { debugHitboxes: true });
    assert.equal(g.debugHitboxes, false);
    process.env.NODE_ENV = 'development';
    const dev = new GameState({ code: 'TEST', state: ROOM_STATES.PLAYING, players: new Map() }, { debugHitboxes: true });
    assert.equal(dev.debugHitboxes, true);
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});

test('human and bot shots use the same moving/jumping hit volumes and pellets aggregate once', () => {
  const room = { code: 'TEST', state: ROOM_STATES.PLAYING, players: new Map([
    ['human', { id: 'human', name: 'Human', bundleId: 'GHOST', connected: true }],
    ['bot', { id: 'bot', name: 'Bot', bundleId: 'GHOST', connected: true, isBot: true }],
  ]) };
  const events = [];
  const game = new GameState(room, { emitPlayer: (id, event, data) => events.push({ id, event, data }) }, 1000);
  const human = game.players.get('human'), bot = game.players.get('bot');
  Object.assign(human, { x: 0, y: 0.7, z: -10, spawnProtectionUntil: 0 });
  Object.assign(bot, { x: 0.4, y: 0.7, z: -5, spawnProtectionUntil: 0 });
  game.cover = [];
  const shotgun = { id: 'TEST', damage: 10, headshotMultiplier: 2, pellets: 3, spread: 0, range: 100 };
  game.fireHitscan(human, shotgun, { x: 0, y: 1.9, z: 0 }, { x: 0, y: 0, z: -1 }, game.players, 2000);
  assert.equal(bot.health, 70);
  assert.equal(events.filter(e => e.id === 'human' && e.event === EVENTS.HIT_CONFIRMED).length, 1);
  events.length = 0;
  // Server's bot path uses the identical raycast against human players.
  game.fireHitscan(bot, { ...shotgun, pellets: 1 }, { x: 0.4, y: 1.9, z: 0 }, { x: 0, y: 0, z: -1 }, new Map([['human', human]]), 2100);
  assert.equal(human.health, 90);
  assert.equal(events.find(e => e.id === 'bot' && e.event === EVENTS.HIT_CONFIRMED).data.hit, true);
  human.x = 2; // authoritative moved target, not an arbitrary client hit claim
  game.fireHitscan(bot, { ...shotgun, pellets: 1 }, { x: 0.4, y: 1.9, z: 0 }, { x: 0, y: 0, z: -1 }, new Map([['human', human]]), 2200);
  assert.equal(human.health, 90);
});

test('development-only shot traces go only to the shooter with server poses', () => {
  const old = process.env.NODE_ENV; process.env.NODE_ENV = 'development';
  try {
    const events = [];
    const players = new Map(['a', 'b'].map(id => [id, { id, name: id, bundleId: 'GHOST', connected: true }]));
    const game = new GameState({ code: 'TEST', state: ROOM_STATES.PLAYING, players }, { debugHitboxes: true, emitPlayer: (id, event, data) => events.push({ id, event, data }) }, 0);
    const a = game.players.get('a'), b = game.players.get('b');
    Object.assign(b, { x: 0, y: 0, z: -5, spawnProtectionUntil: 0 });
    game.cover = [];
    game.fireHitscan(a, { id: 'T', damage: 10, range: 20, spread: 0 }, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, game.players, 100);
    const trace = events.filter(e => e.event === EVENTS.HITBOX_TRACE);
    assert.equal(trace.length, 1);
    assert.equal(trace[0].id, 'a');
    assert.equal(trace[0].data.traces[0].kind, 'player');
    assert.equal(trace[0].data.players.find(p => p.id === 'b').z, -5);
    assert.equal('health' in trace[0].data.players[0], false);
  } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});

test('development visualization follows snapshots, freezes shot poses, expires traces and cleans up', async () => {
  const { JSDOM } = await import('jsdom');
  const { HitboxDebug } = await import('../client/hitboxDebug.js');
  const dom = new JSDOM('<body></body>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const scene = new THREE.Scene();
    const debug = new HitboxDebug(scene);
    const player = { id: 'b', x: 1, y: 0, z: -5, alive: true };
    debug.observe([player], 'a', 100);
    assert.equal(debug.boxes.get('b').position.x, 1);
    const traces = Array.from({ length: 16 }, () => ({ origin: { x: 0, y: 1, z: 0 }, point: { x: 1, y: 1, z: -5 }, kind: 'player' }));
    debug.trace({ players: [{ ...player, x: 2 }], traces }, 'a', 100);
    debug.observe([{ ...player, x: 3 }], 'a', 200);
    assert.equal(debug.boxes.get('b').position.x, 2);
    for (let i = 0; i < 5; i++) debug.trace({ players: [player], traces }, 'a', 200);
    assert.equal(debug.traces.length, 32);
    debug.update(1800);
    assert.equal(debug.traces.length, 0);
    debug.observe([{ ...player, alive: false }], 'a', 2000);
    assert.equal(debug.boxes.size, 0);
    debug.dispose();
    assert.equal(scene.children.length, 0);
    assert.equal(document.body.children.length, 0);
  } finally { globalThis.document = previous; dom.window.close(); }
});
