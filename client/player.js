import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';
import { assetManager } from './AssetManager.js';

const INTERPOLATION_DELAY_MS = 90;
const MAX_EXTRAPOLATION_MS = 130;
const SKIN_TONES = ['#d6a17e', '#b98462', '#e2b18c', '#8b5d47', '#c68b6d'];
const EYE_COLORS = ['#39c7dc', '#72a9ff', '#67d99c', '#c18aff'];
const WEAPON_SWITCH_MS = 220;
const REMOTE_MODEL_SCALE = 0.82;
const FLASH_COLORS = Object.freeze({
  RUSHER: '#59d8ff',
  GHOST: '#c18aff',
  HEAVY: '#ff8b3d',
  GODS_TIER: '#ffd45e',
});

function angleDelta(from, to) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function blend(left, right, amount) {
  return left + (right - left) * amount;
}

function numericHash(value) {
  let hash = 0;
  for (const character of String(value ?? '')) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

// Buffers the 20 Hz authoritative snapshots and interpolates them between
// render frames. It is presentation smoothing only; the client never simulates
// or predicts player movement.
export class StateInterpolator {
  constructor() {
    this.states = new Map();
  }

  push(players, receivedAt = performance.now()) {
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

  sample(playerId, renderAt = performance.now() - INTERPOLATION_DELAY_MS) {
    const samples = this.states.get(playerId)?.samples;
    if (!samples?.length) return null;
    if (samples.length === 1 || renderAt <= samples[0].receivedAt) return samples[0];

    for (let index = 0; index < samples.length - 1; index += 1) {
      const before = samples[index];
      const after = samples[index + 1];
      if (renderAt > after.receivedAt) continue;

      const span = after.receivedAt - before.receivedAt;
      const amount = span > 0 ? Math.max(0, Math.min(1, (renderAt - before.receivedAt) / span)) : 1;
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
    const extrapolation = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, renderAt - latest.receivedAt)) / 1_000;
    return {
      ...latest,
      x: latest.x + latest.vx * extrapolation,
      y: Math.max(0, latest.y + latest.vy * extrapolation),
      z: latest.z + latest.vz * extrapolation,
    };
  }

  clear() {
    this.states.clear();
  }
}

// Mouse look and keyboard sampling only. Position is always taken from the
// server snapshots in main.js; this controller intentionally has no movement.
export class PlayerController {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;
    this.enabled = false;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.wheelDelta = 0;

    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.clearKeys = this.clearKeys.bind(this);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('blur', this.clearKeys);
  }

  handleMouseMove(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - event.movementY * this.sensitivity));
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  handleWheel(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    // Prevent page scroll while in pointer lock
    event.preventDefault();
    // Store deltaY for external handler
    this.wheelDelta = event.deltaY;
  }

  handleKeyDown(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas || this.isTyping(event.target)) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
  }

  handleKeyUp(event) {
    this.keys.delete(event.code);
  }

  isTyping(element) {
    return element instanceof HTMLElement && (
      element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
    );
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.keys.clear();
  }

  getInput(sequence) {
    const active = this.enabled && document.pointerLockElement === this.canvas;
    const forward = active ? Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')) : 0;
    const strafe = active ? Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')) : 0;
    return {
      seq: sequence,
      forward,
      strafe,
      jump: active && this.keys.has('Space'),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  getWheelDelta() {
    // This will be set by the wheel handler
    const delta = this.wheelDelta;
    this.wheelDelta = 0;
    return delta;
  }

  clearKeys() {
    this.keys.clear();
  }

  dispose() {
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.clearKeys);
  }
}

// Rigged character GLBs with fallback to procedural low-poly operators.
export class RemotePlayers {
  constructor(scene, nameTagRoot, weaponModels) {
    this.scene = scene;
    this.nameTagRoot = nameTagRoot;
    this.weaponModels = weaponModels;
    this.players = new Map();
    this.projected = new THREE.Vector3();
    this.lastFrameTime = performance.now();
    this.weaponModels?.onReady(() => {
      for (const record of this.players.values()) this.equipWeapon(record, record.pendingWeaponId);
    });
  }

