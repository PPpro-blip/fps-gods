import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getWeapon, WEAPONS } from '../shared/weapons.js';

// First-person viewmodels and weapon feedback. Purely visual: the server
// independently resolves every shot, hit and reload. The seven GLB files in
// /assets/weapons are normalized into a common frame (barrel down -Z, length
// along Z, centered at the origin) so every gun sits correctly in the
// bottom-right of the camera view.

const MODEL_FILES = Object.freeze({
  smg: '/assets/weapons/smg.glb',
  shotgun: '/assets/weapons/shotgun.glb',
  sniper: '/assets/weapons/sniper.glb',
  pistol: '/assets/weapons/pistol.glb',
  lmg: '/assets/weapons/lmg.glb',
  rocket: '/assets/weapons/rocket.glb',
  knife: '/assets/weapons/knife.glb',
});

// The source meshes are authored with the barrel along +X and the profile in
// the XZ plane. This basis maps: model +X → camera -Z (forward), model +Y →
// camera -X (left/right width), model +Z → camera +Y (up).
const MODEL_ROTATION = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
));

// Per-weapon first-person placement inside the camera frame.
const VIEW_LAYOUT = Object.freeze({
  smg: { position: [0.3, -0.27, -0.52], rotation: [-0.04, 0.1, 0.02], hands: 'two', targetLength: 0.58 },
  shotgun: { position: [0.31, -0.28, -0.58], rotation: [-0.05, 0.12, 0.02], hands: 'two', targetLength: 0.66 },
  knife: { position: [0.3, -0.3, -0.42], rotation: [-0.15, 0.55, -0.35], hands: 'one', targetLength: 0.42 },
  pistol: { position: [0.28, -0.26, -0.5], rotation: [-0.03, 0.09, 0.02], hands: 'one', targetLength: 0.42 },
  sniper: { position: [0.32, -0.28, -0.62], rotation: [-0.04, 0.13, 0.02], hands: 'two', targetLength: 0.78 },
  smoke: { position: [0.3, -0.28, -0.45], rotation: [-0.1, 0.2, 0], hands: 'one', targetLength: 0.3 },
  lmg: { position: [0.32, -0.29, -0.6], rotation: [-0.04, 0.12, 0.02], hands: 'two', targetLength: 0.7 },
  rocket: { position: [0.31, -0.3, -0.6], rotation: [-0.06, 0.14, 0.02], hands: 'two', targetLength: 0.7 },
  shield: { position: [0.26, -0.32, -0.6], rotation: [-0.02, 0.18, 0.04], hands: 'one', targetLength: 0.6 },
  railgun: { position: [0.3, -0.28, -0.58], rotation: [-0.04, 0.12, 0.02], hands: 'two', targetLength: 0.72 },
  minigun: { position: [0.33, -0.3, -0.62], rotation: [-0.05, 0.13, 0.02], hands: 'two', targetLength: 0.72 },
  fist: { position: [0.3, -0.28, -0.45], rotation: [-0.12, 0.35, -0.1], hands: 'one', targetLength: 0.38 },
});

function gloveMaterial() {
  return new THREE.MeshStandardMaterial({ color: '#161d29', roughness: 0.85, metalness: 0.12 });
}

function makeHand(scale = 1) {
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.13), gloveMaterial());
  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.055, 0.1), gloveMaterial());
  fingers.position.set(0, -0.01, -0.1);
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.035, 0.075), gloveMaterial());
  thumb.position.set(0.045, 0.02, -0.02);
  const cuff = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.05, 0.08, 8),
    new THREE.MeshStandardMaterial({ color: '#223046', roughness: 0.7, metalness: 0.2 }),
  );
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, -0.01, 0.085);
  hand.add(palm, fingers, thumb, cuff);
  hand.scale.setScalar(scale);
  return hand;
}

function attachHands(anchor, mode, layout) {
  const gripHand = makeHand(0.95);
  gripHand.position.set(-0.015, -0.11, 0.16);
  gripHand.rotation.set(0.22, 0, 0);
  anchor.add(gripHand);
  if (mode === 'two') {
    const supportHand = makeHand(0.95);
    supportHand.position.set(0.01, -0.13, -0.16);
    supportHand.rotation.set(-0.35, Math.PI, 0);
    anchor.add(supportHand);
  }
}

