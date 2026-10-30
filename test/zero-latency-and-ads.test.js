import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { PlayerController } from '../client/player.js';
import { LocalPrediction } from '../client/prediction.js';
import { RuntimeDiagnostics } from '../client/diagnostics.js';
import { AimController } from '../client/aim.js';
import { WeaponEffects, WeaponModelLibrary } from '../client/weapons.js';
import { GameUI } from '../client/ui.js';
import { GameState } from '../server/gameState.js';
import { ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { getMap } from '../shared/maps.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('holding W before pointer lock and tapping Space sub-tick both register with zero lost inputs', () => {
  const dom = new JSDOM('<canvas id="game"></canvas>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const canvas = document.querySelector('canvas');
  let lockedEl = null;
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockedEl });

  const controller = new PlayerController(new THREE.PerspectiveCamera(), canvas);
  let edgeCount = 0;
  controller.onInputEdge = () => { edgeCount += 1; };

  try {
    // 1. Player presses W BEFORE pointer lock / controller enable.
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    assert.equal(controller.keys.has('KeyW'), true, 'movement key is captured across lock transition');

    // Pointer locks and controller enables -> immediate edge notification and forward === 1 on frame 0!
    controller.setEnabled(true);
    lockedEl = canvas;
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    assert.ok(edgeCount >= 1);
    assert.equal(controller.getInput(1).forward, 1);

    // 2. Player taps and releases Space in <10ms between network heartbeats.
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    assert.equal(controller.keys.has('Space'), false);
    const packet = controller.getInput(2, { consumeJumpTap: true });
    assert.equal(packet.jump, true, 'sub-tick Space tap stays latched for the next outgoing packet');
    assert.equal(controller.getInput(3, { consumeJumpTap: true }).jump, false, 'jump latch clears once consumed');

    // 3. Server GameState latches pendingJump even if a packet with jump:false arrives before the 50ms tick!
    const server = new GameState({
      code: 'JUMP01',
      state: ROOM_STATES.PLAYING,
      mode: ROOM_MODES.MULTIPLAYER,
      players: new Map([['p1', { id: 'p1', name: 'Jumper', connected: true, bundleId: 'RUSHER' }]]),
    }, {}, 1_000);
    const p1 = server.players.get('p1');
    Object.assign(p1, { x: 0, y: 0, z: 0, grounded: true, vy: 0 });
    server.setInput('p1', { seq: 10, forward: 1, strafe: 0, jump: true, yaw: 0, pitch: 0 }, 1_005);
    server.setInput('p1', { seq: 11, forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 }, 1_015);
    server.update(0.05, 1_050);
    assert.ok(p1.vy > 0 || p1.y > 0, 'server launches sub-tick jump even after keyup arrived before tick');
  } finally {
    controller.dispose();
    dom.window.close();
  }
});

test('sent-only seq prediction stays smooth under 100ms RTT and RuntimeDiagnostics tracks correlated timings', () => {
  const map = getMap('ARENA_ZERO');
  const server = new GameState({
    code: 'RTT100',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.MULTIPLAYER,
    players: new Map([['p1', { id: 'p1', name: 'Runner', connected: true, bundleId: 'RUSHER' }]]),
  }, {}, 0);
  const p1 = server.players.get('p1');
  Object.assign(p1, { x: 0, y: 0, z: 10, vx: 0, vy: 0, vz: 0, yaw: 0, grounded: true });

  const predictor = new LocalPrediction();
  predictor.reset({ x: 0, y: 0, z: 10, vx: 0, vy: 0, vz: 0, yaw: 0, grounded: true, inputAck: -1 });
  const diag = new RuntimeDiagnostics();

  const ping = diag.createPing(100);
  assert.equal(diag.recordPong(ping, 200), 100);

  let sentSeq = 0;
  const toServer = [];
  const toClient = [];
  let prevZ = 10;
  let maxSingleStepCm = 0;
  let nextPump = 0;
  let nextServerTick = 50;

  for (let ms = 0; ms <= 1_000; ms += 16.6667) {
    if (ms >= nextPump) {
      sentSeq += 1;
      diag.recordInputSent(sentSeq, ms);
      toServer.push({ deliverAt: ms + 50, pkt: { seq: sentSeq, forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 } });
      nextPump += 50;
    }
    while (toServer.length && toServer[0].deliverAt <= ms) {
      server.setInput('p1', toServer.shift().pkt, Math.round(ms));
    }
    while (ms >= nextServerTick) {
      server.update(0.05, nextServerTick);
      const snap = server.getPublicState(nextServerTick).players[0];
      toClient.push({ deliverAt: nextServerTick + 50, snap: structuredClone(snap) });
      nextServerTick += 50;
    }
    while (toClient.length && toClient[0].deliverAt <= ms) {
      const { snap } = toClient.shift();
      const drift = predictor.reconcile(snap, map, []);
      diag.recordSnapshot(snap.inputAck, drift, ms);
    }
    predictor.step({ seq: Math.max(1, sentSeq), forward: 1, strafe: 0, jump: false, yaw: 0 }, 1 / 60, map, []);
    const pose = predictor.sample(1 / 60);
    diag.recordFrame(1 / 60);
    const stepCm = Math.abs(pose.z - prevZ) * 100;
    if (ms > 0 && stepCm > maxSingleStepCm) maxSingleStepCm = stepCm;
    prevZ = pose.z;
  }

  const summary = diag.getSummary();
  assert.equal(summary.rttMs, 100);
  assert.ok(summary.inputAckMeanMs >= 95 && summary.inputAckMeanMs <= 160);
  assert.ok(maxSingleStepCm < 13.5, `expected smooth frame steps without velocity spikes, got ${maxSingleStepCm.toFixed(2)}cm`);
});

