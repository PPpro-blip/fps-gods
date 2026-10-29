import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { io as createClient } from 'socket.io-client';

import {
  BOT,
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_IDS,
  DEFAULT_BOT_DIFFICULTY,
  PLAYER,
  getBotDifficultyConfig,
  resolveBotDifficulty,
} from '../shared/gameConfig.js';
import { EVENTS, ROOM_MODES, ROOM_STATES } from '../shared/events.js';
import { getMap } from '../shared/maps.js';
import { WEAPON_MODEL_FILE, WEAPON_MODEL_FILES, WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';
import { GameState } from '../server/gameState.js';
import { WEAPONS } from '../server/weaponConfig.js';
import { createGameServer } from '../server/index.js';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../client/settings.js';
import { GameUI } from '../client/ui.js';
import { AimController } from '../client/aim.js';
import { PlayerController, StateInterpolator } from '../client/player.js';
import { InputCadence, LocalPrediction } from '../client/prediction.js';
import { orientModel, WeaponEffects } from '../client/weapons.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8');

async function createRealWeaponLibrary() {
  const previous = {
    self: globalThis.self,
    createImageBitmap: globalThis.createImageBitmap,
    ProgressEvent: globalThis.ProgressEvent,
  };
  globalThis.self = globalThis;
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, data) {
      this.type = type;
      Object.assign(this, data);
    }
  };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

  try {
    const parsedByFile = new Map();
    for (const fileName of WEAPON_MODEL_FILES) {
      const candidates = [
        resolve(repoRoot, 'client/assets/weapons', fileName),
        resolve(repoRoot, 'public/assets/weapons', fileName),
      ];
      const filePath = candidates.find((candidate) => existsSync(candidate));
      assert.ok(filePath, `missing weapon asset ${fileName}`);
      const bytes = readFileSync(filePath);
      const data = fileName.endsWith('.gltf')
        ? bytes.toString('utf8')
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf = await new Promise((resolvePromise, rejectPromise) => {
        new GLTFLoader().parse(data, '', resolvePromise, rejectPromise);
      });
      parsedByFile.set(fileName, orientModel(gltf.scene, fileName));
    }

    return {
      onReady() {},
      getLength(weaponId) {
        return WEAPON_MODEL_LENGTH[WEAPON_MODEL_FILE[weaponId]] ?? 0.5;
      },
      createModel(weaponId) {
        const template = parsedByFile.get(WEAPON_MODEL_FILE[weaponId]);
        assert.ok(template, `missing template for ${weaponId}`);
        return template.clone(true);
      },
    };
  } finally {
    globalThis.self = previous.self;
    globalThis.createImageBitmap = previous.createImageBitmap;
    globalThis.ProgressEvent = previous.ProgressEvent;
  }
}

function waitForEvent(socket, eventName, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      rejectPromise(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolvePromise(payload);
    }
    socket.once(eventName, onEvent);
  });
}

test('Priority 1: bot difficulty presets default to Easy and scale monotonically', () => {
  assert.equal(DEFAULT_BOT_DIFFICULTY, 'easy');
  assert.deepEqual(BOT_DIFFICULTY_IDS, ['easy', 'normal', 'hard']);
  assert.equal(resolveBotDifficulty(undefined), 'easy');
  assert.equal(resolveBotDifficulty('UNKNOWN_MODE'), 'easy');
  assert.equal(resolveBotDifficulty('HARD'), 'hard');

  const easy = getBotDifficultyConfig('easy');
  const normal = getBotDifficultyConfig('normal');
  const hard = getBotDifficultyConfig('hard');

  assert.ok(easy.reactionMinMs > normal.reactionMinMs);
  assert.ok(normal.reactionMinMs > hard.reactionMinMs);
  assert.ok(easy.turnSpeedRadPerSec < normal.turnSpeedRadPerSec);
  assert.ok(normal.turnSpeedRadPerSec < hard.turnSpeedRadPerSec);
  assert.ok(easy.aimJitterRad > normal.aimJitterRad);
  assert.ok(normal.aimJitterRad > hard.aimJitterRad);
  assert.ok(easy.movingTargetSpreadRad > normal.movingTargetSpreadRad);
  assert.ok(normal.movingTargetSpreadRad > hard.movingTargetSpreadRad);
  assert.ok(easy.missChance > normal.missChance);
  assert.ok(normal.missChance > hard.missChance);
  assert.ok(easy.fireIntervalMultiplier > normal.fireIntervalMultiplier);
  assert.ok(normal.fireIntervalMultiplier > hard.fireIntervalMultiplier);
  assert.ok(easy.maxSimultaneousAttackers <= normal.maxSimultaneousAttackers);
  assert.ok(normal.maxSimultaneousAttackers <= hard.maxSimultaneousAttackers);
  assert.equal(Object.keys(BOT_DIFFICULTIES).length, 3);
});