// Normalized clone pipeline for the imported gun meshes.
function normalizeModel(source, targetLength) {
  const model = source.clone(true);
  model.quaternion.copy(MODEL_ROTATION);
  model.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.z, 1e-4);
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);

  model.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;
    if (child.material) {
      // The uploaded meshes come with plain materials; give them a touch of
      // metal response so they read under the arena lights.
      child.material = child.material.clone();
      if ('metalness' in child.material) child.material.metalness = Math.max(0.45, child.material.metalness ?? 0);
      if ('roughness' in child.material) child.material.roughness = Math.min(0.62, child.material.roughness ?? 0.5);
    }
  });

  return { model, box };
}

// Weapons without a GLB (GODS TIER items, shield, smoke) get complete
// procedural viewmodels so the wheel and HUD never show an empty slot.
function buildProcedural(weaponId) {
  const anchor = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: '#202b3d', roughness: 0.42, metalness: 0.72 });
  const glow = new THREE.MeshBasicMaterial({ color: '#59d8ff' });
  let muzzleZ = -0.4;

  if (weaponId === 'railgun') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.62), dark);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 10), glow);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.02, -0.1);
    const coil1 = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 8, 16), glow);
    coil1.position.set(0, 0.02, -0.18);
    const coil2 = coil1.clone();
    coil2.position.z = -0.32;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.19, 0.11), dark);
    grip.position.set(0, -0.15, 0.14);
    grip.rotation.x = -0.2;
    anchor.add(body, core, coil1, coil2, grip);
    muzzleZ = -0.42;
  } else if (weaponId === 'minigun') {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.42, 12), dark);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = -0.18;
    anchor.add(hub);
    for (let index = 0; index < 6; index += 1) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.5, 8), dark);
      barrel.rotation.x = Math.PI / 2;
      const angle = (index / 6) * Math.PI * 2;
      barrel.position.set(Math.cos(angle) * 0.075, Math.sin(angle) * 0.075, -0.3);
      anchor.add(barrel);
    }
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.24), dark);
    housing.position.set(0, -0.02, 0.1);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.11), dark);
    grip.position.set(0, -0.17, 0.12);
    anchor.add(housing, grip);
    muzzleZ = -0.56;
  } else if (weaponId === 'fist') {
    const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.13, 0.15), dark);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.035, 0.028), glow);
    ridge.position.set(0, 0.055, -0.072);
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.14, 10), gloveMaterial());
    wrist.rotation.x = Math.PI / 2;
    wrist.position.z = 0.13;
    for (let index = 0; index < 4; index += 1) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.05, 0.07), dark);
      finger.position.set(-0.058 + index * 0.039, -0.075, -0.045);
      anchor.add(finger);
    }
    anchor.add(knuckle, ridge, wrist);
    muzzleZ = -0.12;
  } else if (weaponId === 'shield') {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.86, 0.05),
      new THREE.MeshStandardMaterial({ color: '#243248', roughness: 0.35, metalness: 0.75 }),
    );
    panel.position.z = -0.15;
    const windowMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.18, 0.052),
      new THREE.MeshBasicMaterial({ color: '#59d8ff', transparent: true, opacity: 0.55 }),
    );
    windowMesh.position.set(0, 0.16, -0.15);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.045, 0.06), glow);
    rim.position.set(0, 0.44, -0.15);
    anchor.add(panel, windowMesh, rim);
    muzzleZ = -0.2;
  } else {
    // Smoke canister and any future throwables.
    const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.15, 10), dark);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.035, 8), glow);
    cap.position.y = 0.09;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.03, 10), glow);
    band.position.y = -0.01;
    anchor.add(canister, cap, band);
    muzzleZ = -0.1;
  }

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, muzzleZ);
  anchor.add(muzzle);
  return { model: anchor, muzzle };
}

/**
 * Owns the first-person weapon: preloads every GLB, crossfades between them on
 * weapon switches, animates bob/recoil/reload, and fires muzzle flashes plus
 * tracers (unless the weapon definition says it is tracerless).
 */
export class WeaponViewmodels {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;
    this.holder = new THREE.Group();
    this.camera.add(this.holder);

    this.sources = new Map();
    this.loaded = false;
    this.currentWeaponId = null;
    this.currentRoot = null;
    this.currentMuzzle = null;
    this.switching = null;

    this.tracers = [];
    this.flashUntil = 0;
    this.kickZ = 0;
    this.kickPitch = 0;
    this.bobClock = 0;
    this.reloadUntil = 0;
    this.reloadDuration = 1;

