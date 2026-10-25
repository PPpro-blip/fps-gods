import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// The shipped operator is a Mixamo rig whose twelve clips are all named
// "mixamo.com", so no clip can be picked by name. Instead each clip is played on
// a throwaway mixer and measured: how far the hips travel horizontally, how much
// the body rises, how deeply it collapses and when. States are then assigned from
// those measurements, which keeps working if the art is re-exported with
// different names, ordering or clip count.

export const CHARACTER_ROOT_BONE = 'mixamorigHips';
export const WEAPON_HAND_BONE = 'mixamorigRightHand';

export const ANIMATION_STATES = Object.freeze({
  IDLE: 'idle',
  WALK: 'walk',
  RUN: 'run',
  JUMP: 'jump',
  DEATH: 'death',
});

/** Motion thresholds in metres and metres per second. */
export const CLASSIFY_THRESHOLDS = Object.freeze({
  walkSpeed: 0.3,
  runSpeed: 2.5,
  jumpRise: 0.14,
  deathDepth: 0.35,
  deathLate: 0.35,
});

/** Default stride speeds used when a clip cannot be measured. */
export const LOCOMOTION_SPEED = Object.freeze({ idle: 0.35, walk: 3.1, run: 6.4 });

const POSITION_SUFFIXES = ['.position', '.translation'];

function isPositionTrack(track) {
  return POSITION_SUFFIXES.some((suffix) => track.name.endsWith(suffix));
}

function trackNodeName(track) {
  const dot = track.name.lastIndexOf('.');
  return dot > 0 ? track.name.slice(0, dot) : track.name;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Which local axis of the root bone points up in world space.
 *
 * This rig hangs under a Z-up armature, so the hips' local +Z is world +Y.
 * Assuming Y-up is what leaves characters lying on the floor after a respawn.
 */
export function detectVerticalAxis(root, rootBoneName = CHARACTER_ROOT_BONE) {
  const bone = root?.getObjectByName?.(rootBoneName);
  if (!bone?.parent) return 1;
  bone.parent.updateWorldMatrix(true, false);
  let bestAxis = 1;
  let bestScore = -1;
  for (let axis = 0; axis < 3; axis += 1) {
    const direction = new THREE.Vector3()
      .setFromMatrixColumn(bone.parent.matrixWorld, axis)
      .normalize();
    const score = Math.abs(direction.y);
    if (score > bestScore) {
      bestScore = score;
      bestAxis = axis;
    }
  }
  return bestAxis;
}

/**
 * Play a clip on a private mixer and record how the hips move.
 *
 * @returns {{duration:number, travelSpeed:number, travel:number, verticalRange:number,
 *   rise:number, collapseDepth:number, collapseAt:number, startHeight:number,
 *   endHeight:number, peakHeight:number, lowHeight:number}}
 */
export function measureClip(root, clip, { samples = 24, rootBoneName = CHARACTER_ROOT_BONE } = {}) {
  const empty = {
    duration: clip?.duration ?? 0, travelSpeed: 0, travel: 0, verticalRange: 0, rise: 0,
    collapseDepth: 0, collapseAt: 0, startHeight: 0, endHeight: 0, peakHeight: 0, lowHeight: 0,
  };
  const bone = root?.getObjectByName?.(rootBoneName);
  if (!bone || !clip || !(clip.duration > 0)) return empty;

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.reset();
  action.play();

  const positions = [];
  const scratch = new THREE.Vector3();
  for (let index = 0; index <= samples; index += 1) {
    const time = (clip.duration * index) / samples;
    mixer.setTime(time);
    root.updateWorldMatrix(true, true);
    bone.getWorldPosition(scratch);
    positions.push({ time, x: scratch.x, y: scratch.y, z: scratch.z });
  }

  action.stop();
  mixer.uncacheAction(clip);
  mixer.uncacheClip(clip);
  mixer.uncacheRoot(root);

  const first = positions[0];
  const last = positions[positions.length - 1];
  const heights = positions.map((point) => point.y);
  const peakHeight = Math.max(...heights);
  const lowHeight = Math.min(...heights);
  const lowestIndex = heights.indexOf(lowHeight);
  const lowestTime = positions[lowestIndex].time;

  // Median of per-sample ground speed. A looping clip snaps back to its first
  // frame, producing one huge and completely bogus segment at the end.
  const speeds = [];
  let travel = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const before = positions[index - 1];
    const after = positions[index];
    const span = after.time - before.time;
    if (span <= 0) continue;
    const distance = Math.hypot(after.x - before.x, after.z - before.z);
    travel += distance;
    speeds.push(distance / span);
  }

  return {
    duration: clip.duration,
    travelSpeed: median(speeds),
    travel,
    verticalRange: peakHeight - lowHeight,
    rise: peakHeight - first.y,
    collapseDepth: first.y - lowHeight,
    collapseAt: clip.duration > 0 ? lowestTime / clip.duration : 0,
    startHeight: first.y,
    endHeight: last.y,
    peakHeight,
    lowHeight,
  };
}

