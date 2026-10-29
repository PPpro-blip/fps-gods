import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import { AudioEngine } from '../client/audio.js';
import { PlayerController, RemotePlayers, StateInterpolator } from '../client/player.js';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../client/settings.js';
import { WeaponEffects } from '../client/weapons.js';
import { World } from '../client/world.js';
import { GameState } from '../server/gameState.js';
import { ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { MAP_IDS, getMap } from '../shared/maps.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8');

function createMockModelLibrary() {
  return {
    onReady() {},
    getLength: () => 0.62,
    createModel: (weaponId) => {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.14, 0.62),
        new THREE.MeshStandardMaterial({ color: '#4c5b6b' }),
      );
      group.add(mesh);
      group.userData.weaponId = weaponId;
      group.userData.baseScale = group.scale.clone();
      return group;
    },
  };
}

test('Operation Pulse Phase 1: all three arenas build landmarks, structured cover AABBs, animated life, and clean disposal', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);

  for (const mapId of [MAP_IDS.FOUNDRY, MAP_IDS.SKYBRIDGE, MAP_IDS.DUSTLINE]) {
    assert.equal(world.setMap(mapId), true);
    const map = getMap(mapId);

    // Every cover block's structured geometry still matches server collision bounds 1:1.
    assert.equal(world.coverMeshes.size, map.cover.length);
    map.cover.forEach((block, id) => {
      const parts = world.coverMeshes.get(id);
      const box = new THREE.Box3().setFromObject(parts.crate);
      const size = box.getSize(new THREE.Vector3());
      assert.ok(Math.abs(size.x - block.width) < 1e-4, `${mapId} cover ${id} width mismatch`);
      assert.ok(Math.abs(size.y - block.height) < 1e-4, `${mapId} cover ${id} height mismatch`);
      assert.ok(Math.abs(size.z - block.depth) < 1e-4, `${mapId} cover ${id} depth mismatch`);
    });

    // Animated mechanical landmarks & sparse perimeter motes exist and advance smoothly.
    const spinItem = world.animatedItems.find((item) => item.kind === 'spin');
    const moteItem = world.animatedItems.find((item) => item.kind === 'mote');
    assert.ok(spinItem, `${mapId} should include a rotating mechanical/orbital landmark`);
    assert.ok(moteItem, `${mapId} should include sparse perimeter atmospheric motes`);

    // Perimeter motes never sit inside playable arena sightlines.
    const insideBounds = Math.abs(moteItem.baseX) < map.bounds.halfWidth
      && Math.abs(moteItem.baseZ) < map.bounds.halfDepth;
    assert.equal(insideBounds, false, `${mapId} motes must stay outside playable bounds`);

    const beforeSpin = spinItem.object.rotation[spinItem.axis];
    world.update(1_000, 0.05, { reducedMotion: false });
    const fullDeltaSpin = Math.abs(spinItem.object.rotation[spinItem.axis] - beforeSpin);
    assert.ok(fullDeltaSpin > 0.001, `${mapId} landmark rotor should advance on update`);

    const beforeReduced = spinItem.object.rotation[spinItem.axis];
    world.update(1_050, 0.05, { reducedMotion: true });
    const reducedDeltaSpin = Math.abs(spinItem.object.rotation[spinItem.axis] - beforeReduced);
    assert.ok(reducedDeltaSpin < fullDeltaSpin * 0.25, `${mapId} reducedMotion should attenuate world spin`);
  }

  world.dispose();
  assert.equal(scene.children.length, 0, 'World.dispose must leave zero leaked objects in scene');
  assert.equal(world.ownedGeometries.size, 0);
  assert.equal(world.ownedMaterials.size, 0);
});