test('Priority 1: bots obey solid-wall and smoke LOS, turn caps, reaction delays, cooldowns, and weapon damage', () => {
  for (const difficulty of BOT_DIFFICULTY_IDS) {
    let now = 1_000;
    const firedEvents = [];
    const hitEvents = [];
    const room = {
      code: `LOS_${difficulty.toUpperCase()}`,
      state: ROOM_STATES.PLAYING,
      mode: ROOM_MODES.SOLO_VS_BOTS,
      mapId: 'NEON_FOUNDRY',
      botDifficulty: difficulty,
      players: new Map([
        ['human', { id: 'human', name: 'Operator', connected: true, bundleId: 'RUSHER', isBot: false }],
      ]),
    };

    const game = new GameState(room, {
      emitRoom: (event, payload) => {
        if (event === EVENTS.WEAPON_FIRED) firedEvents.push({ at: now, ...payload });
      },
      emitPlayer: (_id, event, payload) => {
        if (event === EVENTS.HIT_CONFIRMED) hitEvents.push({ at: now, ...payload });
      },
    }, now);

    // Isolate to a 1v1 lane against a single bot.
    const botIds = [...game.players.keys()].filter((id) => id !== 'human');
    const botId = botIds[0];
    for (const extraId of botIds.slice(1)) game.players.delete(extraId);

    const human = game.players.get('human');
    const bot = game.players.get(botId);
    human.x = 0;
    human.y = 0;
    human.z = 14;
    human.spawnProtectionUntil = 0;
    bot.x = 0;
    bot.y = 0;
    bot.z = 0;
    bot.yaw = Math.PI;
    bot.spawnProtectionUntil = 0;
    bot.weaponSlots = ['SMG', 'PISTOL', 'SHOTGUN'];
    bot.currentWeaponSlot = 0;
    bot.currentWeaponId = 'SMG';
    bot.ammo = { SMG: 999, PISTOL: 999, SHOTGUN: 999 };
    bot.botBrain.nextDecisionAt = now;
    bot.botBrain.lastThinkAt = now;

    // 1. Solid indestructible wall completely blocks bot acquisition & firing.
    game.cover = [{
      id: 'solid-wall',
      x: 0,
      y: 2.5,
      z: 7,
      width: 120,
      height: 5,
      depth: 1.5,
      health: 99_999,
      maxHealth: 99_999,
      destructible: false,
    }];
    for (let step = 0; step < 40; step += 1) {
      now += 50;
      game.setInput('human', { seq: step + 1, forward: 0, strafe: 0, jump: false, yaw: 0, pitch: 0 }, now);
      game.update(0.05, now);
    }
    assert.equal(firedEvents.length, 0, `${difficulty} bot must never shoot through solid cover`);
    assert.equal(human.health, PLAYER.maxHealth);

    // 2. Active smoke cloud between bot and player blocks LOS acquisition.
    game.cover = [];
    bot.x = 0;
    bot.z = 0;
    bot.yaw = Math.PI;
    bot.botBrain.lastThinkAt = now;
    game.smokeClouds = [{
      id: 'smoke-wall',
      x: 0,
      y: 1.2,
      z: 7,
      radius: 9.0,
      expiresAt: now + 30_000,
    }];
    for (let step = 0; step < 25; step += 1) {
      now += 50;
      game.setInput('human', { seq: 100 + step, forward: 0, strafe: 0, jump: false, yaw: 0, pitch: 0 }, now);
      game.update(0.05, now);
    }
    assert.equal(firedEvents.length, 0, `${difficulty} bot must not lock and shoot through active smoke`);

    // 3. Remove smoke and place bot facing 180 deg away: verify bounded turn rate per 50ms tick.
    game.smokeClouds = [];
    bot.x = 0;
    bot.z = 0;
    bot.yaw = 0; // Facing -Z while human is at +Z (180 degrees behind)
    bot.botBrain.targetId = human.id;
    bot.botBrain.lastKnownX = human.x;
    bot.botBrain.lastKnownZ = human.z;
    bot.botBrain.lastSeenAt = now;
    bot.botBrain.currentlyVisible = false;
    bot.botBrain.lastThinkAt = now;
    bot.botBrain.nextDecisionAt = now;

    const cfg = getBotDifficultyConfig(difficulty);
    const prevYaw = bot.yaw;
    now += 50;
    game.update(0.05, now);
    const rawDelta = ((bot.yaw - prevYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const yawStep = Math.abs(rawDelta);
    const maxThinkStep = cfg.turnSpeedRadPerSec * (BOT.thinkIntervalMs / 1000);
    assert.ok(
      yawStep <= maxThinkStep + 1e-4,
      `${difficulty} bot exceeded max turn speed (${yawStep} rad > ${maxThinkStep} rad)`,
    );

    // 4. Facing target directly on open lane: verify reaction window, fire interval, and exact SMG damage.
    firedEvents.length = 0;
    hitEvents.length = 0;
    human.health = 5_000;
    bot.x = 0;
    bot.z = 0;
    bot.yaw = Math.PI;
    bot.botBrain.targetId = null;
    bot.botBrain.currentlyVisible = false;
    bot.botBrain.visibleSince = null;
    bot.botBrain.reactionUntil = 0;
    bot.botBrain.burstRemaining = 0;
    bot.botBrain.burstCooldownUntil = 0;
    bot.botBrain.nextFireAt = 0;
    bot.botBrain.lastThinkAt = now;
    bot.botBrain.nextDecisionAt = now;
    const sightStartAt = now;

    for (let step = 0; step < 80; step += 1) {
      now += 50;
      const beforeHp = human.health;
      game.setInput('human', { seq: 300 + step, forward: 0, strafe: 0, jump: false, yaw: 0, pitch: 0 }, now);
      game.update(0.05, now);
      const damageTaken = beforeHp - human.health;
      if (damageTaken > 0) {
        const validDamages = [
          WEAPONS.SMG.damage,
          WEAPONS.SMG.damage * WEAPONS.SMG.headshotMultiplier,
        ];
        assert.ok(
          validDamages.some((expected) => Math.abs(damageTaken - expected) < 1e-6),
          `unexpected single-tick bot damage ${damageTaken}; bots must never use hidden damage multipliers or duplicate hits`,
        );
      }
    }

    assert.ok(firedEvents.length > 0, `${difficulty} bot should fire once reaction window elapses`);
    const firstReactionMs = firedEvents[0].at - sightStartAt;
    assert.ok(
      firstReactionMs >= cfg.reactionMinMs,
      `${difficulty} bot fired too early (${firstReactionMs}ms < ${cfg.reactionMinMs}ms)`,
    );

    for (let i = 1; i < firedEvents.length; i += 1) {
      const deltaMs = firedEvents[i].at - firedEvents[i - 1].at;
      assert.ok(
        deltaMs >= WEAPONS.SMG.fireRate,
        `${difficulty} bot violated SMG fireRate (${deltaMs}ms < ${WEAPONS.SMG.fireRate}ms)`,
      );
    }
  }
});

test('Priority 1: multi-bot focus-fire cap prevents all 5 bots from simultaneously firing at one player on Easy', () => {
  let now = 2_000;
  let shotsInTick = 0;
  const room = {
    code: 'FOCUS1',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.SOLO_VS_BOTS,
    mapId: 'NEON_FOUNDRY',
    botDifficulty: 'easy',
    players: new Map([
      ['human', { id: 'human', name: 'Operator', connected: true, bundleId: 'RUSHER', isBot: false }],
    ]),
  };
  const game = new GameState(room, {
    emitRoom: (event, payload) => {
      if (event === EVENTS.WEAPON_FIRED && payload.playerId !== 'human') {
        shotsInTick += 1;
      }
    },
  }, now);
  game.cover = [];
  const human = game.players.get('human');
  human.x = 0;
  human.y = 0;
  human.z = 0;
  human.health = 5_000;
  human.spawnProtectionUntil = 0;

  const bots = [...game.players.values()].filter((p) => p.isBot);
  assert.equal(bots.length, 5);
  bots.forEach((bot, index) => {
    const angle = (index / bots.length) * Math.PI * 2;
    bot.x = Math.cos(angle) * 10;
    bot.z = Math.sin(angle) * 10;
    bot.yaw = Math.atan2(bot.x, bot.z); // Face origin directly
    bot.spawnProtectionUntil = 0;
    bot.weaponSlots = ['SMG', 'PISTOL', 'SHOTGUN'];
    bot.currentWeaponSlot = 0;
    bot.currentWeaponId = 'SMG';
    bot.ammo = { SMG: 999, PISTOL: 999, SHOTGUN: 999 };
    bot.botBrain.targetId = 'human';
    bot.botBrain.currentlyVisible = true;
    bot.botBrain.visibleSince = now - 2_000;
    bot.botBrain.reactionUntil = now - 100;
    bot.botBrain.nextFireAt = 0;
    bot.botBrain.burstCooldownUntil = 0;
    bot.botBrain.lastThinkAt = now;
    bot.botBrain.nextDecisionAt = now + 5_000;
  });

  now += 50;
  shotsInTick = 0;
  game.update(0.05, now);

  assert.ok(
    shotsInTick <= BOT_DIFFICULTIES.easy.maxSimultaneousAttackers,
    `expected <= ${BOT_DIFFICULTIES.easy.maxSimultaneousAttackers} simultaneous bot attackers on Easy, got ${shotsInTick}`,
  );
});

test('Priority 1 & 3: PLAY_NOW delivers immediate snapshot #0 and SET_BOT_DIFFICULTY / PLAY_AGAIN update live server state', async () => {
  const server = createGameServer({ port: 0, dbPath: ':memory:' });
  await new Promise((resolvePromise) => server.httpServer.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.httpServer.address();
  const client = createClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });

  try {
    await waitForEvent(client, 'connect');

    const startPromise = waitForEvent(client, EVENTS.GAME_START);
    const firstSnapshotPromise = waitForEvent(client, EVENTS.GAME_STATE_UPDATE);
    const startedAt = performance.now();

    client.emit(EVENTS.PLAY_NOW, {
      name: 'Tester',
      bundleId: 'RUSHER',
      mapId: 'NEON_FOUNDRY',
      botDifficulty: 'easy',
    });

    const [gameStart, firstSnapshot] = await Promise.all([startPromise, firstSnapshotPromise]);
    const launchLatencyMs = performance.now() - startedAt;

    assert.equal(gameStart.botDifficulty, 'easy');
    assert.equal(firstSnapshot.botDifficulty, 'easy');
    assert.equal(firstSnapshot.tick, 0, 'launchRoom must push tick-0 snapshot immediately');
    assert.ok(launchLatencyMs < 45, `initial snapshot took too long (${launchLatencyMs.toFixed(1)}ms)`);

    // Change bot difficulty mid-match without breaking match state.
    const roomUpdatePromise = waitForEvent(client, EVENTS.ROOM_STATE);
    client.emit(EVENTS.SET_BOT_DIFFICULTY, { botDifficulty: 'hard' });
    const updatedRoom = await roomUpdatePromise;
    assert.equal(updatedRoom.botDifficulty, 'hard');
    assert.equal(updatedRoom.state, ROOM_STATES.PLAYING);

    const nextSnapshot = await waitForEvent(client, EVENTS.GAME_STATE_UPDATE);
    assert.equal(nextSnapshot.botDifficulty, 'hard');

    // End match and trigger PLAY_AGAIN with Normal difficulty.
    const roomRecord = server.roomManager.rooms.get(updatedRoom.code);
    server.roomManager.endGame(roomRecord, { id: client.id, name: 'Tester', kills: 30 });
    const redeployStart = waitForEvent(client, EVENTS.GAME_START);
    client.emit(EVENTS.PLAY_AGAIN, { botDifficulty: 'normal' });
    const restarted = await redeployStart;
    assert.equal(restarted.botDifficulty, 'normal');
  } finally {
    client.disconnect();
    await server.close();
  }
});

test('Priority 1: SettingsStore and GameUI persist and synchronize botDifficulty across Play, Settings, Pause, and HUD', () => {
  assert.equal(DEFAULT_SETTINGS.botDifficulty, 'easy');
  assert.equal(sanitizeSettings({ botDifficulty: 'hard' }).botDifficulty, 'hard');
  assert.equal(sanitizeSettings({ botDifficulty: 'invalid' }).botDifficulty, 'easy');

  const dom = new JSDOM(html, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage,
    configurable: true,
    writable: true,
  });

  try {
    const store = new SettingsStore({ storage: dom.window.localStorage });
    assert.equal(store.get('botDifficulty'), 'easy');

    const difficultyEvents = [];
    const ui = new GameUI({
      profileId: 'prof-diff',
      settings: store.snapshot,
      onChange: (patch) => store.update(patch),
    });
    ui.setHandlers({
      onBotDifficultyChange: (difficulty) => difficultyEvents.push(difficulty),
    });

    // Play screen picker starts on Easy.
    const playButtons = [...document.querySelectorAll('#bot-difficulty-grid .difficulty-pill')];
    assert.equal(playButtons.length, 3);
    assert.equal(
      playButtons.find((btn) => btn.classList.contains('is-selected'))?.dataset.botDifficulty,
      'easy',
    );

    // Clicking Normal updates settings store, settings select, pause pills, and handler.
    const normalBtn = playButtons.find((btn) => btn.dataset.botDifficulty === 'normal');
    normalBtn.click();
    assert.equal(ui.botDifficulty, 'normal');
    assert.equal(store.get('botDifficulty'), 'normal');
    assert.equal(document.getElementById('setting-bot-difficulty').value, 'normal');
    assert.deepEqual(difficultyEvents, ['normal']);

    // Entering a SOLO_VS_BOTS room displays HUD & Pause difficulty controls; MULTIPLAYER hides them.
    ui.showMatch({
      code: 'SOLO99',
      mode: ROOM_MODES.SOLO_VS_BOTS,
      state: ROOM_STATES.PLAYING,
      mapId: 'NEON_FOUNDRY',
      botDifficulty: 'hard',
      players: [],
    });
    assert.equal(document.getElementById('hud-bot-difficulty').hidden, false);
    assert.match(document.getElementById('hud-bot-difficulty').textContent, /HARD/i);
    assert.equal(document.getElementById('pause-bot-difficulty').hidden, false);

    ui.showMatch({
      code: 'MP9999',
      mode: ROOM_MODES.MULTIPLAYER,
      state: ROOM_STATES.PLAYING,
      mapId: 'NEON_FOUNDRY',
      botDifficulty: null,
      players: [],
    });
    assert.equal(document.getElementById('hud-bot-difficulty').hidden, true);
    assert.equal(document.getElementById('pause-bot-difficulty').hidden, true);
  } finally {
    dom.window.close();
  }
});

