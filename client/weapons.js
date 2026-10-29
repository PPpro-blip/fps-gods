import * as THREE from 'three';
import { WEAPON_MODEL_FILE, WEAPON_MODEL_FILES, WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';

const WEAPON_MODEL = WEAPON_MODEL_FILE;
const MODEL_LENGTH = WEAPON_MODEL_LENGTH;

const BUNDLE_TRACER_COLOR = Object.freeze({
  RUSHER: '#59d8ff',
  GHOST: '#c18aff',
  HEAVY: '#ff8b3d',
  GODS_TIER: '#ffd45e',
});

const NO_TRACER = new Set(['PISTOL', 'KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD', 'ROCKET']);
const NO_FLASH = new Set(['KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD']);
const SWITCH_DURATION_MS = 190;
const RECOIL_DECAY_PER_SECOND = 10;

// Base hip-fire framing per weapon class.
const WEAPON_PROFILES = Object.freeze({
  light: Object.freeze({ x: 0.2, y: -0.2, reach: 0.4, handScale: 1 }),
  heavy: Object.freeze({ x: 0.24, y: -0.26, reach: 0.4, handScale: 1.04 }),
  melee: Object.freeze({ x: 0.22, y: -0.25, reach: 0.38, handScale: 0.96 }),
  utility: Object.freeze({ x: 0.21, y: -0.23, reach: 0.34, handScale: 0.98 }),
  shield: Object.freeze({ x: 0.34, y: -0.32, reach: 0.4, handScale: 1.02 }),
});

const WEAPON_CLASS = Object.freeze({
  SMG: 'light',
  PISTOL: 'light',
  SHOTGUN: 'heavy',
  SNIPER: 'heavy',
  LMG: 'heavy',
  ROCKET: 'heavy',
  RAILGUN: 'heavy',
  MINIGUN: 'heavy',
  KNIFE: 'melee',
  GOD_FIST: 'melee',
  SMOKE_GRENADE: 'utility',
  COMBAT_SHIELD: 'shield',
});

/**
 * Weapon-specific grip & mount pose authored against the measured Z-slices of
 * every oriented GLB/GLTF (`-Z` forward, `+Z` toward camera):
 *  - Military knife.glb: blade [-0.23..0.00], guard [0.00..+0.058], handle [+0.058..+0.230]
 *  - rocket_launcher_low.gltf: front vertical grip z=-0.055 y=-0.115, rear trigger grip z=+0.115 y=-0.115
 *  - LowPolyShieldPack.glb (RectangularShield1): front boss z=-0.036, rear inner grip z=+0.032
 *  - Firearms: rear pistol grip z=+0.10..+0.15, forend z=-0.16..-0.24
 */
function computeWeaponPose(weaponId, length) {
  switch (weaponId) {
    case 'KNIFE':
      return {
        mountRotation: [0.36, 0.14, -0.22],
        rightPos: [0.004, -0.012, Math.min(0.14, length * 0.24)],
        rightRot: [-0.28, 0.04, 0.08],
        leftPos: [-0.115, -0.095, 0.015],
        leftRot: [0.22, -0.24, -0.18],
        leftVisible: true,
      };
    case 'GOD_FIST':
      return {
        mountRotation: [0.28, 0.12, -0.14],
        rightPos: [0.01, -0.015, Math.min(0.13, length * 0.22)],
        rightRot: [-0.2, 0.05, 0.06],
        leftPos: [-0.12, -0.06, -0.02],
        leftRot: [0.25, -0.18, -0.16],
        leftVisible: true,
      };
    case 'PISTOL':
    case 'SMOKE_GRENADE':
      return {
        mountRotation: [0, 0, 0],
        // Two-handed Weaver/isosceles grip directly on the rear pistol handle.
        rightPos: [0.006, -0.072, Math.min(0.105, length * 0.18)],
        rightRot: [0.1, 0, 0.04],
        leftPos: [-0.012, -0.082, Math.min(0.088, length * 0.15)],
        leftRot: [0.14, -0.08, -0.08],
        leftVisible: true,
      };
    case 'ROCKET':
      return {
        mountRotation: [0, 0, 0],
        // Matches both actual under-slung grips on rocket_launcher_low.gltf.
        rightPos: [0.006, -0.115, 0.115],
        rightRot: [0.12, 0, 0.05],
        leftPos: [-0.008, -0.115, -0.055],
        leftRot: [0.16, -0.06, -0.08],
        leftVisible: true,
      };
    case 'COMBAT_SHIELD':
      return {
        mountRotation: [0.04, 0.16, -0.04],
        // Both hands brace the rear inner handle/straps (+Z side > +0.036) so
        // zero glove geometry ever pokes through the -Z front face.
        rightPos: [0.024, -0.025, 0.072],
        rightRot: [0.08, 0, 0.06],
        leftPos: [-0.078, -0.045, 0.072],
        leftRot: [0.1, -0.06, -0.08],
        leftVisible: true,
      };
    default: {
      // Rifles / SMG / Shotgun / Sniper / LMG / Railgun / Minigun:
      // Right hand wraps around rear pistol grip; left hand cradles handguard.
      const forendZ = -Math.min(0.22, Math.max(0.13, length * 0.24));
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.006, -0.068, 0.105],
        rightRot: [0.1, 0, 0.04],
        leftPos: [-0.008, -0.058, forendZ],
        leftRot: [0.22, -0.08, -0.18],
        leftVisible: true,
      };
    }
  }
}