test('Operation Pulse Phase 2–4: reducedMotion setting, look-delta inertia, pooled shell ejection, and cosmetic cover impacts', () => {
  // 1. SettingsStore supports reducedMotion strictly as a boolean.
  assert.equal(DEFAULT_SETTINGS.reducedMotion, false);
  assert.equal(sanitizeSettings({ reducedMotion: true }).reducedMotion, true);
  assert.equal(sanitizeSettings({ reducedMotion: 'yes' }).reducedMotion, false);
  const store = new SettingsStore({ storage: null });
  store.update({ reducedMotion: true });
  assert.equal(store.get('reducedMotion'), true);

  // 2. WeaponEffects look sway, landing dip, shell casing pool, and cosmetic cover raycast clipping.
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 250);
  camera.position.set(0, 1.62, 0);
  scene.add(camera);
  const effects = new WeaponEffects(scene, camera, createMockModelLibrary());

  const map = getMap(MAP_IDS.FOUNDRY);
  const wallCover = [{
    id: 0,
    x: 0,
    y: 1.5,
    z: -8,
    width: 4,
    height: 3,
    depth: 1,
  }];
  effects.setArenaContext({
    getMap: () => map,
    getCover: () => wallCover,
  });

  // Look inertia & landing compression respond and recover cleanly.
  effects.setMotionState({
    speed: 6.8,
    forward: 1,
    strafe: 1,
    vy: 0,
    grounded: true,
    lookYawDelta: 0.04,
    lookPitchDelta: -0.02,
    reducedMotion: false,
  });
  effects.triggerLanding(6.0);
  assert.ok(effects.landingDip > 0.01);
  assert.ok(Math.abs(effects.lookSwayX) > 0.001);

  // Firing SMG toward cover at z = -8 clips tracer at z = -7.5 (front face of cover), spawns spark & brass shell.
  const now = 5_000;
  effects.fire(
    now,
    'SMG',
    'RUSHER',
    { origin: { x: 0, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: -1 } },
    true,
  );
  assert.equal(effects.shells.length, 1, 'SMG shot should eject one pooled brass shell casing');
  assert.equal(effects.surfaceImpacts.length, 1, 'cover hit should spawn cosmetic surface spark');
  const tracerPos = effects.tracers[0].line.geometry.attributes.position;
  const endZ = tracerPos.getZ(1);
  assert.ok(Math.abs(endZ - (-7.5)) < 0.05, `tracer should clip at cover front face z=-7.5, got ${endZ}`);

  // Knife / Shield never eject shells, and shell/spark pools self-expire cleanly without leaks.
  effects.presentFire(now + 20, 'KNIFE', 'RUSHER');
  assert.equal(effects.shells.length, 1, 'melee weapons must not eject brass shells');

  effects.update(now + 450, 0.05);
  assert.equal(effects.shells.length, 0, 'expired shells must be removed from shellRoot');
  assert.equal(effects.surfaceImpacts.length, 0, 'expired surface sparks must dispose and clear');

  effects.resetPresentation();
  assert.equal(effects.landingDip, 0);
  assert.equal(effects.lookSwayX, 0);
  assert.equal(effects.recoil, 0);

  effects.dispose();
  assert.equal(scene.children.length, 1, 'only camera remains after WeaponEffects.dispose');
});

test('Operation Pulse Phase 5: hurt/reloading bots seek cover shelter and RemotePlayers animates jumps and hit reactions', () => {
  let now = 10_000;
  const room = {
    code: 'PULSE5',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.SOLO_VS_BOTS,
    mapId: MAP_IDS.FOUNDRY,
    botDifficulty: 'normal',
    players: new Map([
      ['human', { id: 'human', name: 'Operator', connected: true, bundleId: 'RUSHER', isBot: false }],
    ]),
  };
  const game = new GameState(room, {}, now);
  const botIds = [...game.players.keys()].filter((id) => id !== 'human');
  const bot = game.players.get(botIds[0]);
  for (const extraId of botIds.slice(1)) game.players.delete(extraId);

  // Place cover at (3, z=2) near a hurt/reloading bot at (1.5, z=0) while threat stands at (0, z=14).
  game.cover = [{
    id: 0,
    x: 3.0,
    y: 1.4,
    z: 2.0,
    width: 2.2,
    height: 2.8,
    depth: 2.2,
    destructible: false,
  }];
  const human = game.players.get('human');
  Object.assign(human, { x: 0, y: 0, z: 14, vx: 0, vy: 0, vz: 0, spawnProtectionUntil: 0 });
  Object.assign(bot, {
    x: 1.5,
    y: 0,
    z: 0,
    yaw: Math.PI,
    health: 24,
    reloading: true,
    spawnProtectionUntil: 0,
  });
  bot.botBrain.lastThinkAt = now - 200;

  now += 100;
  game.setInput('human', { seq: 1, forward: 0, strafe: 0, jump: false, yaw: 0, pitch: 0 }, now);
  game.update(0.1, now);
  const moveMag = Math.hypot(bot.input.forward, bot.input.strafe);
  assert.ok(moveMag > 0.35, 'hurt/reloading bot should actively steer toward sheltered cover pocket');

  // Verify RemotePlayers airborne jump state, BOT label prefix, and hit-flinch reaction.
  const dom = new JSDOM('<!doctype html><div id="tags"></div><canvas id="c"></canvas>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  let jumpCalls = 0;
  const fakeAssetManager = {
    createCharacterRig: () => null,
  };
  const remoteScene = new THREE.Scene();
  const tagRoot = document.getElementById('tags');
  const remotes = new RemotePlayers(remoteScene, tagRoot, createMockModelLibrary(), fakeAssetManager);
  const interpolator = new StateInterpolator(75);
  const cam = new THREE.PerspectiveCamera(77, 16 / 9, 0.1, 200);
  cam.position.set(0, 1.6, 8);
  cam.lookAt(0, 1.2, 0);
  cam.updateMatrixWorld(true);

  const botSnap = {
    id: 'bot-alpha',
    name: 'Viper',
    isBot: true,
    alive: true,
    connected: true,
    x: 0,
    y: 0.9,
    z: 0,
    vx: 0,
    vy: 3.4,
    vz: 0,
    grounded: false,
    yaw: 0,
    pitch: 0,
    currentWeaponId: 'SMG',
    currentWeaponName: 'SMG',
  };
  interpolator.push([botSnap], 1_000);
  remotes.update([botSnap], interpolator, cam, 925, 'human');
  const rec = remotes.players.get('bot-alpha');
  assert.ok(rec, 'remote bot record created');
  assert.equal(rec.nameLabel.textContent, 'BOT · Viper');

  // Attach a mock rig with setJumping and verify airborne state triggers setJumping().
  rec.rig = {
    setJumping() { jumpCalls += 1; },
    setLocomotion() {},
    revive() {},
    setDead() {},
    update() {},
  };
  remotes.triggerHitReaction('bot-alpha', true, performance.now());
  remotes.update([botSnap], interpolator, cam, 925, 'human');
  assert.equal(jumpCalls, 1, 'airborne remote operator should drive CharacterRig.setJumping()');
  assert.ok(rec.group.rotation.x < 0, 'server-confirmed hit reaction should apply brief flinch tilt');

  // Also verify PlayerController.consumeLookDelta.
  const canvas = document.getElementById('c');
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => canvas });
  const controller = new PlayerController(cam, canvas);
  controller.setEnabled(true);
  controller.handleMouseMove({ movementX: 20, movementY: -10 });
  const delta = controller.consumeLookDelta();
  assert.ok(delta.yaw < 0 && delta.pitch > 0);
  const cleared = controller.consumeLookDelta();
  assert.equal(cleared.yaw, 0);
  assert.equal(cleared.pitch, 0);

  controller.dispose();
  remotes.clear();
  dom.window.close();
});