test('Priority 2: real shipped weapon GLBs attach clean grips, flip ROCKET forward, align ADS, and clean up across switches and respawns', async () => {
  const library = await createRealWeaponLibrary();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 300);
  scene.add(camera);

  const effects = new WeaponEffects(scene, camera, library);
  const aim = new AimController(camera, effects, 75);

  for (const weaponId of Object.keys(WEAPON_MODEL_FILE)) {
    effects.setWeapon(weaponId, 'RUSHER', false);
    aim.setWeapon(weaponId);
    effects.update(1000, 1 / 60);
    camera.updateMatrixWorld(true);

    const modelChildren = effects.weaponMount.children.filter(
      (child) => child !== effects.handRig && child !== effects.muzzle,
    );
    assert.equal(
      modelChildren.length,
      1,
      `${weaponId} must leave exactly one active weapon model in weaponMount`,
    );
    assert.equal(effects.currentModel, modelChildren[0]);
    assert.ok(effects.handRig.parent === effects.weaponMount, `${weaponId} handRig must stay locked to weaponMount`);
    assert.equal(effects.rightHandGroup.visible, true, `${weaponId} primary rightHandGroup must be visible`);

    if (weaponId === 'KNIFE') {
      assert.equal(
        effects.leftHandGroup.visible,
        false,
        'KNIFE must be single-handed without floating off-hand',
      );
    } else {
      assert.equal(effects.leftHandGroup.visible, true, `${weaponId} must show support leftHandGroup`);
    }

    if (weaponId === 'ROCKET') {
      // orientModel rotates rocket_launcher_low.gltf by 180 deg around Y so its +Z nozzle points down -Z.
      let flippedForward = false;
      effects.currentModel.traverse((node) => {
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(node.quaternion);
        if (forward.z < -0.99) flippedForward = true;
      });
      assert.equal(flippedForward, true, 'ROCKET model must rotate 180 deg so launcher barrel faces forward (-Z)');
    }

    if (weaponId === 'COMBAT_SHIELD') {
      assert.ok(
        effects.rightHandGroup.position.x > 0.03
          && effects.leftHandGroup.position.x < -0.03
          && effects.rightHandGroup.position.z > 0.035
          && effects.leftHandGroup.position.z > 0.035,
        'COMBAT_SHIELD dual handles must brace left/right rear straps behind the shield plate',
      );
    }

    // Verify visible hand meshes never cross camera near plane (z <= -0.052 in camera space).
    const invCam = camera.matrixWorldInverse.clone();
    let visibleHandMeshes = 0;
    for (const handGroup of [effects.rightHandGroup, effects.leftHandGroup]) {
      if (!handGroup.visible) continue;
      handGroup.traverse((node) => {
        if (!node.isMesh || !node.visible) return;
        visibleHandMeshes += 1;
        node.geometry.computeBoundingBox();
        const box = node.geometry.boundingBox.clone();
        box.applyMatrix4(node.matrixWorld).applyMatrix4(invCam);
        assert.ok(box.max.z < -0.052, `${weaponId} hand mesh crossed camera near plane (${box.max.z})`);
      });
    }
    assert.ok(visibleHandMeshes >= 8 && visibleHandMeshes <= 18, `${weaponId} unexpected hand mesh count ${visibleHandMeshes}`);

    // Step into full ADS and verify sight stability / sniper optical scope hide.
    aim.setHeld(true);
    aim.update(0.5);
    effects.update(1016, 1 / 60);
    if (weaponId === 'SNIPER') {
      assert.equal(effects.weaponMount.visible, false, 'SNIPER optical scope must hide weaponMount cleanly at full ADS');
    } else {
      assert.equal(effects.weaponMount.visible, true, `${weaponId} ADS must keep weaponMount visible`);
    }
    aim.reset(true);
  }

  // Rapid animated switching + death hide + respawn resetPresentation must leave zero duplicate models or stuck flags.
  let clock = 2000;
  for (const weaponId of ['SMG', 'KNIFE', 'ROCKET', 'COMBAT_SHIELD', 'SHOTGUN', 'PISTOL']) {
    clock += 16;
    effects.setWeapon(weaponId, 'RUSHER', true);
    effects.startReload(1200);
    effects.update(clock, 1 / 60);
  }
  effects.setVisible(false);
  assert.equal(effects.viewModel.visible, false);
  effects.resetPresentation();
  assert.equal(effects.viewModel.visible, true);
  const remainingModels = effects.weaponMount.children.filter(
    (child) => child !== effects.handRig && child !== effects.muzzle,
  );
  assert.equal(remainingModels.length, 1);

  effects.dispose();
  assert.equal(camera.children.includes(effects.viewModel), false);
});