/**
 * Rotate a loaded GLB so its barrel points down -Z and normalise its length to
 * the measured real-world size. Clones share geometry, so every weapon rig in
 * the game is cheap after the first load.
 */
export function orientModel(scene, file) {
  const selected = file === 'LowPolyShieldPack.glb'
    ? scene.getObjectByName('RectangularShield1')
    : scene;
  if (!selected) throw new Error(`No usable mesh hierarchy in ${file}`);
  const model = selected.clone(true);
  if (file === 'LowPolyShieldPack.glb') model.position.set(0, 0, 0);
  const oriented = new THREE.Group();
  if (file === 'LowPolyShieldPack.glb') {
    oriented.rotation.y = Math.PI / 2;
  } else if (file === 'Military knife.glb') {
    oriented.rotation.x = -Math.PI / 2;
  } else if (file !== 'rocket_launcher_low.gltf') {
    const rotation = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
    );
    oriented.quaternion.setFromRotationMatrix(rotation);
  }
  oriented.add(model);
  oriented.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(oriented);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const dimension = file === 'LowPolyShieldPack.glb' ? size.y : size.z;
  if (bounds.isEmpty() || !Number.isFinite(dimension) || dimension < 0.00001) {
    throw new Error(`No usable mesh bounds in ${file}`);
  }
  const centered = new THREE.Group();
  oriented.position.copy(center).negate();
  centered.add(oriented);
  const fitted = new THREE.Group();
  fitted.scale.setScalar(MODEL_LENGTH[file] / dimension);
  fitted.add(centered);
  fitted.userData.baseScale = fitted.scale.clone();
  fitted.userData.normalizedLength = 1;
  fitted.traverse((meshPart) => {
    if (meshPart.isMesh) {
      meshPart.castShadow = false;
      meshPart.receiveShadow = false;
      meshPart.frustumCulled = false;
    }
  });
  return fitted;
}

// Preload every active arsenal model during boot so switching to Knife, RPG,
// or Combat Shield mid-fight never triggers a network fetch stall.
const CORE_FILES = WEAPON_MODEL_FILES;

export class WeaponModelLibrary {
  constructor() {
    this.models = new Map();
    this.errors = new Map();
    this.listeners = new Set();
    this.loading = new Map();
    this.settled = false;
    this.disposed = false;
    this.bootstrap = Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('./weaponAssets.js'),
    ]).then(([{ GLTFLoader }, { MODEL_URLS }]) => {
      this.loader = new GLTFLoader();
      this.urls = MODEL_URLS;
    }).catch((error) => {
      this.errors.set('GLTFLoader', error);
      console.error('[FPS GODS] Could not initialise the weapon model loader:', error);
    });
    this.ready = this.bootstrap.then(() => Promise.all(CORE_FILES.map((file) => this.ensureModel(file))))
      .then(() => {
        this.settled = true;
        this.notify();
        return this.errors.size === 0;
      });
  }

  ensureModel(file) {
    if (this.models.has(file) || this.disposed) return Promise.resolve(this.models.get(file) ?? null);
    if (this.loading.has(file)) return this.loading.get(file);
    const promise = this.bootstrap.then(async () => {
      const url = this.urls?.[file];
      if (!this.loader || !url || this.disposed) return null;
      try {
        const gltf = await this.loader.loadAsync(url);
        const model = orientModel(gltf.scene, file);
        if (this.disposed) {
          disposeModels([model]);
          return null;
        }
        this.models.set(file, model);
        this.notify();
        return model;
      } catch (error) {
        this.errors.set(file, error);
        console.error(`[FPS GODS] Could not load ${file}:`, error);
        this.notify();
        return null;
      }
    });
    this.loading.set(file, promise);
    return promise;
  }

  notify() {
    for (const listener of this.listeners) listener();
  }

  onReady(listener) {
    this.listeners.add(listener);
    if (this.settled) listener();
    return () => this.listeners.delete(listener);
  }

  createModel(weaponId) {
    const file = WEAPON_MODEL[weaponId];
    const source = file ? this.models.get(file) : null;
    if (!source) {
      if (file) void this.ensureModel(file);
      return null;
    }
    const model = source.clone(true);
    model.userData.weaponId = weaponId;
    model.userData.modelFile = file;
    model.userData.length = MODEL_LENGTH[file] ?? 0.7;
    return model;
  }

  getLength(weaponId) {
    return MODEL_LENGTH[WEAPON_MODEL[weaponId]] ?? MODEL_LENGTH['smg.glb'];
  }

  get weaponClass() { return WEAPON_CLASS; }

  dispose() {
    this.disposed = true;
    disposeModels(this.models.values());
    this.models.clear();
    this.listeners.clear();
    this.settled = true;
  }
}

