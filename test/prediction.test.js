import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { PlayerController } from '../client/player.js';
import { InputCadence, LocalPrediction } from '../client/prediction.js';
import { GameState } from '../server/gameState.js';
import { PLAYER } from '../shared/gameConfig.js';
import { getMap } from '../shared/maps.js';
import { ROOM_MODES, ROOM_STATES } from '../shared/events.js';

const map = getMap();
const input = (seq, forward = 1, extra = {}) => ({ seq, forward, strafe: 0, jump: false, yaw: 0, pitch: 0, blocking: false, ...extra });
const snapshot = (extra = {}) => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, grounded: true, wasJumping: false, inputAck: -1, ...extra });

function game(mode = ROOM_MODES.MULTIPLAYER) {
  return new GameState({
    code: 'INPUT1', state: ROOM_STATES.PLAYING, mode,
    players: new Map([['a', { id: 'a', name: 'Alpha', connected: true, bundleId: 'RUSHER' }]]),
  }, {}, 1_000);
}

test('keyboard state changes synchronously; keyup, blur and disable clear it', () => {
  const dom = new JSDOM('<canvas id="game"></canvas>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const canvas = document.querySelector('canvas');
  let lock = canvas;
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lock });
  const controller = new PlayerController(new THREE.PerspectiveCamera(), canvas);
  controller.setEnabled(true);
  try {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    assert.equal(controller.getInput(1).forward, 1, 'no timer or acknowledgement before input state changes');
    document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    assert.equal(controller.getInput(2).forward, 0);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
    window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(controller.getInput(3).strafe, 0);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    controller.setEnabled(false);
    assert.equal(controller.keys.size, 0);
    controller.setEnabled(true);
    lock = null;
    assert.equal(controller.getInput(4).forward, 0, 'pointer lock gates sampling');
  } finally {
    controller.dispose();
    dom.window.close();
  }
});

test('local prediction starts movement in its first frame without a server round trip', () => {
  const predictor = new LocalPrediction();
  predictor.reset(snapshot());
  predictor.step(input(1), 0.016, map, []);
  assert.ok(Math.abs(predictor.sample(0).z + PLAYER.moveSpeed * 0.016) < 1e-8);
  predictor.step(input(2, 0), 0.016, map, []);
  assert.ok(Math.abs(predictor.state.z + PLAYER.moveSpeed * 0.016) < 1e-8, 'release immediately stops predicted motion');
});

test('acknowledged steps are discarded, newer ones replayed, and corrections converge', () => {
  const predictor = new LocalPrediction();
  predictor.reset(snapshot());
  predictor.step(input(1), 0.05, map, []);
  predictor.step(input(2), 0.05, map, []);
  predictor.reconcile(snapshot({ z: -0.30, inputAck: 1 }), map, []);
  assert.deepEqual(predictor.pending.map((step) => step.seq), [2]);
  assert.ok(Math.abs(predictor.state.z - (-0.30 - PLAYER.moveSpeed * 0.05)) < 1e-8);
  const stateAfterCorrection = predictor.state.z;
  predictor.reconcile(snapshot({ z: 99, inputAck: 0 }), map, []);
  assert.equal(predictor.state.z, stateAfterCorrection, 'stale acknowledgements cannot rewind prediction');
  predictor.reconcile(snapshot({ z: -0.64, inputAck: 2 }), map, []);
  assert.equal(predictor.pending.length, 0);
  for (let i = 0; i < 120; i += 1) predictor.sample(1 / 60);
  assert.ok(Math.abs(predictor.sample(0).z + 0.64) < 1e-8, 'visual smoothing does not leave permanent disagreement');
  predictor.reset(snapshot({ x: 5, z: 3 }));
  assert.deepEqual(predictor.sample(0), { x: 5, y: 0, z: 3 }, 'respawn resets history and smoothing');
});