test('Priority 3: StateInterpolator delayMs is finite, LocalPrediction smooths 334ms RTT jitter, InputCadence keeps alive, and held W survives respawn', () => {
  // 1. StateInterpolator.delayMs regression check (previously undefined -> NaN renderAt).
  const interpolator = new StateInterpolator();
  assert.equal(typeof interpolator.delayMs, 'number');
  assert.ok(Number.isFinite(interpolator.delayMs) && interpolator.delayMs >= 65);

  interpolator.push([{ id: 'bot-1', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }], 1_000);
  interpolator.push([{ id: 'bot-1', x: 0, y: 0, z: -2, yaw: 0, pitch: 0 }], 1_055);
  interpolator.push([{ id: 'bot-1', x: 0, y: 0, z: -4, yaw: 0, pitch: 0 }], 1_125);
  const sampled = interpolator.sample('bot-1', 1_125 - interpolator.delayMs);
  assert.ok(sampled && Number.isFinite(sampled.z), 'interpolated sample must be finite');
  assert.ok(sampled.z <= 0 && sampled.z >= -4);

  // 2. LocalPrediction under 334ms RTT + +-32ms jitter does not lurch backward or stall.
  const map = getMap('NEON_FOUNDRY');
  const game = new GameState({
    code: 'RTT334',
    state: ROOM_STATES.PLAYING,
    mode: ROOM_MODES.MULTIPLAYER,
    mapId: 'NEON_FOUNDRY',
    players: new Map([['p1', { id: 'p1', name: 'Runner', connected: true, bundleId: 'RUSHER' }]]),
  }, {}, 0);
  game.cover = [];
  const serverPlayer = game.players.get('p1');
  Object.assign(serverPlayer, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spawnProtectionUntil: 0 });

  const predictor = new LocalPrediction();
  predictor.reset({ ...serverPlayer });
  const cadence = new InputCadence();
  const inFlightToServer = [];
  const inFlightToClient = [];

  let seq = 0;
  let nextServerTick = 50;
  const speeds = [];
  let prevZ = 0;

  for (let frame = 1; frame <= 180; frame += 1) {
    const now = frame * (1000 / 60);
    const candidate = { seq: Math.max(1, seq), forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 };
    if (cadence.shouldSend(candidate, now)) {
      seq += 1;
      const sent = { ...candidate, seq };
      cadence.sent(sent, now);
      const jitter = Math.sin(frame * 1.7) * 32;
      inFlightToServer.push({ deliverAt: now + 167 + jitter, packet: sent });
    }

    for (let i = inFlightToServer.length - 1; i >= 0; i -= 1) {
      if (inFlightToServer[i].deliverAt <= now) {
        game.setInput('p1', inFlightToServer[i].packet, now);
        inFlightToServer.splice(i, 1);
      }
    }

    while (nextServerTick <= now) {
      game.update(0.05, nextServerTick);
      const jitter = Math.cos(nextServerTick * 0.13) * 32;
      inFlightToClient.push({
        deliverAt: nextServerTick + 167 + jitter,
        snapshot: {
          x: serverPlayer.x,
          y: serverPlayer.y,
          z: serverPlayer.z,
          vx: serverPlayer.vx,
          vy: serverPlayer.vy,
          vz: serverPlayer.vz,
          grounded: serverPlayer.grounded,
          wasJumping: serverPlayer.wasJumping,
          knockbackVX: 0,
          knockbackVZ: 0,
          alive: true,
          inputAck: serverPlayer.lastProcessedInputSequence,
        },
      });
      nextServerTick += 50;
    }

    for (let i = inFlightToClient.length - 1; i >= 0; i -= 1) {
      if (inFlightToClient[i].deliverAt <= now) {
        predictor.reconcile(inFlightToClient[i].snapshot, map, []);
        inFlightToClient.splice(i, 1);
      }
    }

    predictor.step({ seq: Math.max(1, seq), forward: 1, strafe: 0, jump: false, yaw: 0, pitch: 0 }, 1 / 60, map, []);
    const pos = predictor.sample(1 / 60);
    if (frame > 10) {
      speeds.push((prevZ - pos.z) * 60);
    }
    prevZ = pos.z;
  }

  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  assert.ok(minSpeed > 4.5, `334ms RTT jitter caused movement stall (${minSpeed.toFixed(2)} m/s)`);
  assert.ok(maxSpeed < 9.8, `334ms RTT jitter caused rubberband spike (${maxSpeed.toFixed(2)} m/s)`);

  // 3. InputCadence idle keepalive stays well below PLAYER.inputTimeoutMs (750ms).
  cadence.reset();
  const idle = { seq: 1, forward: 0, strafe: 0, jump: false, yaw: 0, pitch: 0 };
  assert.equal(cadence.shouldSend(idle, 100), true);
  cadence.sent(idle, 100);
  assert.equal(cadence.shouldSend(idle, 250), false);
  assert.equal(cadence.shouldSend(idle, 305), true, 'idle keepalive must fire at 200ms (< 750ms timeout)');
  assert.equal(PLAYER.inputTimeoutMs, 750);

  // 4. Holding KeyW across death -> respawn preserves physical key state without dead-key freeze.
  const dom = new JSDOM('<canvas id="game"></canvas>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const canvas = document.querySelector('canvas');
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => canvas });

  const controller = new PlayerController(new THREE.PerspectiveCamera(), canvas);
  let edges = 0;
  controller.onInputEdge = () => { edges += 1; };

  try {
    controller.setEnabled(true, { preserveKeys: true });
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    assert.equal(controller.getInput(1).forward, 1);

    // Player dies while still physically holding W.
    controller.resetTransientState();
    controller.setEnabled(false, { preserveKeys: true });
    assert.equal(controller.getInput(2).forward, 0, 'disabled controller must never move while dead');
    assert.equal(controller.keys.has('KeyW'), true, 'physical KeyW remains tracked while held across respawn');

    // Player respawns 3 seconds later with W still held -> immediate input edge on frame 0!
    const edgesBeforeRespawn = edges;
    controller.resetTransientState();
    controller.setEnabled(true, { preserveKeys: true });
    assert.ok(edges > edgesBeforeRespawn, 're-enabling with held KeyW must fire onInputEdge immediately');
    assert.equal(controller.getInput(3).forward, 1, 'held KeyW resumes movement on frame 0 after respawn');
  } finally {
    controller.dispose();
    dom.window.close();
  }
});