function disposeModels(models) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  for (const model of models) {
    model.traverse((node) => {
      if (!node.isMesh) return;
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    model.removeFromParent();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function part(geometry, material, parent, position, rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.scale.set(...scale);
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

export class WeaponEffects {
  constructor(scene, camera, modelLibrary) {
    this.scene = scene;
    this.camera = camera;
    this.modelLibrary = modelLibrary;
    this.tracers = [];
    this.smokeMeshes = new Map();
    this.projectileMeshes = new Map();
    this.impacts = [];
    this.projectileGeometry = new THREE.SphereGeometry(0.10, 8, 6);
    this.projectileMaterial = new THREE.MeshBasicMaterial({ color: '#ffb14a' });
    this.impactGeometry = new THREE.SphereGeometry(1, 10, 8);
    this.aimAmount = 0;
    this.aimProfile = null;
    this.opticalScopeHidden = false;
    this.blockingTarget = false;
    this.blockingAmount = 0;
    this.meleeStartedAt = null;
    this.smokeGeometry = new THREE.SphereGeometry(1, 20, 14);
    this.weaponId = null;
    this.bundleId = 'RUSHER';
    this.movementAmount = 0;
    this.reloadStartedAt = null;
    this.reloadDuration = 900;
    this.flashUntil = 0;
    this.recoil = 0;
    this.switchTransition = null;
    this.currentModel = null;
    this.currentPose = computeWeaponPose('SMG', 0.73);
    this.geometries = [];
    this.materials = [];
    this.viewMaterialCache = new Map();

    this.viewModel = new THREE.Group();
    this.viewModel.position.set(0.26, -0.24, -0.62);
    this.viewModel.rotation.set(-0.015, -0.035, 0);
    camera.add(this.viewModel);
    this.gun = this.viewModel;

    // Both the weapon mesh and the articulated hand groups live inside
    // weaponMount so tilted melee stances, recoils, and slashes keep the hands
    // locked to the physical handle with zero detachment.
    this.weaponMount = new THREE.Group();
    this.viewModel.add(this.weaponMount);

    this.handRig = new THREE.Group();
    this.weaponMount.add(this.handRig);

    this.buildHands();
    this.buildFlash();

    for (const material of this.materials) material.transparent = true;
    this.viewModel.traverse((object) => { if (object.isMesh) object.renderOrder = 1000; });
    this.buildViewModelDepthReset();
    this.buildViewModelLight();
    this.setWeapon('SMG', 'RUSHER', false);
    this.modelLibrary.onReady(() => this.installActiveModel(performance.now(), false));
  }

  /**
   * Articulated, cohesive left and right hand sub-rigs.
   *
   * Each hand is an integrated anatomical group (`rightHandGroup` /
   * `leftHandGroup`) whose origin `(0, 0, 0)` is the grip contact center.
   * Moving or rotating a hand group moves its forearm, cuff, palm, 4 curled
   * fingers, thumb, and knuckle plate together as one solid glove — eliminating
   * detached fingers or floating palms across weapon classes while keeping
   * every mesh strictly forward of the camera near plane (`max.z < -0.30 m`).
   */
  buildHands() {
    const sleeve = new THREE.MeshStandardMaterial({
      color: '#344b63', roughness: 0.78, metalness: 0.14, emissive: '#0e1f2c', emissiveIntensity: 0.75,
    });
    const glove = new THREE.MeshStandardMaterial({
      color: '#212d3b', roughness: 0.58, metalness: 0.28, emissive: '#0a202c', emissiveIntensity: 0.8,
    });
    const seam = new THREE.MeshStandardMaterial({
      color: '#46748d', roughness: 0.38, metalness: 0.52, emissive: '#103443', emissiveIntensity: 0.9,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: '#2d728e', roughness: 0.32, metalness: 0.58, emissive: '#1f8fb0', emissiveIntensity: 1.15,
    });
    this.materials.push(sleeve, glove, seam, accent);

    const armGeometry = new THREE.CapsuleGeometry(0.038, 0.15, 4, 10);
    const cuffGeometry = new THREE.CylinderGeometry(0.044, 0.040, 0.052, 10);
    const palmGeometry = new THREE.BoxGeometry(0.036, 0.064, 0.068);
    const fingerGeometry = new THREE.CapsuleGeometry(0.010, 0.036, 3, 6);
    const thumbGeometry = new THREE.CapsuleGeometry(0.011, 0.034, 3, 6);
    const knuckleGeometry = new THREE.BoxGeometry(0.014, 0.052, 0.048);
    this.geometries.push(
      armGeometry,
      cuffGeometry,
      palmGeometry,
      fingerGeometry,
      thumbGeometry,
      knuckleGeometry,
    );

    this.rightHandGroup = new THREE.Group();
    this.leftHandGroup = new THREE.Group();
    this.handRig.add(this.rightHandGroup, this.leftHandGroup);

    // Dominant right hand: palm hugs +X of grip, fingers wrap across front/left,
    // cuff & forearm run seamlessly back-down-right with zero gaps.
    this.rightPalm = part(palmGeometry, glove, this.rightHandGroup, [0.022, -0.004, 0.004], [0.08, 0.04, 0.08]);
    this.rightCuff = part(cuffGeometry, seam, this.rightHandGroup, [0.036, -0.028, 0.038], [1.12, 0.0, -0.32]);
    this.rightArm = part(armGeometry, sleeve, this.rightHandGroup, [0.068, -0.070, 0.082], [1.14, 0.0, -0.34]);
    this.rightThumb = part(thumbGeometry, glove, this.rightHandGroup, [-0.004, 0.024, -0.012], [0.35, 0.35, 1.15]);

    // Support left hand: palm cradles -X / underside of forend or grip,
    // fingers curl around underside/right, cuff & forearm run back-down-left.
    this.leftPalm = part(palmGeometry, glove, this.leftHandGroup, [-0.022, -0.006, 0.004], [0.08, -0.04, -0.08]);
    this.leftCuff = part(cuffGeometry, seam, this.leftHandGroup, [-0.036, -0.030, 0.038], [1.12, 0.0, 0.32]);
    this.leftArm = part(armGeometry, sleeve, this.leftHandGroup, [-0.068, -0.074, 0.082], [1.14, 0.0, 0.34]);
    this.leftThumb = part(thumbGeometry, glove, this.leftHandGroup, [0.004, 0.022, -0.012], [0.35, -0.35, -1.15]);

    this.fingers = [];
    this.rightFingers = [];
    this.leftFingers = [];
    for (let i = 0; i < 4; i += 1) {
      const spread = (i - 1.5) * 0.015;
      const rf = part(
        fingerGeometry,
        glove,
        this.rightHandGroup,
        [-0.002, spread, -0.018],
        [0.08, 0.0, Math.PI / 2 - 0.12],
      );
      const lf = part(
        fingerGeometry,
        glove,
        this.leftHandGroup,
        [0.002, spread - 0.002, -0.018],
        [0.08, 0.0, -Math.PI / 2 + 0.12],
      );
      this.rightFingers.push(rf);
      this.leftFingers.push(lf);
      this.fingers.push(rf, lf);
    }

    this.knuckles = [
      part(knuckleGeometry, accent, this.rightHandGroup, [0.041, -0.002, 0.002], [0.08, 0.04, 0.08]),
      part(knuckleGeometry, accent, this.leftHandGroup, [-0.041, -0.004, 0.002], [0.08, -0.04, -0.08]),
    ];
  }

  buildFlash() {
    this.muzzle = new THREE.Object3D();
    this.weaponMount.add(this.muzzle);
    this.flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffe6a3', transparent: true, opacity: 0.95 });
    this.flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), this.flashMaterial);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);
    this.flashLight = new THREE.PointLight('#ffe0a0', 2.6, 2.6, 2);
    this.flashLight.visible = false;
    this.muzzle.add(this.flashLight);
  }

  buildViewModelDepthReset() {
    const geometry = new THREE.PlaneGeometry(0.001, 0.001);
    const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true });
    this.geometries.push(geometry);
    this.materials.push(material);
    this.depthReset = new THREE.Mesh(geometry, material);
    this.depthReset.frustumCulled = false;
    this.depthReset.renderOrder = 999;
    this.depthReset.onBeforeRender = (renderer) => renderer.clearDepth();
    this.viewModel.add(this.depthReset);
  }

  buildViewModelLight() {
    this.viewModelLight = new THREE.Group();
    this.viewModelLight.position.set(0.18, 0.24, -0.12);

    const key = new THREE.PointLight('#e4f5ff', 3.6, 2.8, 2);
    key.position.set(0.12, 0.2, 0.34);
    const rim = new THREE.PointLight('#56daff', 1.75, 2.4, 2);
    rim.position.set(-0.34, -0.08, -0.58);
    this.viewModelLight.add(key, rim);
    this.camera.add(this.viewModelLight);
    this.lights = [key, rim];
  }

  layoutForWeapon(weaponId) {
    const length = this.modelLibrary.getLength(weaponId);
    const weaponClass = WEAPON_CLASS[weaponId] ?? 'light';
    const profile = WEAPON_PROFILES[weaponClass] ?? WEAPON_PROFILES.light;
    this.basePosition = {
      x: profile.x,
      y: profile.y,
      z: -0.42 - length * profile.reach,
    };
    this.currentPose = computeWeaponPose(weaponId, length);
    this.handRig.position.set(0, 0, 0);
    this.handRig.scale.setScalar(profile.handScale);

    this.rightHandGroup.position.set(...this.currentPose.rightPos);
    this.rightHandGroup.rotation.set(...this.currentPose.rightRot);
    this.leftHandGroup.position.set(...this.currentPose.leftPos);
    this.leftHandGroup.rotation.set(...this.currentPose.leftRot);
    this.leftHandGroup.visible = this.currentPose.leftVisible !== false;

    const [mx, my, mz] = this.currentPose.mountRotation;
    this.weaponMount.rotation.set(mx, my, mz);

    this.updateMuzzlePosition();
  }

  resetPresentation() {
    this.reloadStartedAt = null;
    this.recoil = 0;
    this.meleeStartedAt = null;
    this.blockingTarget = false;
    this.blockingAmount = 0;
    this.opticalScopeHidden = false;
    this.weaponMount.visible = true;
    if (this.switchTransition) {
      const { from, to } = this.switchTransition;
      from?.removeFromParent();
      if (to) {
        to.position.set(0, 0, 0);
        to.rotation.set(0, 0, 0);
        to.scale.copy(to.userData.baseScale ?? to.scale);
      }
      this.switchTransition = null;
    }
    this.flashUntil = 0;
    this.flashMesh.visible = false;
    this.flashLight.visible = false;
    if (this.basePosition) {
      this.viewModel.position.set(this.basePosition.x, this.basePosition.y, this.basePosition.z);
    }
    if (this.currentPose) {
      this.rightHandGroup.position.set(...this.currentPose.rightPos);
      this.leftHandGroup.position.set(...this.currentPose.leftPos);
      const [mx, my, mz] = this.currentPose.mountRotation;
      this.weaponMount.rotation.set(mx, my, mz);
    }
  }

  setVisible(visible) {
    const on = Boolean(visible);
    this.viewModel.visible = on;
    if (this.viewModelLight) this.viewModelLight.visible = on;
    if (!on) {
      this.flashMesh.visible = false;
      this.flashLight.visible = false;
    }
  }

  setOpticalScopeHidden(hidden) {
    this.opticalScopeHidden = Boolean(hidden);
    this.weaponMount.visible = !this.opticalScopeHidden;
  }

  setWeapon(weaponId, bundleId = this.bundleId, animate = true) {
    if (!weaponId) return;
    const changed = weaponId !== this.weaponId;
    const bundleChanged = bundleId && bundleId !== this.bundleId;
    if (!changed && !bundleChanged) return;
    this.weaponId = weaponId;
    if (bundleId) this.bundleId = bundleId;
    if (changed) {
      this.reloadStartedAt = null;
      this.meleeStartedAt = null;
      this.opticalScopeHidden = false;
      this.weaponMount.visible = true;
    }
    this.layoutForWeapon(weaponId);
    if (changed) this.installActiveModel(performance.now(), animate);
  }

  updateMuzzlePosition() {
    if (!this.basePosition) return;
    this.muzzle.position.set(0, 0.015, -this.modelLibrary.getLength(this.weaponId) / 2);
  }

  installActiveModel(now, animate = true) {
    if (this.currentModel?.userData.weaponId === this.weaponId) return;
    const next = this.modelLibrary.createModel(this.weaponId);
    if (!next) {
      this.switchTransition?.from?.removeFromParent();
      this.switchTransition?.to?.removeFromParent();
      this.switchTransition = null;
      this.currentModel?.removeFromParent();
      this.currentModel = null;
      return;
    }

    if (this.switchTransition) {
      const { from, to } = this.switchTransition;
      if (from && from !== this.currentModel) from.removeFromParent();
      if (to && to !== this.currentModel) to.removeFromParent();
      this.switchTransition = null;
    }

    const from = this.currentModel;
    if (from) {
      from.position.set(0, 0, 0);
      from.rotation.set(0, 0, 0);
    }
    next.userData.baseScale = next.scale.clone();
    next.traverse((object) => {
      if (!object.isMesh) return;
      object.renderOrder = 1000;
      const overlayMaterial = (source) => {
        if (!source) return source;
        if (!this.viewMaterialCache.has(source)) {
          const copy = source.clone();
          copy.transparent = true;
          // Without an HDRI environment map, pure metalness=1.0 glTF materials
          // crush diffuse albedo; moderating the viewmodel clone preserves PBR
          // baseColor detail while leaving shared world materials untouched.
          if (typeof copy.metalness === 'number' && copy.metalness > 0.72) {
            copy.metalness = 0.72;
          }
          this.viewMaterialCache.set(source, copy);
        }
        return this.viewMaterialCache.get(source);
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(overlayMaterial)
        : overlayMaterial(object.material);
    });
    this.weaponMount.add(next);
    this.currentModel = next;
    this.updateMuzzlePosition();

    if (animate) {
      this.switchTransition = { from: from ?? null, to: next, startedAt: now };
    } else {
      if (from) from.removeFromParent();
      next.position.set(0, 0, 0);
    }
  }

  setAim(amount, profile) {
    this.aimAmount = Math.max(0, Math.min(1, Number(amount) || 0));
    this.aimProfile = profile;
  }

  setBlocking(blocking) {
    this.blockingTarget = Boolean(blocking && this.weaponId === 'COMBAT_SHIELD');
  }

  setMovementSpeed(speed) {
    this.movementAmount = Math.max(0, Math.min(1, (Number(speed) || 0) / 7.2));
  }

  startReload(duration = 900) {
    this.reloadStartedAt = performance.now();
    this.reloadDuration = Math.max(300, Math.min(4_000, Number(duration) || 900));
  }

  get weaponClass() {
    return WEAPON_CLASS[this.weaponId] ?? 'light';
  }

  fire(now = performance.now(), weaponId = this.weaponId, bundleId = this.bundleId, authoritativeShot = null, present = true) {
    this.setWeapon(weaponId, bundleId);
    const tracerColor = BUNDLE_TRACER_COLOR[this.bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER;
    this.camera.updateMatrixWorld(true);
    this.viewModel.updateMatrixWorld(true);

    if (!NO_TRACER.has(weaponId)) {
      const start = authoritativeShot?.origin
        ? new THREE.Vector3(authoritativeShot.origin.x, authoritativeShot.origin.y, authoritativeShot.origin.z)
        : this.muzzle.getWorldPosition(new THREE.Vector3());
      const direction = authoritativeShot?.direction
        ? new THREE.Vector3(authoritativeShot.direction.x, authoritativeShot.direction.y, authoritativeShot.direction.z).normalize()
        : new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      const distance = weaponId === 'ROCKET' ? 34 : 58;
      const end = start.clone().addScaledVector(direction, distance);
      this.addTracer(start, end, tracerColor, 100, 0.92, now);
    }

    if (present) this.presentFire(now, weaponId, bundleId);
  }

  presentFire(now = performance.now(), weaponId = this.weaponId, bundleId = this.bundleId) {
    if (weaponId === 'KNIFE' || weaponId === 'GOD_FIST') {
      this.meleeStartedAt = now;
      return;
    }
    if (!NO_FLASH.has(weaponId)) {
      const tracerColor = BUNDLE_TRACER_COLOR[bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER;
      this.flashMaterial.color.set(tracerColor);
      this.flashLight.color.set(tracerColor);
      this.flashUntil = now + 55;
      this.flashMesh.visible = true;
      this.flashLight.visible = true;
      const kick = weaponId === 'ROCKET'
        ? 1.05
        : (weaponId === 'SHOTGUN' || weaponId === 'SNIPER' || weaponId === 'RAILGUN' ? 0.88 : 0.44);
      this.recoil = Math.min(1.4, this.recoil + kick);
    }
  }

  addTracer(start, end, color, lifeMs, opacity, now) {
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const material = new THREE.LineBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, expiresAt: now + lifeMs });
  }

  showRemoteTracer({ origin, direction, weaponId, bundleId }, now = performance.now()) {
    if (NO_TRACER.has(weaponId) || !origin || !direction) return;
    const ray = new THREE.Vector3(direction.x, direction.y, direction.z);
    if (ray.lengthSq() < 0.5) return;
    ray.normalize();
    const start = new THREE.Vector3(origin.x, origin.y, origin.z);
    const end = start.clone().addScaledVector(ray, weaponId === 'ROCKET' ? 34 : 58);
    this.addTracer(start, end, BUNDLE_TRACER_COLOR[bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER, 100, 0.8, now);
  }

  updateProjectiles(projectiles = [], now = performance.now()) {
    const ids = new Set(projectiles.map((projectile) => projectile.id));
    for (const [id, record] of this.projectileMeshes) {
      if (ids.has(id)) continue;
      this.scene.remove(record.mesh);
      this.projectileMeshes.delete(id);
    }
    for (const projectile of projectiles) {
      if (!projectile?.id || !projectile.direction) continue;
      let record = this.projectileMeshes.get(projectile.id);
      if (!record) {
        const mesh = new THREE.Mesh(this.projectileGeometry, this.projectileMaterial);
        this.scene.add(mesh);
        record = { mesh };
        this.projectileMeshes.set(projectile.id, record);
      }
      record.position = { x: projectile.x, y: projectile.y, z: projectile.z };
      record.direction = projectile.direction;
      record.speed = Math.max(0, Number(projectile.speed) || 0);
      record.receivedAt = now;
      record.mesh.position.set(projectile.x, projectile.y, projectile.z);
    }
  }

  showImpact({ id, point, radius }, now = performance.now()) {
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) return;
    const projectile = this.projectileMeshes.get(id);
    if (projectile) {
      this.scene.remove(projectile.mesh);
      this.projectileMeshes.delete(id);
    }
    if (this.impacts.length >= 16) {
      const oldest = this.impacts.shift();
      this.scene.remove(oldest.mesh);
      oldest.mesh.material.dispose();
    }
    const material = new THREE.MeshBasicMaterial({ color: '#ffb461', transparent: true, opacity: 0.55, depthWrite: false });
    const mesh = new THREE.Mesh(this.impactGeometry, material);
    mesh.position.set(point.x, point.y, point.z);
    this.scene.add(mesh);
    this.impacts.push({ mesh, start: now, radius: Math.min(1.8, Math.max(0.4, (Number(radius) || 4) * 0.3)) });
  }

  clearProjectiles() {
    this.updateProjectiles([]);
    for (const impact of this.impacts) {
      this.scene.remove(impact.mesh);
      impact.mesh.material.dispose();
    }
    this.impacts.length = 0;
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
          color: '#8e9aa6', transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
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

  update(now = performance.now(), delta = 0.016) {
    for (const record of this.projectileMeshes.values()) {
      const travel = Math.min(0.1, Math.max(0, (now - record.receivedAt) / 1000)) * record.speed;
      record.mesh.position.set(
        record.position.x + record.direction.x * travel,
        record.position.y + record.direction.y * travel,
        record.position.z + record.direction.z * travel,
      );
    }
    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      const impact = this.impacts[index];
      const progress = Math.max(0, (now - impact.start) / 280);
      if (progress >= 1) {
        this.scene.remove(impact.mesh);
        impact.mesh.material.dispose();
        this.impacts.splice(index, 1);
      } else {
        impact.mesh.scale.setScalar(impact.radius * (0.2 + progress * 0.8));
        impact.mesh.material.opacity = (1 - progress) * 0.55;
      }
    }
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
    const bob = Math.sin(now * 0.011) * 0.011 * moving;
    const sway = Math.cos(now * 0.0055) * 0.006 * moving;
    const reloadProgress = this.reloadStartedAt === null
      ? 0
      : Math.max(0, Math.min(1, (now - this.reloadStartedAt) / this.reloadDuration));
    if (reloadProgress >= 1) this.reloadStartedAt = null;
    const reloadWave = this.reloadStartedAt === null ? 0 : Math.sin(reloadProgress * Math.PI);
    const reloadDip = reloadWave * 0.12;

    this.recoil = Math.max(0, this.recoil - RECOIL_DECAY_PER_SECOND * delta);

    const base = this.basePosition ?? { x: 0.26, y: -0.22, z: -0.62 };
    const aim = this.aimProfile?.offset ?? [base.x, base.y, base.z];
    const amount = this.aimAmount;
    this.blockingAmount += ((this.blockingTarget ? 1 : 0) - this.blockingAmount) * (1 - Math.exp(-14 * delta));
    const meleeProgress = this.meleeStartedAt === null ? 1 : (now - this.meleeStartedAt) / 240;
    const swing = meleeProgress >= 0 && meleeProgress < 1 ? Math.sin(meleeProgress * Math.PI) : 0;
    const slashArc = meleeProgress >= 0 && meleeProgress < 1 ? Math.sin(meleeProgress * Math.PI * 2) : 0;
    if (meleeProgress >= 1) this.meleeStartedAt = null;

    this.viewModel.position.x = base.x + (aim[0] - base.x) * amount + sway * (1 - amount * 0.88)
      - this.recoil * 0.003 - this.blockingAmount * 0.13 - swing * 0.07;
    this.viewModel.position.y = base.y + (aim[1] - base.y) * amount + bob * (1 - amount * 0.88)
      - reloadDip + this.recoil * 0.011 + this.blockingAmount * 0.095 + swing * 0.025;
    this.viewModel.position.z = base.z + (aim[2] - base.z) * amount + reloadDip * 0.42
      + this.recoil * 0.052 + this.blockingAmount * 0.035 - swing * 0.145;

    this.viewModel.rotation.z = Math.sin(now * 0.0055) * 0.013 * moving * (1 - amount) - swing * 0.42;
    this.viewModel.rotation.x = -0.015 * (1 - amount) + reloadDip * 0.5 - this.recoil * 0.055 + swing * 0.44;
    this.viewModel.rotation.y = -0.035 * (1 - amount) + slashArc * 0.18;

    // Blend weaponMount rest orientation cleanly to zero as ADS approaches 1,
    // and animate the cohesive support hand toward the magwell during reloads.
    if (this.currentPose) {
      const [mx, my, mz] = this.currentPose.mountRotation;
      const hipFactor = 1 - amount;
      const guardPitch = -this.blockingAmount * 0.04;
      const guardYaw = -this.blockingAmount * 0.14;
      this.weaponMount.rotation.set(
        mx * hipFactor + guardPitch,
        my * hipFactor + guardYaw,
        mz * hipFactor,
      );
      const [lx, ly, lz] = this.currentPose.leftPos;
      this.leftHandGroup.position.set(
        lx + reloadWave * 0.018,
        ly - reloadWave * 0.075,
        lz + reloadWave * 0.095,
      );
    }

    if (this.switchTransition) {
      const { from, to, startedAt } = this.switchTransition;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / SWITCH_DURATION_MS));
      const eased = 1 - (1 - progress) * (1 - progress);
      if (from) {
        from.position.y = -eased * 0.18;
        from.rotation.x = -eased * 0.16;
        from.scale.copy(from.userData.baseScale ?? from.scale).multiplyScalar(1 - eased * 0.1);
      }
      to.position.y = (1 - eased) * -0.15;
      to.rotation.x = (1 - eased) * -0.18;
      to.scale.copy(to.userData.baseScale ?? to.scale).multiplyScalar(0.92 + eased * 0.08);
      if (progress >= 1) {
        if (from) from.removeFromParent();
        to.position.set(0, 0, 0);
        to.rotation.set(0, 0, 0);
        to.scale.copy(to.userData.baseScale ?? to.scale);
        this.switchTransition = null;
      }
    }
  }

  dispose() {
    this.clearProjectiles();
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();
    this.impactGeometry.dispose();
    for (const tracer of this.tracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
    }
    this.tracers.length = 0;
    for (const record of this.smokeMeshes.values()) {
      this.scene.remove(record.group);
      for (const material of record.materials) material.dispose();
    }
    this.smokeMeshes.clear();
    this.smokeGeometry.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const material of this.viewMaterialCache.values()) material.dispose();
    this.viewMaterialCache.clear();
    this.flashMesh.geometry.dispose();
    this.flashMaterial.dispose();
    this.camera.remove(this.viewModel);
    if (this.viewModelLight) this.camera.remove(this.viewModelLight);
  }
}