test('prediction uses the same bounded speed, diagonal normalization and cover collision as the server', () => {
  const server = game();
  const player = server.players.get('a');
  Object.assign(player, { x: 0, y: 0, z: 0, yaw: 0 });
  server.cover = [{ id: 0, x: 0, z: -0.75, width: 4, depth: 0.3, height: 3 }];
  const predictor = new LocalPrediction();
  predictor.reset(snapshot());
  server.setInput('a', input(1), 1_001);
  server.update(0.1, 1_101);
  predictor.step(input(1), 0.1, server.map, server.cover);
  assert.equal(predictor.state.z, player.z);
  assert.equal(player.z, 0, 'cover collision remains enforced');

  server.cover = [];
  server.setInput('a', input(2, 100, { strafe: 100 }), 1_102);
  server.update(3, 1_202);
  assert.ok(Math.hypot(player.x, player.z) <= PLAYER.moveSpeed * 0.1 + 1e-9, 'client cannot choose speed or delta');
});

test('server acknowledges the latest consumed input, not merely a received packet', () => {
  const server = game();
  server.setInput('a', input(8), 1_001);
  server.setInput('a', input(9, 0), 1_002);
  let state = server.getPublicState(1_002).players.find((player) => player.id === 'a');
  assert.equal(state.inputAck, -1);
  server.update(0.05, 1_050);
  state = server.getPublicState(1_050).players.find((player) => player.id === 'a');
  assert.equal(state.inputAck, 9);
  const player = server.players.get('a');
  assert.equal(player.input.forward, 0, 'latest input replaces earlier input instead of accumulating a queue');
  server.setInput('a', input(8), 1_051);
  assert.equal(player.input.forward, 0, 'stale packets are rejected');
});

test('input cadence sends changes immediately and uses a bounded heartbeat while held', () => {
  const cadence = new InputCadence(50);
  let sent = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    const now = frame * 1000 / 60;
    const sample = input(frame);
    if (cadence.shouldSend(sample, now)) { cadence.sent(sample, now); sent += 1; }
  }
  assert.ok(sent >= 15 && sent <= 21, `heartbeat count was ${sent}`);
  const release = input(61, 0);
  assert.equal(cadence.shouldSend(release, cadence.lastSentAt + 1), true, 'key release does not wait for the heartbeat');
  cadence.sent(release, cadence.lastSentAt + 1);
  assert.equal(cadence.shouldSend({ ...release, seq: 62, blocking: true }, cadence.lastSentAt + 1), true);
});

test('bot and multiplayer rooms use the same movement rules and input timeout', () => {
  for (const mode of [ROOM_MODES.MULTIPLAYER, ROOM_MODES.SOLO_VS_BOTS]) {
    const server = game(mode);
    const player = server.players.get('a');
    Object.assign(player, { x: 0, y: 0, z: 0, yaw: 0 });
    server.cover = [];
    server.setInput('a', input(1), 1_001);
    server.update(0.05, 1_051);
    assert.ok(Math.abs(player.z + 0.36) < 1e-8);
    server.update(0.05, 1_001 + PLAYER.inputTimeoutMs + 1);
    assert.equal(player.input.forward, 0);
  }
});

test('gameplay input pump is unique and stops while input is disabled', async () => {
  const { InputPump } = await import('../client/inputPump.js');
  let starts = 0;
  let stops = 0;
  let callback;
  const timers = {
    setInterval(fn, interval) { starts += 1; callback = fn; assert.equal(interval, 25); return 7; },
    clearInterval(id) { assert.equal(id, 7); stops += 1; },
  };
  let ticks = 0;
  const pump = new InputPump(() => { ticks += 1; }, { timers });
  pump.start();
  pump.start();
  callback();
  assert.equal(starts, 1, 'repeated state synchronization cannot create a second pump');
  assert.equal(ticks, 1);
  pump.stop();
  pump.stop();
  assert.equal(stops, 1, 'disable clears the only active timer');
  pump.start();
  assert.equal(starts, 2, 're-enabling input restarts it');
  pump.stop();
});
