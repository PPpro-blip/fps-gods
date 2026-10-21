import * as THREE from 'three';
import smgUrl from './assets/weapons/smg.glb?url';
import shotgunUrl from './assets/weapons/shotgun.glb?url';
import sniperUrl from './assets/weapons/sniper.glb?url';
import pistolUrl from './assets/weapons/pistol.glb?url';
import lmgUrl from './assets/weapons/lmg.glb?url';
import rocketUrl from './assets/weapons/rocket.glb?url';
import knifeUrl from './assets/weapons/knife.glb?url';

const MODEL_URLS = Object.freeze({
  'smg.glb': smgUrl,
  'shotgun.glb': shotgunUrl,
  'sniper.glb': sniperUrl,
  'pistol.glb': pistolUrl,
  'lmg.glb': lmgUrl,
  'rocket.glb': rocketUrl,
  'knife.glb': knifeUrl,
});

const WEAPON_MODEL = Object.freeze({
  SMG: 'smg.glb',
  SHOTGUN: 'shotgun.glb',
  KNIFE: 'knife.glb',
  PISTOL: 'pistol.glb',
  SNIPER: 'sniper.glb',
  SMOKE_GRENADE: 'pistol.glb',
  LMG: 'lmg.glb',
  ROCKET: 'rocket.glb',
  COMBAT_SHIELD: 'shotgun.glb',
  RAILGUN: 'lmg.glb',
  MINIGUN: 'lmg.glb',
  GOD_FIST: 'knife.glb',
});

const MODEL_LENGTH = Object.freeze({
  'smg.glb': 0.73,
  'shotgun.glb': 0.84,
  'sniper.glb': 1.0,
  'pistol.glb': 0.58,
  'lmg.glb': 0.86,
  'rocket.glb': 0.66,
  'knife.glb': 0.52,
});

const BUNDLE_TRACER_COLOR = Object.freeze({
  RUSHER: '#59d8ff',
  GHOST: '#c18aff',
  HEAVY: '#ff8b3d',
  GODS_TIER: '#ffd45e',
});

const NO_TRACER = new Set(['PISTOL', 'KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD']);
const NO_FLASH = new Set(['KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD']);
const SWITCH_DURATION_MS = 230;

function orientModel(scene, file) {
  const model = scene.clone(true);
  const oriented = new THREE.Group();
  const rotation = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
  );
  oriented.quaternion.setFromRotationMatrix(rotation);
  oriented.add(model);
  oriented.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(oriented);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  // Center the oriented geometry around (0, 0, 0) inside a pivot group
  const centered = new THREE.Group();
  oriented.position.copy(center).negate();
  centered.add(oriented);

  const fitted = new THREE.Group();
  const modelScale = MODEL_LENGTH[file] / Math.max(size.z, 0.001);
  fitted.scale.setScalar(modelScale);
  fitted.add(centered);
  fitted.userData.normalizedLength = 1;
  fitted.userData.baseScale = fitted.scale.clone();
  fitted.traverse((part) => {
    if (part.isMesh) {
      part.castShadow = false;
      part.receiveShadow = false;
    }
  });
  return fitted;
}

// Loads and normalizes each supplied GLB once. Local and remote weapon rigs use
// clones of the same real assets, so switches never trigger duplicate requests.
export class WeaponModelLibrary {
  constructor() {
    this.models = new Map();
    this.errors = new Map();
    this.listeners = new Set();
    this.settled = false;
    this.ready = import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
      const loader = new GLTFLoader();
      return Promise.all(Object.entries(MODEL_URLS).map(async ([file, url]) => {
        try {
          const gltf = await loader.loadAsync(url);
          this.models.set(file, orientModel(gltf.scene, file));
        } catch (error) {
          this.errors.set(file, error);
          console.error(`[FPS GODS] Could not load ${file}:`, error);
        }
      }));
    }).catch((error) => {
      this.errors.set('GLTFLoader', error);
      console.error('[FPS GODS] Could not initialize the weapon model loader:', error);
    }).then(() => {
      this.settled = true;
      for (const listener of this.listeners) listener();
      this.listeners.clear();
      return this.errors.size === 0;
    });
  }

  onReady(listener) {
    if (this.settled) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createModel(weaponId) {
    const file = WEAPON_MODEL[weaponId];
    const source = file ? this.models.get(file) : null;
    if (!source) return null;
    const model = source.clone(true);
    model.userData.weaponId = weaponId;
    model.userData.modelFile = file;
    return model;
  }

  getLength(weaponId) {
    return MODEL_LENGTH[WEAPON_MODEL[weaponId]] ?? MODEL_LENGTH['smg.glb'];
  }
}