    this.flashLight = new THREE.PointLight('#ffbd69', 0, 3.4, 2);
    this.flashLight.visible = false;
    this.camera.add(this.flashLight);
  }

  /** Load every GLB up front. Falls back to procedural models on any failure. */
  async load() {
    const loader = new GLTFLoader();
    const entries = await Promise.all(Object.entries(MODEL_FILES).map(async ([weaponId, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        return [weaponId, gltf.scene];
      } catch (error) {
        console.error(`[FPS GODS] Failed to load weapon model ${url}:`, error);
        return [weaponId, null];
      }
    }));
    for (const [weaponId, scene] of entries) {
      if (scene) this.sources.set(weaponId, scene);
    }
    this.loaded = true;
    return this;
  }

  buildRoot(weaponId, lengthOverride = null) {
    const definition = getWeapon(weaponId);
    const layout = VIEW_LAYOUT[weaponId] ?? VIEW_LAYOUT.pistol;
    const anchor = new THREE.Group();

    let model;
    let muzzle;
    const source = this.sources.get(weaponId);
    if (source) {
      const length = lengthOverride ?? layout.targetLength;
      model = normalizeModel(source, length).model;
      muzzle = new THREE.Object3D();
      // The normalized model is centered at the origin and runs down -Z.
      muzzle.position.set(0, 0.015, -length / 2 - 0.015);
    } else {
      const procedural = buildProcedural(weaponId);
      model = procedural.model;
      muzzle = procedural.muzzle;
    }

    anchor.add(model);
    attachHands(anchor, layout.hands, layout);
    anchor.add(muzzle);
    anchor.userData.definition = definition;
    return { anchor, muzzle, layout };
  }

  setWeapon(weaponId, { instant = false } = {}) {
    if (weaponId === this.currentWeaponId && !this.switching) return;
    const { anchor, muzzle, layout } = this.buildRoot(weaponId);
    anchor.position.set(layout.position[0], layout.position[1], layout.position[2]);
    anchor.rotation.set(layout.rotation[0], layout.rotation[1], layout.rotation[2]);

    const previous = this.currentRoot;
    if (previous && !instant) {
      this.switching = {
        outgoing: previous,
        outgoingStart: performance.now(),
        incoming: anchor,
        baseY: layout.position[1],
        startedAt: performance.now(),
      };
      this.holder.add(anchor);
      this.currentRoot = anchor;
      this.currentMuzzle = muzzle;
    } else {
      if (previous) this.holder.remove(previous);
      this.holder.add(anchor);
      this.currentRoot = anchor;
      this.currentMuzzle = muzzle;
      this.switching = null;
    }
    this.currentWeaponId = weaponId;
    this.setVisible(true);
  }

  setVisible(visible) {
    this.holder.visible = Boolean(visible);
    if (!visible) this.flashLight.visible = false;
  }

  /** Kick off the reload dip animation for the active weapon. */
  startReload(reloadMs) {
    this.reloadUntil = performance.now() + Math.max(300, reloadMs ?? 1_200);
    this.reloadDuration = Math.max(300, reloadMs ?? 1_200);
  }

  fire(now = performance.now(), hitPoint = null) {
    const definition = this.currentWeaponId ? getWeapon(this.currentWeaponId) : null;
    this.kickZ = 0.045;
    this.kickPitch = definition?.type === 'melee' ? 0.02 : 0.075;

    if (definition?.type === 'melee' || definition?.type === 'shield') return;

    this.flashUntil = now + 46;
    this.flashLight.visible = true;
    this.flashLight.intensity = 2.4;

    if (definition && !definition.tracer) return; // pistol and silent tools

    this.camera.updateMatrixWorld(true);
    const start = this.currentMuzzle
      ? this.currentMuzzle.getWorldPosition(new THREE.Vector3())
      : this.camera.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    const end = hitPoint
      ? new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z)
      : start.clone().addScaledVector(direction, 80);

    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const material = new THREE.LineBasicMaterial({
      color: definition?.id === 'railgun' ? '#9df3ff' : '#ffd67a',
      transparent: true,
      opacity: definition?.id === 'railgun' ? 1 : 0.85,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, expiresAt: now + (definition?.id === 'railgun' ? 160 : 100) });
  }

  update(now = performance.now(), deltaSeconds = 0.016, { movingSpeed = 0 } = {}) {
    for (let index = this.tracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.tracers[index];
      const remaining = tracer.expiresAt - now;
      if (remaining <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        tracer.line.material.dispose();
        this.tracers.splice(index, 1);
      } else {
        tracer.line.material.opacity = Math.min(1, remaining / 100);
      }
    }

    const flashVisible = now < this.flashUntil;
    this.flashLight.visible = flashVisible;
    if (!flashVisible) this.flashLight.intensity = 0;

    if (!this.currentRoot) return;

    // Smooth switch transition: old gun drops out, new gun rises into place.
    if (this.switching) {
      const { outgoing, incoming, outgoingStart, startedAt, baseY } = this.switching;
      if (outgoing) {
        const outProgress = Math.min(1, (now - outgoingStart) / 140);
        outgoing.position.y -= 0.035;
        outgoing.rotation.x += 0.11;
        outgoing.visible = outProgress < 1;
        if (outProgress >= 1) {
          this.holder.remove(outgoing);
          this.switching = { outgoing: null, incoming, startedAt, baseY };
        }
      }

      const inProgress = Math.min(1, (now - startedAt - 120) / 200);
      if (inProgress >= 0) {
        const eased = 1 - Math.pow(1 - Math.max(0, inProgress), 3);
        incoming.position.y = baseY - (1 - eased) * 0.34;
        incoming.rotation.x = (1 - eased) * 0.85;
      }
      if (inProgress >= 1) this.switching = null;
      return;
    }

    const layout = VIEW_LAYOUT[this.currentWeaponId] ?? VIEW_LAYOUT.pistol;

    // Weapon bob grows with movement speed.
    const speedFactor = Math.min(1, movingSpeed / 7.2);
    this.bobClock += deltaSeconds * (4 + speedFactor * 7.5);
    const bobX = Math.cos(this.bobClock) * 0.012 * speedFactor;
    const bobY = Math.abs(Math.sin(this.bobClock)) * -0.013 * speedFactor;

    // Recoil kick eases back to rest.
    this.kickZ *= Math.pow(0.0015, deltaSeconds);
    this.kickPitch *= Math.pow(0.0015, deltaSeconds);

    // Reload: dip and roll the weapon down, then raise it again.
    let reloadTilt = 0;
    let reloadDrop = 0;
    if (now < this.reloadUntil) {
      const progress = 1 - (this.reloadUntil - now) / this.reloadDuration;
      const curve = Math.sin(progress * Math.PI);
      reloadTilt = curve * 1.05;
      reloadDrop = curve * 0.16;
    }

    this.currentRoot.position.set(
      layout.position[0] + bobX,
      layout.position[1] + bobY - reloadDrop,
      layout.position[2] + this.kickZ,
    );
    this.currentRoot.rotation.set(
      layout.rotation[0] + this.kickPitch + reloadTilt,
      layout.rotation[1],
      layout.rotation[2] + reloadTilt * 0.35,
    );
  }

  dispose() {
    for (const tracer of this.tracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
    }
    this.tracers = [];
  }
}