/**
 * Map clip measurements onto a gameplay state.
 *
 * Death is tested first: a collapse also looks like a slow sideways crawl. A
 * rise with no ground travel is a jump; everything else sorts by ground speed.
 */
export function classifyClip(metrics) {
  if (!metrics) return ANIMATION_STATES.IDLE;
  const collapses = metrics.collapseDepth >= CLASSIFY_THRESHOLDS.deathDepth
    && metrics.collapseAt >= CLASSIFY_THRESHOLDS.deathLate;
  if (collapses) return ANIMATION_STATES.DEATH;
  if (metrics.travelSpeed > CLASSIFY_THRESHOLDS.runSpeed) return ANIMATION_STATES.RUN;
  if (metrics.travelSpeed > CLASSIFY_THRESHOLDS.walkSpeed) return ANIMATION_STATES.WALK;
  const airborne = Math.max(metrics.verticalRange ?? 0, metrics.rise ?? 0);
  if (airborne > CLASSIFY_THRESHOLDS.jumpRise) return ANIMATION_STATES.JUMP;
  return ANIMATION_STATES.IDLE;
}

/**
 * Remove horizontal root translation from a clip while keeping the vertical
 * channel, so a server-positioned operator cannot drift out of its capsule.
 */
export function stripHorizontalRootMotion(clip, {
  rootBoneName = 'Hips',
  verticalAxis = 2,
} = {}) {
  const tracks = clip.tracks.map((track) => {
    if (!isPositionTrack(track) || !trackNodeName(track).includes(rootBoneName)) return track.clone();
    const values = Float32Array.from(track.values);
    const restX = values[0];
    const restY = values[1];
    const restZ = values[2];
    for (let index = 0; index < values.length; index += 3) {
      if (verticalAxis !== 0) values[index] = restX;
      if (verticalAxis !== 1) values[index + 1] = restY;
      if (verticalAxis !== 2) values[index + 2] = restZ;
    }
    const clone = track.clone();
    clone.values = values;
    return clone;
  });
  return new THREE.AnimationClip(`${clip.name}#inplace`, clip.duration, tracks, clip.blendMode);
}

/** Shorten a clip so a clamped, non-looping action settles on its final pose. */
export function trimClip(clip, fraction = 0.84) {
  const ratio = Math.max(0.05, Math.min(1, fraction));
  return new THREE.AnimationClip(
    `${clip.name}#trim`,
    clip.duration * ratio,
    clip.tracks.map((track) => track.clone()),
    clip.blendMode,
  );
}

function scoreCandidate(state, metrics) {
  switch (state) {
    case ANIMATION_STATES.RUN:
      return metrics.travelSpeed;
    case ANIMATION_STATES.WALK:
      return metrics.travelSpeed - Math.abs(metrics.travelSpeed - 1.4) * 0.4;
    case ANIMATION_STATES.JUMP:
      return Math.max(metrics.verticalRange ?? 0, metrics.rise ?? 0);
    case ANIMATION_STATES.DEATH:
      return metrics.collapseDepth + metrics.collapseAt;
    default:
      return -metrics.travelSpeed * 2 - metrics.verticalRange;
  }
}

/**
 * Build the locomotion set from an asset's clip list.
 *
 * @param {THREE.Object3D} root source scene, used for measurement only
 * @param {THREE.AnimationClip[]} clips
 * @returns {{states:Record<string, THREE.AnimationClip>, strides:Record<string, number>,
 *   metrics:Array<object>, warnings:string[], verticalAxis:number}}
 */