function createHand(geometry, material, parent, position, scale, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

// First-person rendering is strictly a pair of hands and a GLB weapon attached
// to the camera. The server independently resolves every shot and applies damage.
export class WeaponEffects {
  constructor(scene, camera, modelLibrary) {
    this.scene = scene;
    this.camera = camera;
    this.modelLibrary = modelLibrary;
    this.tracers = [];
    this.smokeMeshes = new Map();
    this.smokeGeometry = new THREE.SphereGeometry(1, 20, 14);
    this.weaponId = null;
    this.bundleId = 'RUSHER';
    this.movementAmount = 0;
    this.reloadStartedAt = null;
    this.reloadDuration = 900;
    this.flashUntil = 0;
    this.switchTransition = null;
    this.hands = [];
    this.viewModel = new THREE.Group();
    this.viewModel.position.set(0.29, -0.275, -0.62);
    this.viewModel.rotation.set(-0.02, -0.05, 0);
    camera.add(this.viewModel);
    this.gun = this.viewModel;
    this.buildHands();
    this.buildFlash();
    this.setWeapon('SMG', 'RUSHER', false);
    this.modelLibrary.onReady(() => this.installActiveModel(performance.now()));
  }

  buildHands() {
    const sleeve = new THREE.MeshStandardMaterial({ color: '#243142', roughness: 0.82, metalness: 0.16 });
    const glove = new THREE.MeshStandardMaterial({ color: '#111821', roughness: 0.75, metalness: 0.2 });
    const seam = new THREE.MeshStandardMaterial({ color: '#3a5367', roughness: 0.55, metalness: 0.45 });
    const handMaterials = [sleeve, glove, seam];
    const armGeometry = new THREE.CapsuleGeometry(0.052, 0.25, 3, 8);
    const palmGeometry = new THREE.SphereGeometry(0.072, 10, 8);
    const fingerGeometry = new THREE.CapsuleGeometry(0.018, 0.085, 2, 6);
    const thumbGeometry = new THREE.CapsuleGeometry(0.019, 0.065, 2, 6);
    const cuffGeometry = new THREE.CylinderGeometry(0.061, 0.056, 0.07, 8);

    const leftArm = createHand(armGeometry, sleeve, this.viewModel, [-0.23, -0.43, -0.48], [1, 1, 1], [0.2, 0, -0.54]);
    const rightArm = createHand(armGeometry, sleeve, this.viewModel, [0.34, -0.44, -0.46], [1, 1, 1], [0.2, 0, 0.43]);
    const leftCuff = createHand(cuffGeometry, seam, this.viewModel, [-0.15, -0.35, -0.56], [1, 1, 1], [0.2, 0, -0.54]);
    const rightCuff = createHand(cuffGeometry, seam, this.viewModel, [0.27, -0.36, -0.55], [1, 1, 1], [0.2, 0, 0.43]);
    const leftPalm = createHand(palmGeometry, glove, this.viewModel, [-0.04, -0.285, -0.65], [1.15, 0.82, 0.8]);
    const rightPalm = createHand(palmGeometry, glove, this.viewModel, [0.17, -0.29, -0.57], [1.05, 0.8, 0.8]);

    for (let finger = 0; finger < 4; finger += 1) {
      const offset = (finger - 1.5) * 0.034;
      this.hands.push(createHand(fingerGeometry, glove, this.viewModel, [-0.04 + offset, -0.31, -0.69], [1, 1, 1], [0.28, 0, 0.12]));
      this.hands.push(createHand(fingerGeometry, glove, this.viewModel, [0.17 + offset, -0.315, -0.59], [1, 1, 1], [0.16, 0, -0.08]));
    }
    this.hands.push(leftArm, rightArm, leftCuff, rightCuff, leftPalm, rightPalm);
    this.handMaterials = handMaterials;
    this.handGeometries = [armGeometry, palmGeometry, fingerGeometry, thumbGeometry, cuffGeometry];
    const leftThumb = createHand(thumbGeometry, glove, this.viewModel, [-0.11, -0.29, -0.66], [1, 1, 1], [0.3, 0, -0.82]);
    const rightThumb = createHand(thumbGeometry, glove, this.viewModel, [0.1, -0.27, -0.55], [1, 1, 1], [0.2, 0, 0.8]);
    this.hands.push(leftThumb, rightThumb);
  }

  buildFlash() {
    this.muzzle = new THREE.Object3D();
    this.viewModel.add(this.muzzle);
    this.flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffe6a3', transparent: true, opacity: 0.95 });
    this.flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), this.flashMaterial);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);
    this.flashLight = new THREE.PointLight('#ffe0a0', 2.6, 2.8, 2);
    this.flashLight.visible = false;
    this.muzzle.add(this.flashLight);
  }

  setWeapon(weaponId, bundleId = this.bundleId, animate = true) {
    if (!weaponId) return;
    const changed = weaponId !== this.weaponId;
    const bundleChanged = bundleId && bundleId !== this.bundleId;
    if (!changed && !bundleChanged) return;
    this.weaponId = weaponId;
    if (bundleId) this.bundleId = bundleId;
    this.updateMuzzlePosition();
    if (changed && animate) this.installActiveModel(performance.now());
    else if (changed) this.installActiveModel(performance.now(), false);
  }

  updateMuzzlePosition() {
    this.muzzle.position.set(0, 0.015, -this.modelLibrary.getLength(this.weaponId) / 2);
  }

  installActiveModel(now, animate = true) {
    const next = this.modelLibrary.createModel(this.weaponId);
    if (!next) return;
    if (this.currentModel?.userData.weaponId === this.weaponId) return;

    if (this.switchTransition) {
      const { from, to } = this.switchTransition;
      if (from && from !== this.currentModel) this.viewModel.remove(from);
      if (to && to !== this.currentModel) this.viewModel.remove(to);
      this.switchTransition = null;
    }

    const from = this.currentModel;
    if (from) {
      from.scale.copy(from.userData.baseScale ?? from.scale);
      from.position.set(0, 0, 0);
      from.rotation.set(0, 0, 0);
    }
    next.userData.baseScale = next.scale.clone();
    this.viewModel.add(next);
    this.currentModel = next;

    if (animate && from) {
      this.switchTransition = { from, to: next, startedAt: now, duration: SWITCH_DURATION_MS };
    } else if (animate) {
      this.switchTransition = { from: null, to: next, startedAt: now, duration: SWITCH_DURATION_MS };
    } else {
      if (from) this.viewModel.remove(from);
      next.scale.copy(next.userData.baseScale);
      next.position.set(0, 0, 0);
    }
  }

  setMovementSpeed(speed) {
    this.movementAmount = Math.max(0, Math.min(1, (Number(speed) || 0) / 7.2));
  }

  startReload(duration = 900) {
    this.reloadStartedAt = performance.now();
    this.reloadDuration = Math.max(350, Math.min(4_000, Number(duration) || 900));
  }

  fire(now = performance.now(), weaponId = this.weaponId, bundleId = this.bundleId, authoritativeShot = null) {
    this.setWeapon(weaponId, bundleId);
    const noTracer = NO_TRACER.has(weaponId);
    const noMuzzleFlash = NO_FLASH.has(weaponId);
    this.camera.updateMatrixWorld(true);
    this.viewModel.updateMatrixWorld(true);
    const start = authoritativeShot?.origin
      ? new THREE.Vector3(authoritativeShot.origin.x, authoritativeShot.origin.y, authoritativeShot.origin.z)
      : this.muzzle.getWorldPosition(new THREE.Vector3());
    const direction = authoritativeShot?.direction
      ? new THREE.Vector3(authoritativeShot.direction.x, authoritativeShot.direction.y, authoritativeShot.direction.z).normalize()
      : new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    if (!noTracer) {
      const end = start.clone().addScaledVector(direction, weaponId === 'ROCKET' ? 34 : 58);
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const material = new THREE.LineBasicMaterial({
        color: BUNDLE_TRACER_COLOR[this.bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.tracers.push({ line, expiresAt: now + 100 });
    }

    if (!noMuzzleFlash) {
      const flashColor = BUNDLE_TRACER_COLOR[this.bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER;
      this.flashMaterial.color.set(flashColor);
      this.flashLight.color.set(flashColor);
      this.flashUntil = now + 55;
      this.flashMesh.visible = true;
      this.flashLight.visible = true;
      this.viewModel.position.y = -0.3;
    }
  }

  showRemoteTracer({ origin, direction, weaponId, bundleId }, now = performance.now()) {
    if (NO_TRACER.has(weaponId) || !origin || !direction) return;
    const start = new THREE.Vector3(origin.x, origin.y, origin.z);
    const ray = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    if (ray.lengthSq() < 0.5) return;
    const end = start.clone().addScaledVector(ray, weaponId === 'ROCKET' ? 34 : 58);
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const material = new THREE.LineBasicMaterial({
      color: BUNDLE_TRACER_COLOR[bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, expiresAt: now + 100 });
  }

  updateSmokeClouds(clouds = []) {
    const visibleIds = new Set(clouds.map((cloud) => cloud.id));
    for (const [id, record] of this.smokeMeshes) {
      if (visibleIds.has(id)) continue;
      this.scene.remove(record.group);
      for (const material of record.materials) material.dispose();
      this.smokeMeshes.delete(id);
    }

    for (const cloud of clouds) {
      let record = this.smokeMeshes.get(cloud.id);
      if (!record) {
        const group = new THREE.Group();
        const radius = Math.max(1, Number(cloud.radius) || 4);
        const materials = [0.28, 0.22, 0.18].map((opacity) => new THREE.MeshBasicMaterial({
          color: '#8e9aa6',
          transparent: true,
          opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
        }));
        const lobes = [
          { x: 0, y: 0, z: 0, scale: [1, 0.78, 1] },
          { x: -0.36, y: 0.1, z: 0.22, scale: [0.74, 0.66, 0.72] },
          { x: 0.34, y: -0.05, z: -0.24, scale: [0.76, 0.69, 0.75] },
        ];
        lobes.forEach((lobe, index) => {
          const mesh = new THREE.Mesh(this.smokeGeometry, materials[index]);
          mesh.position.set(lobe.x * radius, lobe.y * radius, lobe.z * radius);
          mesh.scale.set(radius * lobe.scale[0], radius * lobe.scale[1], radius * lobe.scale[2]);
          group.add(mesh);
        });
        this.scene.add(group);
        record = { group, materials };
        this.smokeMeshes.set(cloud.id, record);
      }
      record.group.position.set(cloud.x, cloud.y, cloud.z);
    }
  }

  update(now = performance.now()) {
    for (let index = this.tracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.tracers[index];
      const remaining = tracer.expiresAt - now;
      if (remaining <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        tracer.line.material.dispose();
        this.tracers.splice(index, 1);
      } else {
        tracer.line.material.opacity = Math.min(0.92, remaining / 100);
      }
    }

    const flashVisible = now < this.flashUntil;
    this.flashMesh.visible = flashVisible;
    this.flashLight.visible = flashVisible;
    const moving = this.movementAmount;
    const bob = Math.sin(now * 0.012) * 0.014 * moving;
    const sway = Math.cos(now * 0.006) * 0.008 * moving;
    const reloadProgress = this.reloadStartedAt === null
      ? 0
      : Math.max(0, Math.min(1, (now - this.reloadStartedAt) / this.reloadDuration));
    if (reloadProgress >= 1) this.reloadStartedAt = null;
    const reloadDip = this.reloadStartedAt === null ? 0 : Math.sin(reloadProgress * Math.PI) * 0.14;

    this.viewModel.position.x = 0.29 + sway;
    this.viewModel.position.y = -0.275 + bob - reloadDip;
    this.viewModel.position.z = -0.62 + reloadDip * 0.6;
    this.viewModel.rotation.z = Math.sin(now * 0.006) * 0.018 * moving;
    this.viewModel.rotation.x = -0.02 + reloadDip * 0.6;

    if (this.switchTransition) {
      const { from, to, startedAt, duration } = this.switchTransition;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
      if (from) {
        from.position.y = -progress * 0.19;
        from.rotation.x = -progress * 0.16;
        from.scale.copy(from.userData.baseScale).multiplyScalar(1 - progress * 0.12);
      }
      to.position.y = (1 - progress) * 0.19;
      to.rotation.x = (1 - progress) * 0.16;
      to.scale.copy(to.userData.baseScale).multiplyScalar(0.88 + progress * 0.12);
      if (progress >= 1) {
        if (from) this.viewModel.remove(from);
        to.position.set(0, 0, 0);
        to.rotation.set(0, 0, 0);
        to.scale.copy(to.userData.baseScale);
        this.switchTransition = null;
      }
    }
  }

  dispose() {
    for (const tracer of this.tracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
    }
    for (const record of this.smokeMeshes.values()) {
      this.scene.remove(record.group);
      for (const material of record.materials) material.dispose();
    }
    this.smokeMeshes.clear();
    this.smokeGeometry.dispose();
    for (const geometry of this.handGeometries) geometry.dispose();
    for (const material of this.handMaterials) material.dispose();
    this.flashMesh.geometry.dispose();
    this.flashMaterial.dispose();
    this.camera.remove(this.viewModel);
  }
}
