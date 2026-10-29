import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { createOperator } from './operator.js';

const INTERPOLATION_DELAY_MS = 75;
const MAX_EXTRAPOLATION_MS = 130;
const WEAPON_SWITCH_MS = 160;
// Creating a dressed skinned rig is a measurable synchronous task. Spread
// join bursts across frames instead of constructing all five bots at once.
const MAX_NEW_REMOTE_PER_FRAME = 2;
const FLASH_COLORS = Object.freeze({
  RUSHER: '#59d8ff',
  GHOST: '#c18aff',
  HEAVY: '#ff8b3d',
  GODS_TIER: '#ffd45e',
});
const HITSCAN_FLASH = new Set(['SMG', 'SHOTGUN', 'PISTOL', 'SNIPER', 'LMG', 'ROCKET', 'RAILGUN', 'MINIGUN']);
const MOVEMENT_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

function angleDelta(from, to) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function blend(left, right, amount) {
  return left + (right - left) * amount;
}

// Buffers authoritative snapshots for remote-player interpolation. The local
// player uses separate prediction/reconciliation rather than this delayed view.
export class StateInterpolator {
  constructor(delayMs = INTERPOLATION_DELAY_MS) {
    this.baseDelayMs = delayMs;
    this.delayMs = delayMs;
    this.lastPushAt = null;
    this.jitterMs = 0;
    this.states = new Map();
  }

  push(players, receivedAt = performance.now()) {
    if (Number.isFinite(this.lastPushAt)) {
      const gap = Math.max(0, receivedAt - this.lastPushAt);
      // 20 Hz server snapshots arrive ~50ms apart; widen the interpolation
      // buffer slightly when high-RTT internet jitter bunches snapshots.
      const deviation = Math.min(80, Math.abs(gap - 50));
      this.jitterMs = this.jitterMs * 0.82 + deviation * 0.18;
      this.delayMs = Math.min(135, Math.round(this.baseDelayMs + this.jitterMs * 0.9));
    }
    this.lastPushAt = receivedAt;

    const seen = new Set();
    for (const player of players) {
      seen.add(player.id);
      let entry = this.states.get(player.id);
      if (!entry) {
        entry = { samples: [] };
        this.states.set(player.id, entry);
      }
      entry.samples.push({ ...player, receivedAt });
      if (entry.samples.length > 12) entry.samples.shift();
    }

    for (const id of this.states.keys()) {
      if (!seen.has(id)) this.states.delete(id);
    }
  }

  sample(playerId, renderAt = performance.now() - this.delayMs) {
    const samples = this.states.get(playerId)?.samples;
    if (!samples?.length) return null;
    const safeRenderAt = Number.isFinite(renderAt)
      ? renderAt
      : (samples[samples.length - 1].receivedAt - this.delayMs);
    if (samples.length === 1 || safeRenderAt <= samples[0].receivedAt) return samples[0];

    for (let index = 0; index < samples.length - 1; index += 1) {
      const before = samples[index];
      const after = samples[index + 1];
      if (safeRenderAt > after.receivedAt) continue;

      const span = after.receivedAt - before.receivedAt;
      const amount = span > 0 ? Math.max(0, Math.min(1, (safeRenderAt - before.receivedAt) / span)) : 1;
      return {
        ...after,
        x: blend(before.x, after.x, amount),
        y: blend(before.y, after.y, amount),
        z: blend(before.z, after.z, amount),
        yaw: before.yaw + angleDelta(before.yaw, after.yaw) * amount,
        pitch: blend(before.pitch, after.pitch, amount),
      };
    }

    const latest = samples[samples.length - 1];
    const extrapolation = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, safeRenderAt - latest.receivedAt)) / 1_000;
    return {
      ...latest,
      x: latest.x + (latest.vx ?? 0) * extrapolation,
      y: Math.max(0, latest.y + (latest.vy ?? 0) * extrapolation),
      z: latest.z + (latest.vz ?? 0) * extrapolation,
    };
  }

  clear() {
    this.states.clear();
    this.lastPushAt = null;
    this.jitterMs = 0;
    this.delayMs = this.baseDelayMs;
  }
}