test('Operation Pulse Phase 6 & 7: weapon-distinct audio + ambience lifecycle and authoritative HUD elimination/hit states', async () => {
  // 1. AudioEngine weapon-specific shots, movement cues, and ambience start/stop lifecycle.
  const startedSources = [];
  const stoppedSources = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 22_050;
      this.destination = {};
    }
    createGain() { return { gain: param(), connect: (t) => t, disconnect() {} }; }
    createBiquadFilter() { return { type: 'lowpass', frequency: param(), Q: param(), connect: (t) => t, disconnect() {} }; }
    createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len), length: len }; }
    createBufferSource() {
      const src = {
        buffer: null,
        loop: false,
        connect: (t) => t,
        disconnect() {},
        start: () => startedSources.push(src),
        stop: () => stoppedSources.push(src),
      };
      return src;
    }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: param(),
        connect: (t) => t,
        disconnect() {},
        start: () => startedSources.push(osc),
        stop: () => stoppedSources.push(osc),
      };
      return osc;
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }

  const prevWin = globalThis.window;
  globalThis.window = { AudioContext: MockAudioContext };
  try {
    const audio = new AudioEngine({ volume: 0.65 });
    audio.setAmbience('foundry');
    assert.equal(audio.ambienceNodes, null, 'ambience must not start before user gesture unlock');
    assert.equal(audio.unlock(), true);
    assert.ok(audio.ambienceNodes, 'ambience starts cleanly once unlocked');

    assert.equal(audio.play('shot', { weaponId: 'SHOTGUN', weaponClass: 'heavy' }), true);
    assert.equal(audio.play('step'), true);
    assert.equal(audio.play('jump'), true);
    assert.equal(audio.play('land', { intensity: 1.1 }), true);
    assert.equal(audio.play('switch'), true);
    assert.equal(audio.play('hit', { blocked: true }), true);

    audio.setAmbience(null);
    assert.equal(audio.ambienceNodes, null, 'leaving match stops ambience nodes cleanly');
    audio.dispose();
  } finally {
    globalThis.window = prevWin;
  }

  // 2. GameUI authoritative hitmarker states, low-ammo warning, and elimination banner.
  const dom = new JSDOM(html, { url: 'https://arena.test/', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;

  const { GameUI } = await import('../client/ui.js');
  const ui = new GameUI({ profileId: 'pulse-hud', onChange: (patch) => ({ ...ui.settings, ...patch }) });
  ui.showMatch({ code: 'PLS123', mode: 'SOLO_VS_BOTS', mapId: MAP_IDS.FOUNDRY, targetKills: 30 });

  // Blocked hit -> is-blocked; headshot -> is-headshot.
  ui.showHitMarker({ hit: true, blockedByShield: true });
  assert.equal(document.getElementById('crosshair').classList.contains('is-blocked'), true);
  ui.showHitMarker({ hit: true, headshot: true, killed: false });
  assert.equal(document.getElementById('crosshair').classList.contains('is-headshot'), true);

  // Low ammo warning at <= 25% mag.
  ui.updateHud({
    id: 'me',
    alive: true,
    health: 100,
    maxHealth: 100,
    bundleId: 'RUSHER',
    currentWeaponId: 'SMG',
    currentWeaponName: 'SMG',
    ammo: 5,
    maxAmmo: 30,
    reserveAmmo: 90,
  }, Date.now(), 6);
  assert.equal(document.querySelector('.ammo').classList.contains('is-low'), true);

  // Server-confirmed elimination banner displays victim and headshot badge.
  ui.showEliminationBanner({ killerId: 'me', victimName: 'Bot Sentinel', headshot: true });
  const banner = document.getElementById('hud-elim-banner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /ELIMINATED/);
  assert.match(banner.textContent, /Bot Sentinel/);
  assert.match(banner.textContent, /HEADSHOT/);

  ui.dispose();
  dom.window.close();
});