export function buildAnimationSet(root, clips = [], { samples = 24 } = {}) {
  const warnings = [];
  const verticalAxis = detectVerticalAxis(root);
  const measured = [];

  for (const clip of clips) {
    if (!clip || !clip.tracks?.length) {
      warnings.push(`Clip '${clip?.name ?? 'unknown'}' has no tracks and was skipped.`);
      continue;
    }
    const metrics = measureClip(root, clip, { samples });
    // Flattened so callers can read `state` and the measurements side by side.
    measured.push({ clip, metrics, state: classifyClip(metrics), ...metrics });
  }

  const best = new Map();
  for (const entry of measured) {
    const current = best.get(entry.state);
    if (!current || scoreCandidate(entry.state, entry.metrics) > scoreCandidate(entry.state, current.metrics)) {
      best.set(entry.state, entry);
    }
  }

  const states = {};
  const strides = { idle: LOCOMOTION_SPEED.idle };
  const prepare = (state) => {
    const entry = best.get(state);
    if (!entry) return null;
    let clip = stripHorizontalRootMotion(entry.clip, { verticalAxis });
    if (state === ANIMATION_STATES.DEATH) clip = trimClip(clip, 0.84);
    clip.name = `${state}:${entry.clip.name}`;
    states[state] = clip;
    return entry;
  };

  prepare(ANIMATION_STATES.IDLE);
  const walk = prepare(ANIMATION_STATES.WALK);
  const run = prepare(ANIMATION_STATES.RUN);
  prepare(ANIMATION_STATES.JUMP);
  prepare(ANIMATION_STATES.DEATH);

  if (walk) strides.walk = walk.metrics.travelSpeed > 0.1 ? walk.metrics.travelSpeed : LOCOMOTION_SPEED.walk;
  if (run) strides.run = run.metrics.travelSpeed > 0.5 ? run.metrics.travelSpeed : LOCOMOTION_SPEED.run;
  if (!strides.walk) strides.walk = strides.run ?? LOCOMOTION_SPEED.walk;
  if (!strides.run) strides.run = Math.max(strides.walk * 2, LOCOMOTION_SPEED.run);

  // Never leave the rig frozen: fall back through whatever clips exist.
  if (!states[ANIMATION_STATES.IDLE]) {
    const fallback = states[ANIMATION_STATES.WALK]
      ?? states[ANIMATION_STATES.RUN]
      ?? states[ANIMATION_STATES.JUMP]
      ?? states[ANIMATION_STATES.DEATH];
    if (fallback) {
      states[ANIMATION_STATES.IDLE] = fallback;
      warnings.push('No stationary clip found; another state is used as idle.');
    }
  }
  if (!states[ANIMATION_STATES.WALK] && states[ANIMATION_STATES.RUN]) {
    states[ANIMATION_STATES.WALK] = states[ANIMATION_STATES.RUN];
    warnings.push('No walk clip found; the run clip is used at walking speeds.');
  }
  if (!states[ANIMATION_STATES.RUN] && states[ANIMATION_STATES.WALK]) {
    states[ANIMATION_STATES.RUN] = states[ANIMATION_STATES.WALK];
  }
  if (!Object.keys(states).length) warnings.push('No usable animation clips were supplied.');

  return { states, strides, metrics: measured, warnings, verticalAxis };
}

const STATE_FADE = Object.freeze({
  [ANIMATION_STATES.IDLE]: 0.24,
  [ANIMATION_STATES.WALK]: 0.18,
  [ANIMATION_STATES.RUN]: 0.16,
  [ANIMATION_STATES.JUMP]: 0.12,
  [ANIMATION_STATES.DEATH]: 0.08,
});

/**
 * One animated operator: an independent skinned clone with its own mixer,
 * actions and materials, so tinting or disposing one never touches the others.
 */