/**
 * Compact world-space weapon carried by remote players so everyone can see
 * which gun each operator has equipped. Reuses the same normalized models.
 */
export class RemoteWeaponModels {
  constructor() {
    this.loader = new GLTFLoader();
    this.sources = new Map();
    this.loadPromise = null;
  }

  load() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = Promise.all(Object.entries(MODEL_FILES).map(async ([weaponId, url]) => {
      try {
        const gltf = await this.loader.loadAsync(url);
        this.sources.set(weaponId, gltf.scene);
      } catch (error) {
        console.error(`[FPS GODS] Failed to load remote weapon model ${url}:`, error);
      }
    }));
    return this.loadPromise;
  }

  build(weaponId) {
    const definition = WEAPONS[weaponId];
    if (!definition) return null;
    const source = this.sources.get(weaponId);
    const group = new THREE.Group();
    if (source) {
      const normalized = normalizeModel(source, 0.85);
      group.add(normalized.model);
    } else if (weaponId === 'shield') {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.8, 0.05),
        new THREE.MeshStandardMaterial({ color: '#243248', roughness: 0.4, metalness: 0.7, transparent: true, opacity: 0.92 }),
      );
      panel.position.set(0.28, 0.15, -0.45);
      group.add(panel);
      return group;
    } else if (weaponId === 'fist' || weaponId === 'smoke') {
      return null; // fists and canisters read fine without a world prop
    } else {
      // Procedural stand-ins for the GODS TIER guns.
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.12, weaponId === 'railgun' ? 0.85 : 0.6),
        new THREE.MeshStandardMaterial({ color: '#26334a', roughness: 0.4, metalness: 0.75 }),
      );
      body.position.z = -0.35;
      group.add(body);
      return group;
    }

    // The normalized model already points down -Z, which is the direction a
    // player with yaw = 0 faces — just dock it at the hands.
    return group;
  }
}
