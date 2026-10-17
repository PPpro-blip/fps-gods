import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';

const INTERPOLATION_DELAY_MS = 90;
const MAX_EXTRAPOLATION_MS = 130;

function angleDelta(from, to) {
  return ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function blend(left, right, amount) {
  return left + (right - left) * amount;
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

    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.clearKeys = this.clearKeys.bind(this);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.clearKeys);
  }

  handleMouseMove(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - event.movementY * this.sensitivity));
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
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

// Simple colored capsules and HTML name labels for every remote operator.
export class RemotePlayers {
  constructor(scene, nameTagRoot) {
    this.scene = scene;
    this.nameTagRoot = nameTagRoot;
    this.players = new Map();
    this.projected = new THREE.Vector3();
    this.capsuleGeometry = new THREE.CapsuleGeometry(
      PLAYER.radius,
      PLAYER.height - PLAYER.radius * 2,
      4,
      8,
    );
  }

  ensurePlayer(data) {
    if (this.players.has(data.id)) return this.players.get(data.id);
    const color = new THREE.Color(data.color || '#57d6ff');
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.5,
      metalness: 0.12,
      emissive: color,
      emissiveIntensity: 0.11,
    });
    const mesh = new THREE.Mesh(this.capsuleGeometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.playerId = data.id;
    this.scene.add(mesh);

    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(0.49, 12, 8),
      new THREE.MeshBasicMaterial({
        color: '#59d8ff',
        wireframe: true,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );
    shield.scale.y = 1.8;
    mesh.add(shield);
    shield.visible = false;

    const label = document.createElement('div');
    label.className = 'name-tag';
    label.style.setProperty('--player-color', data.color || '#57d6ff');
    const nameLabel = document.createElement('span');
    nameLabel.className = 'name-tag-name';
    nameLabel.textContent = data.name;
    const weaponLabel = document.createElement('span');
    weaponLabel.className = 'name-tag-weapon';
    weaponLabel.textContent = data.currentWeaponName ?? data.currentWeaponId ?? '';
    label.append(nameLabel, weaponLabel);
    this.nameTagRoot.append(label);

    const record = { mesh, label, shield, nameLabel, weaponLabel, name: data.name, color: data.color, alive: true };
    this.players.set(data.id, record);
    return record;
  }

  update(players, interpolator, camera, renderAt, localPlayerId) {
    const currentIds = new Set(players.map((player) => player.id));
    for (const [id, record] of this.players) {
      if (!currentIds.has(id) || id === localPlayerId) this.removePlayer(id, record);
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    for (const data of players) {
      if (data.id === localPlayerId) continue;
      const record = this.ensurePlayer(data);
      const pose = interpolator.sample(data.id, renderAt) ?? data;
      record.name = data.name;
      record.nameLabel.textContent = data.name;
      const weaponName = data.currentWeaponName ?? data.currentWeaponId ?? '';
      const weaponIcon = data.currentWeaponIcon ?? '';
      record.weaponLabel.textContent = weaponName ? `${weaponIcon} ${weaponName}` : '';
      record.color = data.color;
      record.label.style.setProperty('--player-color', data.color || '#57d8ff');
      const showingKnockback = !pose.alive && Math.hypot(pose.vx ?? 0, pose.vz ?? 0) > 1.5;
      record.mesh.visible = Boolean(pose.alive || showingKnockback);
      record.label.hidden = !pose.alive;
      if (!pose.alive && !showingKnockback) continue;

      record.mesh.position.set(pose.x, pose.y + PLAYER.height / 2, pose.z);
      record.mesh.rotation.y = pose.yaw;
      record.mesh.rotation.z = showingKnockback ? Math.sign(pose.vx || pose.vz) * 0.5 : 0;
      record.shield.visible = Boolean(pose.alive && pose.spawnProtected);
      record.label.classList.toggle('is-protected', Boolean(pose.spawnProtected));

      if (!pose.alive) continue;
      this.projected.set(pose.x, pose.y + PLAYER.height + 0.28, pose.z).project(camera);
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
    record.mesh.material.dispose();
    record.shield.geometry.dispose();
    record.shield.material.dispose();
    this.nameTagRoot.removeChild(record.label);
    this.players.delete(id);
  }

  clear() {
    for (const [id, record] of this.players) this.removePlayer(id, record);
  }
}