export class CharacterRig {
  constructor(source, animationSet, { tint = null, scale = 1 } = {}) {
    if (!source) throw new Error('CharacterRig requires a source scene');
    this.source = source;
    this.animationSet = animationSet ?? { states: {}, strides: {} };
    this.root = cloneSkinned(source);
    if (scale !== 1) this.root.scale.multiplyScalar(scale);
    this.ownedMaterials = [];
    this.state = null;
    this.dead = false;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();

    for (const [state, clip] of Object.entries(this.animationSet.states ?? {})) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      if (state === ANIMATION_STATES.DEATH) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      this.actions.set(state, action);
    }

    if (tint) this.tint(tint);
    this.setState(ANIMATION_STATES.IDLE, { fade: 0 });
  }

  get object() {
    return this.root;
  }

  get currentAction() {
    return this.state ? this.actions.get(this.state) ?? null : null;
  }

  get rightHand() {
    return this.root.getObjectByName(WEAPON_HAND_BONE) ?? null;
  }

  getBone(name) {
    return this.root.getObjectByName(name) ?? null;
  }

  /** Clone materials once so tinting this operator cannot affect the others. */
  tint(color) {
    const accent = new THREE.Color(color);
    this.root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const wasArray = Array.isArray(node.material);
      const materials = wasArray ? node.material : [node.material];
      const owned = materials.map((material) => {
        const clone = material.clone();
        if (clone.emissive) {
          clone.emissive.copy(accent).multiplyScalar(0.18);
          clone.emissiveIntensity = 1;
        }
        this.ownedMaterials.push(clone);
        return clone;
      });
      node.material = wasArray ? owned : owned[0];
    });
    return this;
  }

  /**
   * Cross-fade to a state. Safe to call every frame: re-requesting the current
   * state only updates its playback rate.
   *
   * @returns {THREE.AnimationAction|null} the active action
   */
  setState(state, { fade = STATE_FADE[state] ?? 0.2, timeScale = 1 } = {}) {
    const resolved = this.actions.has(state)
      ? state
      : (this.actions.has(ANIMATION_STATES.IDLE) ? ANIMATION_STATES.IDLE : [...this.actions.keys()][0]);
    if (!resolved) return null;

    const action = this.actions.get(resolved);
    action.setEffectiveTimeScale(Math.max(0.05, Math.min(3, timeScale)));

    if (this.state === resolved) {
      if (!action.isRunning() && resolved !== ANIMATION_STATES.DEATH) action.play();
      return action;
    }

    const previous = this.currentAction;
    action.reset();
    action.setEffectiveWeight(1);
    action.play();
    if (previous && previous !== action) {
      if (fade > 0) action.crossFadeFrom(previous, fade, false);
      else previous.stop();
    } else if (fade > 0) {
      action.fadeIn(fade);
    }

    this.state = resolved;
    this.dead = resolved === ANIMATION_STATES.DEATH;
    return action;
  }

  /**
   * Pick idle/walk/run from a measured travel speed and match the footfall rate
   * to it so the operator never moon-walks. A dead operator stays down.
   */
  setLocomotion(speed, { force = false } = {}) {
    if (this.dead && !force) return this.currentAction;
    const numeric = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    if (numeric < 0.35) return this.setState(ANIMATION_STATES.IDLE, { timeScale: 1 });

    const running = numeric >= 2.4;
    const state = running ? ANIMATION_STATES.RUN : ANIMATION_STATES.WALK;
    const stride = this.animationSet.strides?.[state]
      || (running ? LOCOMOTION_SPEED.run : LOCOMOTION_SPEED.walk);
    const timeScale = Math.max(0.65, Math.min(1.9, numeric / Math.max(0.3, stride)));
    return this.setState(state, { timeScale });
  }

  setJumping() {
    return this.setState(ANIMATION_STATES.JUMP, { fade: 0.1 });
  }

  setDead() {
    return this.setState(ANIMATION_STATES.DEATH, { fade: 0.08 });
  }

  /** Reset to idle after a respawn, cancelling a clamped death pose. */
  revive() {
    this.dead = false;
    for (const action of this.actions.values()) action.stop();
    this.state = null;
    return this.setState(ANIMATION_STATES.IDLE, { fade: 0 });
  }

  update(delta) {
    this.mixer.update(Math.max(0, Math.min(0.25, Number(delta) || 0)));
    return this;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
    this.actions.clear();
    this.root.removeFromParent();
    this.state = null;
    return this;
  }
}