test('differentiated ADS profiles, optical scope tube hide, and HUD scope/wallet/OTP state transitions', async () => {
  const html = readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:3000/', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 125);
  scene.add(camera);
  const library = new WeaponModelLibrary();
  await library.ready;
  const effects = new WeaponEffects(scene, camera, library);
  const ui = new GameUI({ profileId: 'guest-test' });
  assert.equal(ui.el['auth-guest-panel'].hidden, true);
  assert.match(ui.el['topbar-credits-value'].textContent, /RESTORING/);
  ui.setAuthRestoring(false);
  assert.equal(ui.el['auth-guest-panel'].hidden, false);
  const states = [];
  const aim = new AimController(camera, effects, {
    onStateChange: (state) => {
      states.push(state);
      ui.setAimPresentation(state);
    },
  });

  try {
    // 1. Knife and Shield cannot enter ADS.
    aim.setWeapon('KNIFE');
    aim.setHeld(true);
    aim.update(0.5);
    assert.equal(aim.canAim(), false);
    assert.equal(aim.amount, 0);

    aim.setWeapon('COMBAT_SHIELD');
    aim.setHeld(true);
    aim.update(0.5);
    assert.equal(aim.canAim(), false);

    // 2. Sniper enters magnified 36° optic mode, scales mouse look, hides 3D scope tube, and shows #ads-scope-overlay!
    effects.setWeapon('SNIPER', 'GHOST');
    effects.update(100, 0.25); // finish equip transition
    aim.setWeapon('SNIPER');
    aim.setHeld(true);
    aim.update(0.5);
    assert.ok(Math.abs(camera.fov - 36) < 0.2);
    assert.equal(effects.opticalScopeHidden, true, '3D scope tube hides at full zoom so lens overlay is unobstructed');
    assert.equal(document.getElementById('ads-scope-overlay').hidden, false);
    assert.equal(document.getElementById('ads-scope-overlay').dataset.scope, 'optic');
    assert.ok(states.at(-1).lookScale < 0.5, 'magnified optic scales mouse sensitivity proportionally');

    // 3. Switching weapons or resetting clears ADS immediately.
    aim.reset(true);
    assert.equal(document.getElementById('ads-scope-overlay').hidden, true);
    assert.equal(effects.opticalScopeHidden, false);
    assert.ok(Math.abs(camera.fov - 77) < 0.01);

    // 4. UI Wallet + Reward Pop + Loadout Strip render cleanly.
    ui.setProfile({
      profileId: 'acct_demo123',
      accountId: 'acct_demo123',
      authenticated: true,
      emailMasked: 'op***@example.com',
      callsign: 'Ascended',
      lifetimeKills: 30,
      godsTierUnlocked: true,
      matchesPlayed: 4,
      matchesWon: 2,
    });
    ui.setWallet({
      accountId: 'acct_demo123',
      authenticated: true,
      balance: 245,
      lifetimeEarned: 500,
      recentTransactions: [{ reason: 'elimination', amount: 20 }],
    });
    assert.match(document.getElementById('topbar-credits-value').textContent, /245 SHARZS/);
    assert.equal(document.getElementById('account-status-badge').textContent, 'VERIFIED ACCOUNT');

    ui.showRewardEarned({ amount: 20, reason: 'elimination', headshot: true });
    assert.equal(document.getElementById('hud-reward-pop').hidden, false);
    assert.match(document.getElementById('hud-reward-pop').textContent, /\+20 SHARZS/);
  } finally {
    ui.dispose();
    effects.dispose();
    library.dispose();
    dom.window.close();
  }
});
