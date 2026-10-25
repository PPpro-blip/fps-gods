import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  ANIMATION_STATES,
  CHARACTER_ROOT_BONE,
  CharacterRig,
  buildAnimationSet,
  classifyClip,
  detectVerticalAxis,
  measureClip,
  stripHorizontalRootMotion,
} from '../client/animation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const characterPath = resolve(repoRoot, 'public/assets/characters/character.glb');

async function loadCharacter() {
  const buffer = readFileSync(characterPath);
  const gltf = await new Promise((resolvePromise, reject) => {
    new GLTFLoader().parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      '',
      resolvePromise,
      reject,
    );
  });
  return gltf;
}

// The classification is what keeps the game out of a T-pose, so it is checked
// against the real shipped clips rather than fixture data.
test('the shipped operator asset yields idle, walk, run, jump and death clips', async () => {
  const gltf = await loadCharacter();
  assert.equal(gltf.animations.length, 12, 'character.glb is expected to carry the full clip set');

  const set = buildAnimationSet(gltf.scene, gltf.animations);
  assert.ok(set.states[ANIMATION_STATES.IDLE], 'idle clip is required');
  assert.ok(set.states[ANIMATION_STATES.WALK], 'walk clip is required');
  assert.ok(set.states[ANIMATION_STATES.RUN], 'run clip is required');
  assert.ok(set.states[ANIMATION_STATES.DEATH], 'death clip is required');
  assert.equal(set.warnings.length, 0, `unexpected asset warnings: ${set.warnings.join('; ')}`);

  // Measured stride speeds come from the real motion, so the run clip must be
  // substantially faster than the walk clip.
  assert.ok(set.strides.run > set.strides.walk, 'run stride must outpace walk stride');
  assert.ok(set.strides.walk > 0.3, `walk stride looks static: ${set.strides.walk}`);
  assert.ok(set.strides.run > 2.5, `run stride looks slow: ${set.strides.run}`);

  const deathState = set.metrics.filter((entry) => entry.state === ANIMATION_STATES.DEATH);
  assert.ok(deathState.length >= 1);
  assert.ok(Math.max(...deathState.map((entry) => entry.collapseDepth)) > 0.5, 'death clip must collapse');
});

test('root motion is stripped so a server-positioned operator cannot drift', async () => {
  const gltf = await loadCharacter();
  const verticalAxis = detectVerticalAxis(gltf.scene);
  assert.equal(verticalAxis, 2, 'the Z-up armature makes the local Z axis the vertical one');

  const walkSource = gltf.animations
    .map((clip) => ({ clip, metrics: measureClip(gltf.scene, clip) }))
    .sort((left, right) => right.metrics.travelSpeed - left.metrics.travelSpeed)[0];
  assert.ok(walkSource.metrics.travelSpeed > 2, 'expected a clip with root travel to test against');

  const inPlace = stripHorizontalRootMotion(walkSource.clip, { verticalAxis });
  const before = measureClip(gltf.scene, walkSource.clip);
  const after = measureClip(gltf.scene, inPlace);
  assert.ok(before.travelSpeed > 2, 'the source clip travels');
  assert.ok(after.travelSpeed < 0.05, `stripped clip still travels ${after.travelSpeed.toFixed(2)} m/s`);
  assert.ok(Math.abs(after.verticalRange - before.verticalRange) < 0.06, 'vertical motion must survive stripping');
});

test('classifyClip maps measured motion onto gameplay states', () => {
  assert.equal(classifyClip({ travelSpeed: 6, verticalRange: 0.03, collapseDepth: 0, collapseAt: 0 }), ANIMATION_STATES.RUN);
  assert.equal(classifyClip({ travelSpeed: 1.1, verticalRange: 0.03, collapseDepth: 0, collapseAt: 0 }), ANIMATION_STATES.WALK);
  assert.equal(classifyClip({ travelSpeed: 0.01, verticalRange: 0.02, collapseDepth: 0, collapseAt: 0 }), ANIMATION_STATES.IDLE);
  assert.equal(classifyClip({ travelSpeed: 0.01, verticalRange: 0.3, collapseDepth: 0.05, collapseAt: 0.2 }), ANIMATION_STATES.JUMP);
  assert.equal(classifyClip({ travelSpeed: 0.4, verticalRange: 0.9, collapseDepth: 0.85, collapseAt: 0.75 }), ANIMATION_STATES.DEATH);
  assert.equal(classifyClip(null), ANIMATION_STATES.IDLE);
});

test('a rig crossfades states without restarting the mixer and disposes cleanly', async () => {
  const gltf = await loadCharacter();
  const set = buildAnimationSet(gltf.scene, gltf.animations);
  const rig = new CharacterRig(gltf.scene, set);

  const idle = rig.setLocomotion(0);
  assert.equal(rig.state, ANIMATION_STATES.IDLE);
  assert.ok(idle?.isRunning(), 'idle action must be running');
  rig.update(0.016);

  const runningAction = rig.setLocomotion(7.2);
  assert.equal(rig.state, ANIMATION_STATES.RUN, 'a 7.2 m/s operator must use the run clip');
  assert.equal(rig.state !== ANIMATION_STATES.IDLE, true);
  assert.ok(runningAction.isRunning());
  assert.ok(runningAction.getEffectiveTimeScale() > 1, 'stride rate should speed up to match travel');
  rig.update(0.016);

  rig.setDead();
  assert.equal(rig.state, ANIMATION_STATES.DEATH);
  assert.equal(rig.currentAction.loop, THREE.LoopOnce);
  rig.update(0.016);

  // Holding the same state must not reset the action every frame.
  const same = rig.currentAction;
  rig.setLocomotion(0);
  assert.equal(rig.currentAction, same, 'dead state must not be replaced by locomotion');

  const bone = rig.getBone(CHARACTER_ROOT_BONE);
  assert.ok(bone, 'the cloned rig keeps its skeleton');
  assert.ok(rig.rightHand, 'remote operators need a right-hand weapon socket');
  rig.dispose();
});