// Mouse look and keyboard sampling only. The controller never chooses position;
// local presentation prediction and server authority are handled separately.
export class PlayerController {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;
    this.enabled = false;
    this.keys = new Set();
    this.jumpTapLatched = false;
    this.yaw = 0;
    this.pitch = 0;
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
    this.sensitivity = 0.0022;
    this.lookScale = 1;
    this.invertY = false;
    this.wheelDelta = 0;
    this.onInputEdge = null;

    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);

    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    window.addEventListener('blur', this.handleBlur);
    // A backgrounded tab never delivers keyup, which used to leave the player
    // walking forever after an alt-tab.
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  handleMouseMove(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    const movementX = Number(event.movementX) || 0;
    const movementY = Number(event.movementY) || 0;
    const scale = Number.isFinite(this.lookScale) ? THREE.MathUtils.clamp(this.lookScale, 0.15, 1) : 1;
    const step = this.sensitivity * scale;
    const dYaw = -movementX * step;
    const pitchDelta = movementY * step * (this.invertY ? -1 : 1);
    const prevPitch = this.pitch;
    this.yaw += dYaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - pitchDelta));
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.lookDeltaYaw += dYaw;
    this.lookDeltaPitch += (this.pitch - prevPitch);
  }

  handleWheel(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    event.preventDefault();
    this.wheelDelta += event.deltaY;
  }

  handleKeyDown(event) {
    if (this.isTyping(event.target)) return;
    // Capture movement keys even while pointer-lock is still settling so holding
    // W as the match starts or as the canvas locks responds on frame zero
    // instead of stalling until a fresh key re-press or OS key-repeat event.
    if (!this.enabled && !MOVEMENT_CODES.has(event.code)) return;
    const locked = document.pointerLockElement === this.canvas;
    if (this.enabled && locked && MOVEMENT_CODES.has(event.code)) {
      event.preventDefault();
    }
    const wasDown = this.keys.has(event.code);
    this.keys.add(event.code);
    if (event.code === 'Space' && this.enabled && locked && !wasDown) {
      this.jumpTapLatched = true;
    }
    if (!wasDown && this.enabled && locked && MOVEMENT_CODES.has(event.code)) {
      this.onInputEdge?.();
    }
  }

  handleKeyUp(event) {
    const hadKey = this.keys.delete(event.code);
    if (hadKey && this.enabled && document.pointerLockElement === this.canvas && MOVEMENT_CODES.has(event.code)) {
      this.onInputEdge?.();
    }
  }

  handlePointerLockChange() {
    if (this.enabled && document.pointerLockElement === this.canvas && this.keys.size > 0) {
      this.onInputEdge?.();
    }
    if (document.pointerLockElement !== this.canvas) {
      this.jumpTapLatched = false;
    }
  }

  handleVisibilityChange() {
    if (document.hidden) {
      this.clearKeys();
    }
  }

  handleBlur() {
    this.clearKeys();
  }

  isTyping(element) {
    return element instanceof HTMLElement && (
      element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
    );
  }

  setEnabled(enabled, { preserveKeys = false } = {}) {
    const next = Boolean(enabled);
    if (this.enabled && !next) {
      if (preserveKeys) {
        this.resetTransientState();
      } else {
        this.clearKeys();
      }
    }
    this.enabled = next;
    if (next && document.pointerLockElement === this.canvas && this.keys.size > 0) {
      this.onInputEdge?.();
    }
  }

  setSensitivity(radiansPerPixel) {
    const numeric = Number(radiansPerPixel);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    this.sensitivity = Math.min(0.02, Math.max(0.0002, numeric));
  }

  setLookScale(scale) {
    this.lookScale = Number.isFinite(scale) ? THREE.MathUtils.clamp(scale, 0.15, 1) : 1;
  }

  setInvertY(invertY) {
    this.invertY = invertY === true;
  }

  getInput(sequence, { consumeJumpTap = false } = {}) {
    const active = this.enabled && document.pointerLockElement === this.canvas;
    const forward = active
      ? Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'))
      : 0;
    const strafe = active
      ? Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'))
      : 0;
    const jump = active && (this.keys.has('Space') || this.jumpTapLatched);
    if (consumeJumpTap && this.jumpTapLatched) {
      this.jumpTapLatched = false;
    }
    return {
      seq: sequence,
      forward,
      strafe,
      jump,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  getWheelDelta() {
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  consumeLookDelta() {
    const yaw = this.lookDeltaYaw;
    const pitch = this.lookDeltaPitch;
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
    return { yaw, pitch };
  }

  clearKeys() {
    this.keys.clear();
    this.jumpTapLatched = false;
    this.wheelDelta = 0;
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
  }

  /** Clear one-shot jump/wheel latches while preserving physically held WASD keys across respawns/overlays. */
  resetTransientState() {
    this.jumpTapLatched = false;
    this.wheelDelta = 0;
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
  }

  /** Full input reset for blur, tab hide, disconnect, and match teardown. */
  reset() {
    this.clearKeys();
  }

  dispose() {
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    document.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('blur', this.handleBlur);
  }
}

const fallbackGeometry = new THREE.CapsuleGeometry(0.34, 0.9, 4, 10);
const fallbackHeadGeometry = new THREE.SphereGeometry(0.17, 12, 10);
const fallbackVisorGeometry = new THREE.BoxGeometry(0.22, 0.05, 0.06);

function createFallbackOperator(color) {
  const group = new THREE.Group();
  const accent = new THREE.Color(color || '#57d6ff');
  const suitMaterial = new THREE.MeshStandardMaterial({ color: '#1a2430', roughness: 0.7, metalness: 0.25 });
  const visorMaterial = new THREE.MeshStandardMaterial({
    color: accent, emissive: accent, emissiveIntensity: 0.7, roughness: 0.3,
  });
  const body = new THREE.Mesh(fallbackGeometry, suitMaterial);
  body.position.y = 1.0;
  const head = new THREE.Mesh(fallbackHeadGeometry, suitMaterial);
  head.position.y = 1.66;
  const visor = new THREE.Mesh(fallbackVisorGeometry, visorMaterial);
  visor.position.set(0, 1.66, 0.15);
  const socket = new THREE.Group();
  socket.position.set(0.24, 1.34, 0.24);
  group.add(body, head, visor, socket);
  return {
    group,
    socket,
    rig: null,
    materials: [suitMaterial, visorMaterial],
    geometries: [fallbackGeometry, fallbackHeadGeometry, fallbackVisorGeometry],
  };
}

// Remote operators: the real rigged character when the asset is available, with
// a compact procedural stand-in when it is not. Every instance owns its mixer
// and materials and is disposed when the player leaves.
export class RemotePlayers {
  constructor(scene, nameTagRoot, weaponModels, assetManager) {
    this.scene = scene;
    this.nameTagRoot = nameTagRoot;
    this.weaponModels = weaponModels;
    this.assetManager = assetManager;
    this.players = new Map();
    this.projected = new THREE.Vector3();
    this.lastFrameTime = performance.now();
    this.weaponModels?.onReady?.(() => {
      for (const record of this.players.values()) this.equipWeapon(record, record.pendingWeaponId, true);
    });
  }

  createRecord(data) {
    const fallback = this.assetManager?.createCharacterRig?.();
    let operator;
    let group;
    let socket;
    let rig = null;

    if (fallback) {
      rig = fallback;
      operator = createOperator(rig, { tint: data.color });
      group = operator.group;
      socket = operator.socket;
    } else {
      const procedural = createFallbackOperator(data.color);
      operator = null;
      group = procedural.group;
      socket = procedural.socket;
      group.userData.fallback = procedural;
    }

    const muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#ffe3a0', transparent: true, opacity: 0.95 }),
    );
    muzzleFlash.visible = false;
    socket.add(muzzleFlash);

    const shieldGeometry = new THREE.SphereGeometry(0.52, 14, 10);
    const shieldMaterial = new THREE.MeshBasicMaterial({
      color: '#59d8ff', wireframe: true, transparent: true, opacity: 0.32, depthWrite: false,
    });
    const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
    shield.scale.y = 1.7;
    shield.position.y = 0.95;
    shield.visible = false;
    group.add(shield);

    const label = document.createElement('div');
    label.className = 'name-tag';
    label.style.setProperty('--player-color', data.color || '#57d8ff');
    const nameLabel = document.createElement('span');
    nameLabel.className = 'name-tag-name';
    nameLabel.textContent = data.name;
    const weaponLabel = document.createElement('span');
    weaponLabel.className = 'name-tag-weapon';
    label.append(nameLabel, weaponLabel);
    this.nameTagRoot.append(label);

    this.scene.add(group);
    const record = {
      id: data.id,
      group,
      operator,
      rig,
      socket,
      muzzleFlash,
      muzzleFlashUntil: 0,
      shield,
      label,
      nameLabel,
      weaponLabel,
      weaponId: null,
      pendingWeaponId: data.currentWeaponId,
      weaponModel: null,
      weaponTransition: null,
      hitFlashUntil: 0,
      hitHeadshot: false,
      dead: false,
      lastPoseAlive: true,
    };
    this.players.set(data.id, record);
    this.equipWeapon(record, data.currentWeaponId, true);
    return record;
  }

  ensurePlayer(data) {
    return this.players.get(data.id) ?? this.createRecord(data);
  }

  equipWeapon(record, weaponId, immediate = false) {
    if (!weaponId) return;
    record.pendingWeaponId = weaponId;
    if (record.weaponId === weaponId && record.weaponModel) return;
    const next = this.weaponModels?.createModel?.(weaponId);
    if (!next) return;

    const previous = record.weaponModel;
    if (previous) previous.removeFromParent();
    if (record.operator) {
      record.operator.setWeapon(next);
    } else {
      record.socket.add(next);
    }
    record.socket.add(record.muzzleFlash);
    next.userData.baseScale = next.scale.clone();
    next.userData.basePosition = next.position.clone();
    record.weaponModel = next;
    record.weaponId = weaponId;

    // Muzzle flash rides at the weapon's own tip, in the socket's local space.
    const muzzleOffset = (this.weaponModels?.getLength?.(weaponId) ?? 0.5) / 2;
    // The socket is yawed 180°, so the muzzle end is at local +Z.
    record.muzzleFlash.position.set(0, 0.02, muzzleOffset);

    if (!immediate) {
      const now = performance.now();
      record.weaponTransition = { startedAt: now, from: previous ?? null };
    }
  }

  updateWeaponTransition(record, now) {
    if (!record.weaponTransition) return;
    const { startedAt, from } = record.weaponTransition;
    const progress = Math.max(0, Math.min(1, (now - startedAt) / WEAPON_SWITCH_MS));
    if (from) {
      from.position.y = -progress * 0.18;
      from.scale.setScalar(1 - progress * 0.2);
    }
    if (record.weaponModel) {
      record.weaponModel.position.y = record.weaponModel.userData.basePosition.y + (1 - progress) * 0.18;
      record.weaponModel.scale.copy(record.weaponModel.userData.baseScale).multiplyScalar(0.8 + progress * 0.2);
    }
    if (progress >= 1) {
      if (from) from.removeFromParent();
      if (record.weaponModel) {
        record.weaponModel.position.copy(record.weaponModel.userData.basePosition);
        record.weaponModel.scale.copy(record.weaponModel.userData.baseScale);
      }
      record.weaponTransition = null;
    }
  }

  flashWeapon(playerId, weaponId, bundleId, now = performance.now()) {
    const record = this.players.get(playerId);
    if (!record || !HITSCAN_FLASH.has(weaponId)) return;
    this.equipWeapon(record, weaponId, true);
    record.muzzleFlash.material.color.set(FLASH_COLORS[bundleId] ?? FLASH_COLORS.RUSHER);
    record.muzzleFlashUntil = now + 60;
  }

  /**
   * Authoritative hit reaction triggered solely on server `HIT_CONFIRMED` so
   * landing shots on bots or opponents gives unmistakable visual confirmation.
   */
  triggerHitReaction(targetId, headshot = false, now = performance.now()) {
    const record = this.players.get(targetId);
    if (!record) return;
    record.hitFlashUntil = now + (headshot ? 150 : 110);
    record.hitHeadshot = Boolean(headshot);
  }

  update(players, interpolator, camera, renderAt, localPlayerId) {
    const currentIds = new Set(players.map((player) => player.id));
    for (const [id, record] of this.players) {
      if (!currentIds.has(id) || id === localPlayerId) this.removePlayer(id, record);
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    const now = performance.now();
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    let createdThisFrame = 0;
    for (const data of players) {
      if (data.id === localPlayerId) continue;
      if (!this.players.has(data.id)) {
        if (createdThisFrame >= MAX_NEW_REMOTE_PER_FRAME) continue;
        createdThisFrame += 1;
      }
      const record = this.ensurePlayer(data);
      const pose = interpolator.sample(data.id, renderAt) ?? data;
      const connected = pose.connected !== false;
      const alive = pose.alive !== false;

      const isBot = Boolean(data.isBot || String(data.id).startsWith('bot-'));
      record.nameLabel.textContent = isBot ? `BOT · ${data.name}` : data.name;
      record.label.style.setProperty('--player-color', data.color || '#57d8ff');
      const weaponName = data.currentWeaponName ?? data.currentWeaponId ?? '';
      record.weaponLabel.textContent = !connected
        ? 'OFFLINE · RECONNECTING'
        : pose.spawnProtected
          ? 'PROTECTED'
          : pose.reloading
            ? `${weaponName} · RELOADING`
            : weaponName;
      record.label.classList.toggle('is-bot', isBot);
      record.label.classList.toggle('is-offline', !connected);
      record.label.classList.toggle('is-protected', Boolean(pose.spawnProtected));
      record.label.classList.toggle('is-hit', now < record.hitFlashUntil);

      this.equipWeapon(record, data.currentWeaponId);
      this.updateWeaponTransition(record, now);
      record.muzzleFlash.visible = now < record.muzzleFlashUntil;

      const speed = Math.hypot(pose.vx ?? 0, pose.vz ?? 0);
      const airborne = pose.grounded === false && (pose.y > 0.08 || Math.abs(pose.vy ?? 0) > 0.9);
      if (record.rig) {
        if (alive) {
          if (record.dead) {
            record.rig.revive();
            record.dead = false;
          }
          if (airborne && typeof record.rig.setJumping === 'function') {
            record.rig.setJumping();
          } else {
            record.rig.setLocomotion(connected ? speed : 0);
          }
        } else if (!record.dead) {
          record.rig.setDead();
          record.dead = true;
        }
        record.rig.update(delta);
      }
      record.lastPoseAlive = alive;

      const hitFlinch = now < record.hitFlashUntil
        ? ((record.hitFlashUntil - now) / (record.hitHeadshot ? 150 : 110)) * (record.hitHeadshot ? -0.095 : -0.055)
        : 0;
      record.group.position.set(pose.x, pose.y, pose.z);
      record.group.rotation.set(hitFlinch, Number(pose.yaw) || 0, 0);
      record.group.visible = connected;
      record.shield.visible = Boolean(connected && alive && pose.spawnProtected);

      if (!connected) {
        record.label.style.display = 'none';
        continue;
      }

      if (!alive) {
        // The body stays on the floor while the respawn timer runs; the tag is
        // hidden so the arena does not fill with dead labels.
        record.label.style.display = 'none';
        continue;
      }

      this.projected.set(pose.x, pose.y + PLAYER.height + 0.34, pose.z).project(camera);
      const onScreen = this.projected.z > -1 && this.projected.z < 1
        && this.projected.x > -1.2 && this.projected.x < 1.2
        && this.projected.y > -1.15 && this.projected.y < 1.25;
      record.label.style.display = onScreen ? 'block' : 'none';
      if (onScreen) {
        record.label.style.left = `${(this.projected.x * 0.5 + 0.5) * width}px`;
        record.label.style.top = `${(-this.projected.y * 0.5 + 0.5) * height}px`;
      }
    }
  }

  removePlayer(id, record = this.players.get(id)) {
    if (!record) return;
    this.scene.remove(record.group);
    if (record.operator) {
      record.operator.dispose();
    } else {
      const fallback = record.group.userData.fallback;
      // Fallback geometry is module-shared by every operator; only its
      // per-instance materials can be disposed while others are still visible.
      for (const material of fallback?.materials ?? []) material.dispose();
    }
    record.muzzleFlash.geometry.dispose();
    record.muzzleFlash.material.dispose();
    record.shield.geometry.dispose();
    record.shield.material.dispose();
    record.label.remove();
    this.players.delete(id);
  }

  clear() {
    for (const [id, record] of [...this.players]) this.removePlayer(id, record);
  }
}