  addPart(record, parent, geometry, material, position, scale = [1, 1, 1], rotation = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    parent.add(mesh);
    record.geometries.push(geometry);
    return mesh;
  }

  createOperator(data) {
    const idHash = numericHash(data.id);
    const suitColor = new THREE.Color(data.color || '#57d6ff');
    const skinColor = SKIN_TONES[idHash % SKIN_TONES.length];
    const eyeColor = EYE_COLORS[Math.floor(idHash / 5) % EYE_COLORS.length];
    const mesh = new THREE.Group();
    mesh.userData.playerId = data.id;

    let characterInstance = null;
    let gunSocket = null;
    let muzzleFlash = null;
    const geometries = [];
    const materials = [];

    // Attempt to create a rigged character instance if GLB assets are loaded
    if (assetManager.ready && assetManager.hasCharacter()) {
      characterInstance = assetManager.createCharacterInstance();
    }

    if (characterInstance) {
      mesh.add(characterInstance.mesh);
      characterInstance.mesh.position.set(0, -PLAYER.height / 2, 0);
      characterInstance.mesh.scale.set(1, 1, 1);

      const rightHand = characterInstance.mesh.getObjectByName('mixamorigRightHand');
      gunSocket = new THREE.Group();
      if (rightHand) {
        gunSocket.position.set(0, 0.05, 0);
        gunSocket.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
        rightHand.add(gunSocket);
      } else {
        gunSocket.position.set(0.33, -0.015, -0.22);
        mesh.add(gunSocket);
      }

      const idleClip = assetManager.getAnimation('idle') || assetManager.getAnimation('pose');
      if (idleClip && characterInstance.mixer) {
        const idleAction = characterInstance.mixer.clipAction(idleClip);
        idleAction.loop = THREE.LoopRepeat;
        idleAction.play();
        characterInstance.currentAction = idleAction;
        characterInstance.currentActionName = 'idle';
      }
    } else {
      const mats = {
        armor: new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.53, metalness: 0.24, emissive: suitColor, emissiveIntensity: 0.08 }),
        armorDark: new THREE.MeshStandardMaterial({ color: '#202d3b', roughness: 0.7, metalness: 0.23 }),
        armorLight: new THREE.MeshStandardMaterial({ color: '#657c8d', roughness: 0.48, metalness: 0.48 }),
        skin: new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.82, metalness: 0.02 }),
        hair: new THREE.MeshStandardMaterial({ color: '#151b24', roughness: 0.94, metalness: 0.02 }),
        eyeWhite: new THREE.MeshStandardMaterial({ color: '#e7edf0', roughness: 0.32, metalness: 0.02 }),
        iris: new THREE.MeshStandardMaterial({ color: eyeColor, roughness: 0.35, metalness: 0.06, emissive: eyeColor, emissiveIntensity: 0.14 }),
        pupil: new THREE.MeshBasicMaterial({ color: '#10151c' }),
        mouth: new THREE.MeshStandardMaterial({ color: '#57392f', roughness: 0.9 }),
        glove: new THREE.MeshStandardMaterial({ color: '#101821', roughness: 0.76, metalness: 0.2 }),
        visor: new THREE.MeshStandardMaterial({ color: '#173b4a', roughness: 0.2, metalness: 0.58, emissive: '#16718a', emissiveIntensity: 0.22 }),
        sole: new THREE.MeshStandardMaterial({ color: '#0d141c', roughness: 0.9, metalness: 0.08 }),
      };
      materials.push(...Object.values(mats));

      const torso = new THREE.CapsuleGeometry(0.235, 0.45, 4, 9);
      this.addPart({ geometries }, mesh, torso, mats.armorDark, [0, -0.05, 0]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.36, 0.34, 0.12), mats.armor, [0, 0.08, -0.176]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.24, 0.055, 0.035), mats.armorLight, [0, 0.23, -0.246]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.12, 0.08, 0.032), mats.visor, [0, -0.03, -0.25]);
      this.addPart({ geometries }, mesh, new THREE.CylinderGeometry(0.19, 0.2, 0.075, 8), mats.armorLight, [0, -0.335, 0]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.16, 0.12, 0.08), mats.armorDark, [0, -0.38, 0.17]);

      const neck = new THREE.CylinderGeometry(0.075, 0.09, 0.16, 8);
      this.addPart({ geometries }, mesh, neck, mats.skin, [0, 0.39, 0]);
      const head = new THREE.SphereGeometry(0.19, 16, 12);
      this.addPart({ geometries }, mesh, head, mats.skin, [0, 0.62, -0.005], [0.9, 1.08, 0.9]);
      const hair = new THREE.SphereGeometry(0.195, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56);
      this.addPart({ geometries }, mesh, hair, mats.hair, [0, 0.72, 0.008], [0.98, 0.64, 0.98]);

      for (const side of [-1, 1]) {
        const eyeX = side * 0.064;
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.034, 10, 8), mats.eyeWhite, [eyeX, 0.643, -0.163], [1.05, 0.72, 0.62]);
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.018, 8, 6), mats.iris, [eyeX, 0.642, -0.185]);
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.009, 7, 5), mats.pupil, [eyeX, 0.642, -0.198]);
        this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.076, 0.018, 0.018), mats.hair, [eyeX, 0.694, -0.16], [1, 1, 1], [0, 0, side * -0.08]);
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.061, 8, 7), mats.skin, [side * 0.168, 0.62, -0.005], [0.58, 0.86, 0.55]);
        this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.045, 0.12, 0.06), mats.armorDark, [side * 0.198, 0.64, -0.006]);
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.115, 10, 8), mats.armor, [side * 0.31, 0.18, 0], [1, 0.72, 1.03]);
        this.addPart({ geometries }, mesh, new THREE.CapsuleGeometry(0.07, 0.31, 3, 7), mats.armorDark, [side * 0.37, -0.06, -0.025], [1, 1, 1], [0.08, 0, side * -0.18]);
        this.addPart({ geometries }, mesh, new THREE.CapsuleGeometry(0.052, 0.23, 3, 7), mats.armorLight, [side * 0.4, -0.24, -0.07], [1, 1, 1], [0.14, 0, side * -0.12]);
        this.addPart({ geometries }, mesh, new THREE.SphereGeometry(0.066, 8, 7), mats.glove, [side * 0.41, -0.4, -0.12], [1, 0.82, 1.1]);
        this.addPart({ geometries }, mesh, new THREE.CapsuleGeometry(0.09, 0.31, 3, 7), mats.armorDark, [side * 0.12, -0.6, 0.012]);
        this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.14, 0.11, 0.18), mats.armor, [side * 0.12, -0.78, -0.015]);
        this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.145, 0.06, 0.2), mats.sole, [side * 0.12, -0.86, -0.018]);
        this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.19, 0.11, 0.055), mats.armorLight, [side * 0.12, -0.59, -0.105]);
      }

      const nose = new THREE.ConeGeometry(0.031, 0.09, 6);
      this.addPart({ geometries }, mesh, nose, mats.skin, [0, 0.61, -0.194], [1, 1, 1], [-Math.PI / 2, 0, 0]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.086, 0.015, 0.013), mats.mouth, [0, 0.535, -0.174]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.12, 0.025, 0.015), mats.hair, [0, 0.49, -0.164]);
      this.addPart({ geometries }, mesh, new THREE.BoxGeometry(0.13, 0.06, 0.07), mats.armorDark, [0, -0.47, -0.025]);

      gunSocket = new THREE.Group();
      gunSocket.position.set(0.33, -0.015, -0.22);
      mesh.add(gunSocket);
    }

    muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#ffe3a0', transparent: true, opacity: 0.95 }),
    );
    muzzleFlash.visible = false;
    gunSocket.add(muzzleFlash);

    const shieldGeometry = new THREE.SphereGeometry(0.49, 12, 8);
    const shieldMaterial = new THREE.MeshBasicMaterial({ color: '#59d8ff', wireframe: true, transparent: true, opacity: 0.36, depthWrite: false });
    const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
    geometries.push(shieldGeometry);
    materials.push(shieldMaterial);
    shield.scale.y = 1.8;
    mesh.add(shield);
    shield.visible = false;

    const label = document.createElement('div');
    label.className = 'name-tag';
    label.style.setProperty('--player-color', data.color || '#57d8ff');
    const nameLabel = document.createElement('span');
    nameLabel.className = 'name-tag-name';
    nameLabel.textContent = data.name;
    const weaponLabel = document.createElement('span');
    weaponLabel.className = 'name-tag-weapon';
    label.append(nameLabel, weaponLabel);

    const record = {
      mesh,
      characterInstance,
      materials,
      geometries,
      name: data.name,
      color: data.color,
      weaponId: null,
      pendingWeaponId: data.currentWeaponId,
      weaponModel: null,
      weaponTransition: null,
      gunSocket,
      muzzleFlash,
      muzzleFlashUntil: 0,
      shield,
      label,
      nameLabel,
      weaponLabel,
      currentAnim: 'idle',
      lastAnimUpdate: performance.now(),
    };

    this.nameTagRoot.append(label);
    this.scene.add(mesh);
    this.players.set(data.id, record);
    this.equipWeapon(record, data.currentWeaponId);
    return record;
  }

  ensurePlayer(data) {
    return this.players.get(data.id) ?? this.createOperator(data);
  }

  equipWeapon(record, weaponId) {
    if (!weaponId) return;
    record.pendingWeaponId = weaponId;
    if (record.weaponModel?.userData.weaponId === weaponId) return;
    const next = this.weaponModels?.createModel(weaponId);
    if (!next) return;

    const previous = record.weaponModel;
    if (record.weaponTransition) {
      const { from, to } = record.weaponTransition;
      if (from && from !== previous) record.gunSocket.remove(from);
      if (to && to !== previous) record.gunSocket.remove(to);
      record.weaponTransition = null;
    }
    if (previous) {
      previous.scale.copy(previous.userData.baseScale);
      previous.position.set(0, 0, 0);
      previous.rotation.set(0, 0, 0);
    }
    next.scale.multiplyScalar(REMOTE_MODEL_SCALE);
    next.userData.baseScale = next.scale.clone();
    record.gunSocket.add(next);
    record.weaponModel = next;
    record.weaponId = weaponId;
    if (previous) {
      record.weaponTransition = { from: previous, to: next, startedAt: performance.now() };
    } else {
      next.scale.multiplyScalar(0.88);
      next.position.y = 0.08;
      record.weaponTransition = { from: null, to: next, startedAt: performance.now() };
    }
  }

  updateWeapon(record, now) {
    if (record.pendingWeaponId && record.weaponModel?.userData.weaponId !== record.pendingWeaponId) {
      this.equipWeapon(record, record.pendingWeaponId);
    }
    if (record.weaponTransition) {
      const { from, to, startedAt } = record.weaponTransition;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / WEAPON_SWITCH_MS));
      if (from) {
        from.position.y = -progress * 0.12;
        from.rotation.x = -progress * 0.12;
        from.scale.copy(from.userData.baseScale).multiplyScalar(1 - progress * 0.12);
      }
      to.position.y = (1 - progress) * 0.08;
      to.rotation.x = (1 - progress) * 0.08;
      to.scale.copy(to.userData.baseScale).multiplyScalar(0.88 + progress * 0.12);
      if (progress >= 1) {
        if (from) record.gunSocket.remove(from);
        to.position.set(0, 0, 0);
        to.rotation.set(0, 0, 0);
        to.scale.copy(to.userData.baseScale);
        record.weaponTransition = null;
      }
    }
    record.muzzleFlash.visible = now < record.muzzleFlashUntil;
  }

  updatePlayerAnimation(record, pose, delta) {
    if (!record.characterInstance?.mixer) return;
    record.characterInstance.mixer.update(delta);

    const speed = Math.hypot(pose.vx ?? 0, pose.vz ?? 0);
    let targetAnim = 'idle';
    if (!pose.alive) {
      targetAnim = 'death';
    } else if (speed > 4.5) {
      targetAnim = 'run';
    } else if (speed > 0.3) {
      targetAnim = 'walk';
    }

    if (record.currentAnim !== targetAnim) {
      const targetClip = assetManager.getAnimation(targetAnim)
        || (targetAnim === 'run' ? assetManager.getAnimation('walk') : null)
        || assetManager.getAnimation('idle')
        || assetManager.getAnimation('pose');
      if (targetClip) {
        const nextAction = record.characterInstance.mixer.clipAction(targetClip);
        if (targetAnim === 'death') {
          nextAction.setLoop(THREE.LoopOnce, 1);
          nextAction.clampWhenFinished = true;
        } else {
          nextAction.setLoop(THREE.LoopRepeat);
        }
        if (record.characterInstance.currentAction) {
          record.characterInstance.currentAction.crossFadeTo(nextAction, 0.2, true);
        }
        nextAction.play();
        record.characterInstance.currentAction = nextAction;
        record.currentAnim = targetAnim;
      }
    }
  }

  flashWeapon(playerId, weaponId, bundleId, now = performance.now()) {
    const record = this.players.get(playerId);
    if (!record || !weaponId || ['KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD'].includes(weaponId)) return;
    this.equipWeapon(record, weaponId);
    record.muzzleFlash.material.color.set(FLASH_COLORS[bundleId] ?? FLASH_COLORS.RUSHER);
    record.muzzleFlashUntil = now + 65;
    record.muzzleFlash.position.set(0, 0.015, -((this.weaponModels?.getLength(weaponId) ?? 0.36) * REMOTE_MODEL_SCALE) / 2);
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

    for (const data of players) {
      if (data.id === localPlayerId) continue;
      const record = this.ensurePlayer(data);
      const pose = interpolator.sample(data.id, renderAt) ?? data;
      record.name = data.name;
      record.nameLabel.textContent = data.name;
      const weaponName = data.currentWeaponName ?? data.currentWeaponId ?? '';
      const weaponIcon = data.currentWeaponIcon ?? '';
      record.weaponLabel.textContent = pose.connected === false
        ? 'OFFLINE · RECONNECTING'
        : weaponName ? `${weaponIcon} ${weaponName}` : '';
      record.label.classList.toggle('is-offline', pose.connected === false);
      record.color = data.color;
      record.label.style.setProperty('--player-color', data.color || '#57d8ff');
      this.equipWeapon(record, data.currentWeaponId);
      this.updateWeapon(record, now);
      this.updatePlayerAnimation(record, pose, delta);
      record.gunSocket.rotation.x = Number(pose.pitch) || 0;

      const showingKnockback = !pose.alive && Math.hypot(pose.vx ?? 0, pose.vz ?? 0) > 1.5;
      const connected = pose.connected !== false;
      record.mesh.visible = Boolean(connected && (pose.alive || showingKnockback));
      record.label.hidden = !pose.alive;
      if (!pose.alive && !showingKnockback) continue;

      record.mesh.position.set(pose.x, pose.y + PLAYER.height / 2, pose.z);
      record.mesh.rotation.y = pose.yaw;
      record.mesh.rotation.z = showingKnockback ? Math.sign(pose.vx || pose.vz) * 0.5 : 0;
      record.shield.visible = Boolean(connected && pose.alive && pose.spawnProtected);
      record.label.classList.toggle('is-protected', Boolean(pose.spawnProtected));

      if (!pose.alive) continue;
      this.projected.set(pose.x, pose.y + PLAYER.height + 0.36, pose.z).project(camera);
      const onScreen = this.projected.z > -1 && this.projected.z < 1
        && this.projected.x > -1.2 && this.projected.x < 1.2
        && this.projected.y > -1.15 && this.projected.y < 1.2;
      record.label.style.display = onScreen ? 'block' : 'none';
      if (onScreen) {
        record.label.style.left = `${(this.projected.x * 0.5 + 0.5) * width}px`;
        record.label.style.top = `${(-this.projected.y * 0.5 + 0.5) * height}px`;
      }
    }
  }

  removePlayer(id, record = this.players.get(id)) {
    if (!record) return;
    this.scene.remove(record.mesh);
    if (record.characterInstance) {
      record.characterInstance.dispose();
    }
    record.geometries.forEach((geometry) => geometry.dispose());
    record.materials.forEach((material) => material.dispose());
    record.muzzleFlash.geometry.dispose();
    record.muzzleFlash.material.dispose();
    this.nameTagRoot.removeChild(record.label);
    this.players.delete(id);
  }

  clear() {
    for (const [id, record] of this.players) this.removePlayer(id, record);
  }
}
