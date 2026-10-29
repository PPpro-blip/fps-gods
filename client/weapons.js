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
const SHELL_WEAPONS = new Set(['SMG', 'PISTOL', 'SHOTGUN', 'LMG', 'SNIPER', 'MINIGUN']);
const SWITCH_DURATION_MS = 190;
const RECOIL_DECAY_PER_SECOND = 10;
const MAX_ACTIVE_SHELLS = 14;
const MAX_SURFACE_IMPACTS = 18;

const WEAPON_FEEL = Object.freeze({
  SMG: Object.freeze({ kick: 0.44, pitch: 0.048, decay: 10.5, flashScale: 0.96, flashMs: 48 }),
  PISTOL: Object.freeze({ kick: 0.48, pitch: 0.068, decay: 11.0, flashScale: 0.84, flashMs: 46 }),
  SHOTGUN: Object.freeze({ kick: 0.96, pitch: 0.095, decay: 8.6, flashScale: 1.48, flashMs: 66 }),
  SNIPER: Object.freeze({ kick: 1.02, pitch: 0.088, decay: 7.8, flashScale: 1.42, flashMs: 64 }),
  LMG: Object.freeze({ kick: 0.48, pitch: 0.052, decay: 10.2, flashScale: 1.18, flashMs: 52 }),
  MINIGUN: Object.freeze({ kick: 0.40, pitch: 0.042, decay: 11.0, flashScale: 1.12, flashMs: 44 }),
  RAILGUN: Object.freeze({ kick: 0.88, pitch: 0.062, decay: 9.4, flashScale: 1.38, flashMs: 68 }),
  ROCKET: Object.freeze({ kick: 1.08, pitch: 0.082, decay: 7.2, flashScale: 1.55, flashMs: 72 }),
});

/** Cosmetic-only ray vs AABB slab test so tracers stop at cover/walls and spark cleanly. */
function intersectBoxRay(ox, oy, oz, dx, dy, dz, minX, maxX, minY, maxY, minZ, maxZ, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  const axes = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (let i = 0; i < 3; i += 1) {
    const [o, d, lo, hi] = axes[i];
    if (Math.abs(d) < 1e-7) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0.05 && tmin <= maxDist ? tmin : null;
}

// Base hip-fire framing per weapon class (compact Krunker-inspired lower-right
// placement that keeps the center crosshair unobstructed across 60..110 FOV).
const WEAPON_PROFILES = Object.freeze({
  light: Object.freeze({ x: 0.22, y: -0.21, reach: 0.38, baseZ: -0.44, handScale: 0.96 }),
  heavy: Object.freeze({ x: 0.24, y: -0.25, reach: 0.38, baseZ: -0.44, handScale: 1.0 }),
  melee: Object.freeze({ x: 0.22, y: -0.22, reach: 0.34, baseZ: -0.44, handScale: 0.94 }),
  utility: Object.freeze({ x: 0.21, y: -0.22, reach: 0.38, baseZ: -0.44, handScale: 0.96 }),
  shield: Object.freeze({ x: 0.34, y: -0.32, reach: 0.36, baseZ: -0.43, handScale: 1.0 }),
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
 * every oriented GLB/GLTF (`-Z` forward muzzle/blade, `+Z` toward camera):
 *  - SMG (`smg.glb` 0.50m): rear pistol grip [y=-0.055, z=+0.150], barrel handguard [y=+0.072, z=-0.150]
 *  - SHOTGUN (`shotgun.glb` 0.72m): rear stock wrist [y=-0.008, z=+0.185], pump forend [y=-0.002, z=-0.175]
 *  - SNIPER (`sniper.glb` 0.94m): rear grip [y=-0.035, z=+0.180], forend [y=+0.012, z=-0.210]
 *  - PISTOL / SMOKE (`pistol.glb` 0.38m): two-handed Weaver grip on rear handle [y=-0.068, z=+0.112]
 *  - LMG / RAILGUN / MINIGUN (`lmg.glb` 0.78m): rear grip [y=-0.085, z=+0.145], forend [y=+0.048, z=-0.195]
 *  - ROCKET (`rocket_launcher_low.gltf` 0.72m, rotated 180° so warhead faces -Z):
 *      rear trigger grip [y=-0.120, z=+0.068], front vertical grip [y=-0.120, z=-0.115]
 *  - KNIFE (`Military knife.glb` 0.34m): single dominant right-hand grip on handle [y=+0.002, z=+0.095]
 *  - COMBAT_SHIELD (`LowPolyShieldPack.glb` 0.58m): dual rear-strap brace [z=+0.058] behind front plate
 */
function computeWeaponPose(weaponId, length) {
  switch (weaponId) {
    case 'KNIFE':
      return {
        mountRotation: [0.34, 0.22, -0.24],
        rightPos: [0.006, 0.002, Math.min(0.105, length * 0.28)],
        rightRot: [-0.22, 0.04, 0.06],
        // Kept in valid camera-space bounds while hidden so one-handed combat
        // knife never renders a disembodied floating off-hand.
        leftPos: [-0.075, -0.095, 0.035],
        leftRot: [0.18, -0.16, -0.14],
        leftVisible: false,
      };
    case 'GOD_FIST':
      return {
        mountRotation: [0.14, 0.08, -0.08],
        rightPos: [0.006, -0.018, 0.142],
        rightRot: [0.08, 0, 0.04],
        leftPos: [-0.008, 0.018, -0.115],
        leftRot: [0.22, -0.08, -0.18],
        leftVisible: true,
      };
    case 'PISTOL':
    case 'SMOKE_GRENADE':
      return {
        mountRotation: [0, 0, 0],
        // Two-handed Weaver/isosceles grip directly cupping the pistol handle.
        rightPos: [0.006, -0.066, Math.min(0.112, length * 0.29)],
        rightRot: [0.08, 0, 0.04],
        leftPos: [-0.012, -0.076, Math.min(0.096, length * 0.25)],
        leftRot: [0.12, -0.08, -0.08],
        leftVisible: true,
      };
    case 'SHOTGUN':
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.006, -0.010, 0.182],
        rightRot: [0.14, 0, 0.04],
        leftPos: [-0.008, -0.004, -0.175],
        leftRot: [0.22, -0.08, -0.22],
        leftVisible: true,
      };
    case 'SMG':
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.006, -0.052, 0.148],
        rightRot: [0.10, 0, 0.04],
        leftPos: [-0.010, -0.014, -0.142],
        leftRot: [0.18, -0.06, -0.16],
        leftVisible: true,
      };
    case 'SNIPER':
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.004, -0.036, 0.178],
        rightRot: [0.12, 0, 0.04],
        leftPos: [-0.010, -0.008, -0.205],
        leftRot: [0.20, -0.06, -0.16],
        leftVisible: true,
      };
    case 'LMG':
    case 'RAILGUN':
    case 'MINIGUN':
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.006, -0.084, 0.145],
        rightRot: [0.10, 0, 0.04],
        leftPos: [-0.010, -0.018, -0.188],
        leftRot: [0.20, -0.06, -0.16],
        leftVisible: true,
      };
    case 'ROCKET':
      return {
        // Shoulder-mounted inward yaw angles the PG-7V warhead toward center
        // screen while tucking the rear exhaust bell over the right shoulder.
        mountRotation: [0.02, 0.28, -0.02],
        baseOffset: [0.04, 0, -0.02],
        rightPos: [0.006, -0.118, 0.068],
        rightRot: [0.10, 0, 0.04],
        leftPos: [-0.008, -0.118, -0.115],
        leftRot: [0.14, -0.06, -0.08],
        leftVisible: true,
      };
    case 'COMBAT_SHIELD':
      return {
        mountRotation: [0.04, 0.16, -0.04],
        // Both hands brace the rear inner straps (+Z > +0.035) behind the shield face.
        rightPos: [0.046, -0.022, 0.058],
        rightRot: [0.08, 0, 0.06],
        leftPos: [-0.068, -0.028, 0.058],
        leftRot: [0.10, -0.06, -0.08],
        leftVisible: true,
      };
    default: {
      const forendZ = -Math.min(0.20, Math.max(0.12, length * 0.24));
      return {
        mountRotation: [0, 0, 0],
        rightPos: [0.006, -0.052, 0.125],
        rightRot: [0.10, 0, 0.04],
        leftPos: [-0.008, 0.010, forendZ],
        leftRot: [0.22, -0.08, -0.18],
        leftVisible: true,
      };
    }
  }
}

function hasAllZeroVertexColors(geometry) {
  const colorAttr = geometry?.attributes?.color;
  if (!colorAttr || colorAttr.count === 0) return false;
  const sampleStep = Math.max(1, Math.floor(colorAttr.count / 64));
  for (let i = 0; i < colorAttr.count; i += sampleStep) {
    if (colorAttr.getX(i) > 0.02 || colorAttr.getY(i) > 0.02 || colorAttr.getZ(i) > 0.02) {
      return false;
    }
  }
  return true;
}

function normalizeWeaponMaterial(source, file, strippedZeroVertexColors) {
  if (!source) return source;
  const mat = source.clone();
  if (strippedZeroVertexColors) {
    mat.vertexColors = false;
  }
  // Several low-poly OB* firearms export metalness=1, roughness=1 with dark
  // albedo and no scene HDRI envMap, which collapses lit diffuse shading to black.
  if (typeof mat.metalness === 'number' && mat.metalness > 0.46) {
    mat.metalness = 0.44;
  }
  if (typeof mat.roughness === 'number') {
    mat.roughness = Math.min(0.58, Math.max(0.36, mat.roughness));
  }
  return mat;
}

/**
 * Rotate a loaded GLB so its barrel points down -Z and normalise its length to
 * the measured real-world size. Clones share normalized geometry, so every
 * weapon rig in the game is cheap after the first load.
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
  } else if (file === 'rocket_launcher_low.gltf') {
    // Orient PG-7V warhead forward (-Z) and flared exhaust cone rearward (+Z).
    oriented.rotation.y = Math.PI;
  } else {
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
  const normalizedMaterialCache = new Map();
  fitted.traverse((meshPart) => {
    if (!meshPart.isMesh) return;
    meshPart.castShadow = false;
    meshPart.receiveShadow = false;
    meshPart.frustumCulled = false;

    let strippedZeroColors = false;
    if (hasAllZeroVertexColors(meshPart.geometry)) {
      meshPart.geometry = meshPart.geometry.clone();
      meshPart.geometry.deleteAttribute('color');
      strippedZeroColors = true;
    }
    const mapMat = (mat) => {
      if (!mat) return mat;
      const key = `${mat.uuid}:${strippedZeroColors ? 1 : 0}`;
      if (!normalizedMaterialCache.has(key)) {
        normalizedMaterialCache.set(key, normalizeWeaponMaterial(mat, file, strippedZeroColors));
      }
      return normalizedMaterialCache.get(key);
    };
    meshPart.material = Array.isArray(meshPart.material)
      ? meshPart.material.map(mapMat)
      : mapMat(meshPart.material);
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

const UP_AXIS = new THREE.Vector3(0, 1, 0);

function part(geometry, material, parent, position, rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.scale.set(...scale);
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

function connectedSegment(geometry, material, parent, fromPoint, toPoint, scale = [1, 1, 1]) {
  const start = new THREE.Vector3(...fromPoint);
  const end = new THREE.Vector3(...toPoint);
  const delta = end.clone().sub(start);
  const dir = delta.lengthSq() > 1e-8 ? delta.clone().normalize() : UP_AXIS;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).addScaledVector(delta, 0.5);
  mesh.quaternion.setFromUnitVectors(UP_AXIS, dir);
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
    this.shells = [];
    this.surfaceImpacts = [];
    this.shellRoot = new THREE.Group();
    this.camera.add(this.shellRoot);
    this.shellGeometry = null;
    this.shellMaterial = null;
    this.surfaceSparkGeometry = null;
    this.arenaContext = null;
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
    this.strafeInput = 0;
    this.forwardInput = 0;
    this.verticalVelocity = 0;
    this.groundedState = true;
    this.reducedMotion = false;
    this.lookSwayX = 0;
    this.lookSwayY = 0;
    this.strafeTilt = 0;
    this.airOffset = 0;
    this.landingDip = 0;
    this.stridePhase = 0;
    this.recoilYaw = 0;
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
    // Grounded tactical operator sleeve & glove materials (subtle low-intensity
    // fill emissive avoids pitch-black undersides without neon glowing hands).
    const sleeve = new THREE.MeshStandardMaterial({
      color: '#1e2630', roughness: 0.80, metalness: 0.06, emissive: '#080e14', emissiveIntensity: 0.14,
    });
    const glove = new THREE.MeshStandardMaterial({
      color: '#161c24', roughness: 0.64, metalness: 0.14, emissive: '#060a10', emissiveIntensity: 0.14,
    });
    const seam = new THREE.MeshStandardMaterial({
      color: '#2d3d4e', roughness: 0.52, metalness: 0.26, emissive: '#0a131c', emissiveIntensity: 0.16,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: '#39586e', roughness: 0.44, metalness: 0.34, emissive: '#10222e', emissiveIntensity: 0.20,
    });
    this.materials.push(sleeve, glove, seam, accent);

    // Tapered anatomical sleeve cylinder & structured gauntlet cuff stretched
    // dynamically each frame from the wrist to a natural lower-right bent-elbow
    // anchor so forearms look muscular and solid rather than thin rods.
    const armGeometry = new THREE.CylinderGeometry(0.031, 0.041, 1.0, 12, 1);
    const cuffGeometry = new THREE.CylinderGeometry(0.034, 0.031, 0.042, 12);
    const palmGeometry = new THREE.BoxGeometry(0.025, 0.052, 0.056);
    const fingerGeometry = new THREE.CapsuleGeometry(0.0072, 0.025, 3, 6);
    const thumbGeometry = new THREE.CapsuleGeometry(0.0078, 0.025, 3, 6);
    const knuckleGeometry = new THREE.BoxGeometry(0.009, 0.044, 0.042);
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
    this._wristTmp = new THREE.Vector3();
    this._elbowCamTmp = new THREE.Vector3();
    this._elbowWorldTmp = new THREE.Vector3();
    this._armDirTmp = new THREE.Vector3();

    this.rightPalm = part(palmGeometry, glove, this.rightHandGroup, [0.020, -0.003, 0.004], [0.10, 0.04, 0.06]);
    this.rightCuff = part(cuffGeometry, seam, this.rightHandGroup, [0.026, -0.018, 0.030]);
    this.rightArm = part(armGeometry, sleeve, this.rightHandGroup, [0.046, -0.052, 0.078], [0, 0, 0], [1, 0.14, 1]);
    this.rightThumb = part(thumbGeometry, glove, this.rightHandGroup, [0.004, 0.020, -0.010], [0.35, 0.30, 1.08]);

    this.leftPalm = part(palmGeometry, glove, this.leftHandGroup, [-0.020, -0.005, 0.004], [0.10, -0.04, -0.06]);
    this.leftCuff = part(cuffGeometry, seam, this.leftHandGroup, [-0.026, -0.020, 0.030]);
    this.leftArm = part(armGeometry, sleeve, this.leftHandGroup, [-0.046, -0.054, 0.078], [0, 0, 0], [1, 0.14, 1]);
    this.leftThumb = part(thumbGeometry, glove, this.leftHandGroup, [-0.004, 0.018, -0.010], [0.35, -0.30, -1.08]);

    this.fingers = [];
    this.rightFingers = [];
    this.leftFingers = [];
    for (let i = 0; i < 4; i += 1) {
      const spread = (i - 1.5) * 0.0115;
      const rf = part(
        fingerGeometry,
        glove,
        this.rightHandGroup,
        [-0.009, spread - 0.002, -0.016],
        [0.08, 0.16, Math.PI / 2 - 0.18],
      );
      const lf = part(
        fingerGeometry,
        glove,
        this.leftHandGroup,
        [0.009, spread - 0.004, -0.016],
        [0.08, -0.16, -Math.PI / 2 + 0.18],
      );
      this.rightFingers.push(rf);
      this.leftFingers.push(lf);
      this.fingers.push(rf, lf);
    }

    this.knuckles = [
      part(knuckleGeometry, accent, this.rightHandGroup, [0.033, -0.002, 0.003], [0.10, 0.04, 0.06]),
      part(knuckleGeometry, accent, this.leftHandGroup, [-0.033, -0.004, 0.003], [0.10, -0.04, -0.06]),
    ];
  }

  buildFlash() {
    this.muzzle = new THREE.Object3D();
    this.weaponMount.add(this.muzzle);
    this.flashMaterial = new THREE.MeshBasicMaterial({
      color: '#ffe6a3', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
    });
    const coreGeo = new THREE.SphereGeometry(0.038, 8, 6);
    const finGeo = new THREE.PlaneGeometry(0.155, 0.036);
    const jetGeo = new THREE.ConeGeometry(0.028, 0.13, 6);
    jetGeo.rotateX(-Math.PI / 2);
    this.geometries.push(coreGeo, finGeo, jetGeo);

    this.flashMesh = new THREE.Mesh(coreGeo, this.flashMaterial);
    const finA = new THREE.Mesh(finGeo, this.flashMaterial);
    const finB = new THREE.Mesh(finGeo, this.flashMaterial);
    finB.rotation.z = Math.PI / 2;
    const jet = new THREE.Mesh(jetGeo, this.flashMaterial);
    jet.position.z = -0.055;
    this.flashMesh.add(finA, finB, jet);
    this.flashMesh.visible = false;
    this.muzzle.add(this.flashMesh);

    this.flashLight = new THREE.PointLight('#ffe0a0', 2.6, 2.8, 2);
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

    const key = new THREE.PointLight('#eef6ff', 1.45, 2.8, 2);
    key.position.set(0.12, 0.2, 0.34);
    const rim = new THREE.PointLight('#6ccfff', 0.85, 2.4, 2);
    rim.position.set(-0.34, -0.08, -0.58);
    this.viewModelLight.add(key, rim);
    this.camera.add(this.viewModelLight);
    this.lights = [key, rim];
  }

  syncForearmLimb(handGroup, cuffMesh, armMesh, wristX, wristY, wristZ, cameraAnchorX, cameraAnchorY, cameraAnchorZ) {
    this._wristTmp.set(wristX, wristY, wristZ);
    this._elbowCamTmp.set(cameraAnchorX, cameraAnchorY, cameraAnchorZ);
    this._elbowWorldTmp.copy(this._elbowCamTmp).applyMatrix4(this.camera.matrixWorld);
    handGroup.worldToLocal(this._elbowWorldTmp);

    this._armDirTmp.subVectors(this._elbowWorldTmp, this._wristTmp);
    const rawLen = this._armDirTmp.length();
    const len = Math.min(0.62, Math.max(0.12, rawLen));
    if (rawLen > 1e-5) this._armDirTmp.divideScalar(rawLen);
    else this._armDirTmp.set(0, -1, 0);

    cuffMesh.position.copy(this._wristTmp).addScaledVector(this._armDirTmp, 0.016);
    cuffMesh.quaternion.setFromUnitVectors(UP_AXIS, this._armDirTmp);

    armMesh.position.copy(this._wristTmp).addScaledVector(this._armDirTmp, len * 0.5 + 0.016);
    armMesh.quaternion.copy(cuffMesh.quaternion);
    armMesh.scale.set(0.92, len, 1.06);
  }

  syncForearmAnchors() {
    if (!this.rightHandGroup || !this.leftHandGroup) return;
    this.camera.updateMatrixWorld(true);
    this.viewModel.updateMatrixWorld(true);
    const ads = this.aimAmount;
    // Right dominant elbow tucks below the lower-right viewport edge; left
    // support elbow rises naturally from beneath the weapon rather than
    // stretching diagonally across center screen. All anchors stay strictly
    // forward of -0.43 m so no hand mesh ever approaches the near plane.
    this.syncForearmLimb(
      this.rightHandGroup,
      this.rightCuff,
      this.rightArm,
      0.020, -0.008, 0.018,
      0.35 - ads * 0.14, -0.46, -0.44,
    );

    let leftAnchorX = 0.05 - ads * 0.14;
    let leftAnchorY = -0.46;
    if (this.weaponId === 'COMBAT_SHIELD') {
      leftAnchorX = -0.02;
      leftAnchorY = -0.49;
    } else if (this.weaponId === 'PISTOL' || this.weaponId === 'SMOKE_GRENADE') {
      leftAnchorX = 0.11 - ads * 0.12;
      leftAnchorY = -0.47;
    }
    this.syncForearmLimb(
      this.leftHandGroup,
      this.leftCuff,
      this.leftArm,
      -0.020, -0.010, 0.018,
      leftAnchorX, leftAnchorY, -0.45,
    );
  }

  layoutForWeapon(weaponId) {
    const length = this.modelLibrary.getLength(weaponId);
    const weaponClass = WEAPON_CLASS[weaponId] ?? 'light';
    const profile = WEAPON_PROFILES[weaponClass] ?? WEAPON_PROFILES.light;
    this.currentPose = computeWeaponPose(weaponId, length);
    const [ox = 0, oy = 0, oz = 0] = this.currentPose.baseOffset ?? [0, 0, 0];
    this.basePosition = {
      x: profile.x + ox,
      y: profile.y + oy,
      z: (profile.baseZ ?? -0.44) - length * profile.reach + oz,
    };
    this.handRig.position.set(0, 0, 0);
    this.handRig.scale.setScalar(profile.handScale);

    this.rightHandGroup.position.set(...this.currentPose.rightPos);
    this.rightHandGroup.rotation.set(...this.currentPose.rightRot);
    this.leftHandGroup.position.set(...this.currentPose.leftPos);
    this.leftHandGroup.rotation.set(...this.currentPose.leftRot);
    this.leftHandGroup.visible = this.currentPose.leftVisible !== false;

    const [mx, my, mz] = this.currentPose.mountRotation;
    this.weaponMount.rotation.set(mx, my, mz);
    if (this.basePosition) {
      this.viewModel.position.set(this.basePosition.x, this.basePosition.y, this.basePosition.z);
    }
    this.syncForearmAnchors();

    this.updateMuzzlePosition();
  }

  resetPresentation() {
    this.reloadStartedAt = null;
    this.recoil = 0;
    this.recoilYaw = 0;
    this.lookSwayX = 0;
    this.lookSwayY = 0;
    this.strafeTilt = 0;
    this.airOffset = 0;
    this.landingDip = 0;
    this.meleeStartedAt = null;
    this.blockingTarget = false;
    this.blockingAmount = 0;
    this.opticalScopeHidden = false;
    this.weaponMount.visible = true;
    this.setVisible(true);
    this.clearShellsAndSurfaceImpacts();
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
      this.rightHandGroup.rotation.set(...this.currentPose.rightRot);
      this.leftHandGroup.position.set(...this.currentPose.leftPos);
      this.leftHandGroup.rotation.set(...this.currentPose.leftRot);
      this.leftHandGroup.visible = this.currentPose.leftVisible !== false;
      const [mx, my, mz] = this.currentPose.mountRotation;
      this.weaponMount.rotation.set(mx, my, mz);
    }
    this.syncForearmAnchors();
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

  /**
   * High-frequency local movement & look feed for responsive 1P weapon inertia,
   * directional banking, airborne float, and landing compression.
   */
  setMotionState({
    speed = 0,
    forward = 0,
    strafe = 0,
    vy = 0,
    grounded = true,
    lookYawDelta = 0,
    lookPitchDelta = 0,
    reducedMotion = false,
  } = {}) {
    const targetMove = Math.max(0, Math.min(1, (Number(speed) || 0) / 7.2));
    this.movementAmount += (targetMove - this.movementAmount) * 0.35;
    this.forwardInput = Math.max(-1, Math.min(1, Number(forward) || 0));
    this.strafeInput = Math.max(-1, Math.min(1, Number(strafe) || 0));
    this.verticalVelocity = Number(vy) || 0;
    this.groundedState = grounded !== false;
    this.reducedMotion = reducedMotion === true;

    const swayScale = this.reducedMotion ? 0.25 : 1;
    this.lookSwayX = Math.max(-0.022, Math.min(0.022, this.lookSwayX + (Number(lookYawDelta) || 0) * 0.22 * swayScale));
    this.lookSwayY = Math.max(-0.018, Math.min(0.018, this.lookSwayY + (Number(lookPitchDelta) || 0) * 0.20 * swayScale));
  }

  triggerLanding(impactSpeed = 5) {
    const scale = this.reducedMotion ? 0.25 : 1;
    const impulse = Math.min(0.036, Math.max(0.008, Math.abs(Number(impactSpeed) || 0) * 0.0038)) * scale;
    this.landingDip = Math.max(this.landingDip, impulse);
  }

  /**
   * Optional arena reference used solely to clip cosmetic tracers at cover/walls
   * and place cosmetic impact sparks. Never influences server hit detection.
   */
  setArenaContext(context) {
    this.arenaContext = context ?? null;
  }

  resolveCosmeticRayHit(origin, direction, maxDistance) {
    const ctx = this.arenaContext;
    if (!ctx) return null;
    const map = typeof ctx.getMap === 'function' ? ctx.getMap() : ctx.map;
    if (!map?.bounds) return null;

    let closest = maxDistance;
    let hitSurface = false;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;

    const coverList = typeof ctx.getCover === 'function' ? ctx.getCover() : map.cover;
    if (Array.isArray(coverList)) {
      for (let i = 0; i < coverList.length; i += 1) {
        const b = coverList[i];
        if (!b || b.destroyed) continue;
        const hw = b.width * 0.5;
        const hd = b.depth * 0.5;
        const baseY = Number.isFinite(b.y) ? b.y - b.height * 0.5 : 0;
        const t = intersectBoxRay(
          ox, oy, oz, dx, dy, dz,
          b.x - hw, b.x + hw, baseY, baseY + b.height, b.z - hd, b.z + hd,
          closest,
        );
        if (t !== null && t < closest) {
          closest = t;
          hitSurface = true;
        }
      }
    }

    // Floor y = 0
    if (dy < -1e-5 && oy > 0) {
      const tf = -oy / dy;
      if (tf > 0.05 && tf < closest) {
        closest = tf;
        hitSurface = true;
      }
    }

    // Perimeter inner walls
    const limX = map.bounds.halfWidth - (map.bounds.wallThickness ?? 1) * 0.5;
    const limZ = map.bounds.halfDepth - (map.bounds.wallThickness ?? 1) * 0.5;
    const wallH = map.bounds.wallHeight ?? 6;
    if (Math.abs(dx) > 1e-5) {
      const targetX = dx > 0 ? limX : -limX;
      const tw = (targetX - ox) / dx;
      const hy = oy + dy * tw;
      const hz = oz + dz * tw;
      if (tw > 0.05 && tw < closest && hy >= 0 && hy <= wallH && Math.abs(hz) <= limZ + 0.5) {
        closest = tw;
        hitSurface = true;
      }
    }
    if (Math.abs(dz) > 1e-5) {
      const targetZ = dz > 0 ? limZ : -limZ;
      const tw = (targetZ - oz) / dz;
      const hy = oy + dy * tw;
      const hx = ox + dx * tw;
      if (tw > 0.05 && tw < closest && hy >= 0 && hy <= wallH && Math.abs(hx) <= limX + 0.5) {
        closest = tw;
        hitSurface = true;
      }
    }

    if (!hitSurface) return null;
    return {
      distance: closest,
      point: new THREE.Vector3(ox + dx * closest, oy + dy * closest, oz + dz * closest),
    };
  }

  spawnSurfaceImpact(point, color = '#ffd27d', now = performance.now()) {
    if (!point) return;
    if (!this.surfaceSparkGeometry) {
      this.surfaceSparkGeometry = new THREE.OctahedronGeometry(0.065, 0);
    }
    if (this.surfaceImpacts.length >= MAX_SURFACE_IMPACTS) {
      const oldest = this.surfaceImpacts.shift();
      this.scene.remove(oldest.mesh);
      oldest.mesh.material.dispose();
    }
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.surfaceSparkGeometry, material);
    mesh.position.copy(point);
    mesh.rotation.set(Math.random() * 3.14, Math.random() * 3.14, 0);
    this.scene.add(mesh);
    this.surfaceImpacts.push({ mesh, start: now, lifeMs: 185 });
  }

  ejectShellCasing(now = performance.now(), weaponId = this.weaponId) {
    if (this.reducedMotion || !SHELL_WEAPONS.has(weaponId) || !this.viewModel.visible) return;
    if (!this.shellGeometry) {
      this.shellGeometry = new THREE.CylinderGeometry(0.0048, 0.0048, 0.022, 6);
      this.shellMaterial = new THREE.MeshBasicMaterial({
        color: '#e8bc62', transparent: true, opacity: 0.94,
      });
    }
    if (this.shells.length >= MAX_ACTIVE_SHELLS) {
      const oldest = this.shells.shift();
      this.shellRoot.remove(oldest.mesh);
    }

    const portWorld = this.weaponMount.localToWorld(new THREE.Vector3(0.032, 0.024, 0.02));
    const origin = this.camera.worldToLocal(portWorld);
    const velocity = new THREE.Vector3(
      1.15 + Math.random() * 0.45,
      0.95 + Math.random() * 0.35,
      0.18 + Math.random() * 0.24,
    );

    const mesh = new THREE.Mesh(this.shellGeometry, this.shellMaterial);
    mesh.position.copy(origin);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    this.shellRoot.add(mesh);
    this.shells.push({
      mesh,
      velocity,
      spinX: 14 + Math.random() * 10,
      spinZ: -12 - Math.random() * 10,
      expiresAt: now + 390,
    });
  }

  clearShellsAndSurfaceImpacts() {
    for (const s of this.shells) {
      this.shellRoot.remove(s.mesh);
    }
    this.shells.length = 0;
    for (const imp of this.surfaceImpacts) {
      this.scene.remove(imp.mesh);
      imp.mesh.material.dispose();
    }
    this.surfaceImpacts.length = 0;
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
      const maxDistance = weaponId === 'ROCKET' ? 34 : 58;
      const surfaceHit = this.resolveCosmeticRayHit(start, direction, maxDistance);
      const end = surfaceHit
        ? surfaceHit.point
        : start.clone().addScaledVector(direction, maxDistance);
      const lifeMs = weaponId === 'RAILGUN' || weaponId === 'SNIPER' ? 145 : 100;
      this.addTracer(start, end, tracerColor, lifeMs, 0.92, now);
      if (surfaceHit) {
        this.spawnSurfaceImpact(surfaceHit.point, tracerColor, now);
      }

      // Cosmetic multi-pellet buckshot streaks for Shotgun visual punch in live arenas.
      if (weaponId === 'SHOTGUN' && !authoritativeShot && this.arenaContext) {
        const spreadOffsets = [
          [0.028, 0.016],
          [-0.026, 0.018],
          [0.018, -0.024],
        ];
        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        for (const [ox, oy] of spreadOffsets) {
          const pelletDir = direction.clone()
            .addScaledVector(camRight, ox)
            .addScaledVector(camUp, oy)
            .normalize();
          const pelletHit = this.resolveCosmeticRayHit(start, pelletDir, 28);
          const pelletEnd = pelletHit ? pelletHit.point : start.clone().addScaledVector(pelletDir, 24);
          this.addTracer(start, pelletEnd, tracerColor, 85, 0.62, now);
          if (pelletHit) this.spawnSurfaceImpact(pelletHit.point, '#ffd596', now);
        }
      }
    } else if (weaponId === 'PISTOL') {
      // Subtle surface impact spark on Pistol hits against walls/cover without heavy tracer beam.
      const start = authoritativeShot?.origin
        ? new THREE.Vector3(authoritativeShot.origin.x, authoritativeShot.origin.y, authoritativeShot.origin.z)
        : this.camera.getWorldPosition(new THREE.Vector3());
      const direction = authoritativeShot?.direction
        ? new THREE.Vector3(authoritativeShot.direction.x, authoritativeShot.direction.y, authoritativeShot.direction.z).normalize()
        : new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
      const surfaceHit = this.resolveCosmeticRayHit(start, direction, 48);
      if (surfaceHit) this.spawnSurfaceImpact(surfaceHit.point, '#ffe0a3', now);
    }

    if (present) this.presentFire(now, weaponId, bundleId);
  }

  presentFire(now = performance.now(), weaponId = this.weaponId, bundleId = this.bundleId) {
    if (weaponId === 'KNIFE' || weaponId === 'GOD_FIST') {
      this.meleeStartedAt = now;
      return;
    }
    if (!NO_FLASH.has(weaponId)) {
      const feel = WEAPON_FEEL[weaponId] ?? WEAPON_FEEL.SMG;
      const tracerColor = BUNDLE_TRACER_COLOR[bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER;
      this.flashMaterial.color.set(tracerColor);
      this.flashLight.color.set(tracerColor);
      this.flashMesh.rotation.z = Math.random() * Math.PI;
      this.flashMesh.scale.setScalar(feel.flashScale);
      this.flashUntil = now + feel.flashMs;
      this.flashMesh.visible = true;
      this.flashLight.visible = true;
      this.recoil = Math.min(1.45, this.recoil + feel.kick);
      this.recoilYaw = (Math.random() - 0.5) * 0.016 * feel.kick;
      this.ejectShellCasing(now, weaponId);
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
    const maxDist = weaponId === 'ROCKET' ? 34 : 58;
    const surfaceHit = this.resolveCosmeticRayHit(start, ray, maxDist);
    const end = surfaceHit ? surfaceHit.point : start.clone().addScaledVector(ray, maxDist);
    const color = BUNDLE_TRACER_COLOR[bundleId] ?? BUNDLE_TRACER_COLOR.RUSHER;
    this.addTracer(start, end, color, 100, 0.8, now);
    if (surfaceHit) this.spawnSurfaceImpact(surfaceHit.point, color, now);
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
    this.clearShellsAndSurfaceImpacts();
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

    for (let index = this.surfaceImpacts.length - 1; index >= 0; index -= 1) {
      const imp = this.surfaceImpacts[index];
      const progress = Math.max(0, (now - imp.start) / imp.lifeMs);
      if (progress >= 1) {
        this.scene.remove(imp.mesh);
        imp.mesh.material.dispose();
        this.surfaceImpacts.splice(index, 1);
      } else {
        imp.mesh.scale.setScalar(0.55 + progress * 1.45);
        imp.mesh.material.opacity = (1 - progress) * 0.88;
      }
    }
    for (let index = this.shells.length - 1; index >= 0; index -= 1) {
      const shell = this.shells[index];
      if (now >= shell.expiresAt) {
        this.shellRoot.remove(shell.mesh);
        this.shells.splice(index, 1);
      } else {
        shell.velocity.y -= 9.8 * delta;
        shell.mesh.position.addScaledVector(shell.velocity, delta);
        shell.mesh.rotation.x += shell.spinX * delta;
        shell.mesh.rotation.z += shell.spinZ * delta;
      }
    }

    const flashVisible = now < this.flashUntil;
    this.flashMesh.visible = flashVisible;
    this.flashLight.visible = flashVisible;

    const motionScale = this.reducedMotion ? 0.22 : 1;
    const moving = this.groundedState ? this.movementAmount : this.movementAmount * 0.22;
    this.stridePhase += delta * (4.2 + moving * 7.0) * (moving > 0.04 ? 1 : 0);

    // Subtle organic idle breath + rhythmic grounded stride figure-8.
    const tSec = now * 0.001;
    const idleX = Math.sin(tSec * 1.55) * 0.0016 * motionScale;
    const idleY = Math.cos(tSec * 3.1) * 0.0020 * motionScale;
    const bob = Math.abs(Math.sin(this.stridePhase)) * -0.0115 * moving * motionScale;
    const sway = Math.sin(this.stridePhase) * 0.0072 * moving * motionScale;

    // Smoothly decay mouse-look lag, strafe bank, airborne float, and landing dip.
    const damp = 1 - Math.exp(-13 * delta);
    this.lookSwayX += (0 - this.lookSwayX) * damp;
    this.lookSwayY += (0 - this.lookSwayY) * damp;
    const targetStrafeTilt = -this.strafeInput * 0.026 * motionScale;
    this.strafeTilt += (targetStrafeTilt - this.strafeTilt) * (1 - Math.exp(-11 * delta));
    const targetAirOffset = this.groundedState
      ? 0
      : Math.max(-0.016, Math.min(0.016, -this.verticalVelocity * 0.0028 * motionScale));
    this.airOffset += (targetAirOffset - this.airOffset) * (1 - Math.exp(-10 * delta));
    this.landingDip *= Math.exp(-15 * delta);
    if (this.landingDip < 1e-4) this.landingDip = 0;

    const reloadProgress = this.reloadStartedAt === null
      ? 0
      : Math.max(0, Math.min(1, (now - this.reloadStartedAt) / this.reloadDuration));
    if (reloadProgress >= 1) this.reloadStartedAt = null;
    const reloadWave = this.reloadStartedAt === null ? 0 : Math.sin(reloadProgress * Math.PI);
    const reloadDip = reloadWave * 0.125;

    const feel = WEAPON_FEEL[this.weaponId] ?? WEAPON_FEEL.SMG;
    this.recoil = Math.max(0, this.recoil - (feel.decay ?? RECOIL_DECAY_PER_SECOND) * delta);
    this.recoilYaw *= Math.exp(-14 * delta);

    const base = this.basePosition ?? { x: 0.26, y: -0.22, z: -0.62 };
    const aim = this.aimProfile?.offset ?? [base.x, base.y, base.z];
    const amount = this.aimAmount;
    const hipSwayFactor = 1 - amount * 0.88;
    this.blockingAmount += ((this.blockingTarget ? 1 : 0) - this.blockingAmount) * (1 - Math.exp(-14 * delta));
    const meleeProgress = this.meleeStartedAt === null ? 1 : (now - this.meleeStartedAt) / 240;
    const swing = meleeProgress >= 0 && meleeProgress < 1 ? Math.sin(meleeProgress * Math.PI) : 0;
    const slashArc = meleeProgress >= 0 && meleeProgress < 1 ? Math.sin(meleeProgress * Math.PI * 2) : 0;
    if (meleeProgress >= 1) this.meleeStartedAt = null;

    this.viewModel.position.x = base.x + (aim[0] - base.x) * amount
      + (sway + idleX + this.lookSwayX) * hipSwayFactor
      - this.recoil * 0.003 - this.blockingAmount * 0.13 - swing * 0.07;
    this.viewModel.position.y = base.y + (aim[1] - base.y) * amount
      + (bob + idleY + this.lookSwayY + this.airOffset) * hipSwayFactor
      - this.landingDip - reloadDip + this.recoil * 0.012 + this.blockingAmount * 0.095 + swing * 0.025;
    this.viewModel.position.z = base.z + (aim[2] - base.z) * amount
      + reloadDip * 0.42 + this.recoil * 0.052 + this.blockingAmount * 0.035 - swing * 0.145;

    const pitchKick = this.recoil * (feel.pitch ?? 0.055);
    this.viewModel.rotation.z = (Math.sin(this.stridePhase) * 0.011 * moving * motionScale + this.strafeTilt - this.lookSwayX * 0.7) * (1 - amount) - swing * 0.42;
    this.viewModel.rotation.x = -0.015 * (1 - amount) + reloadDip * 0.52 - pitchKick - this.landingDip * 1.1 + swing * 0.44;
    this.viewModel.rotation.y = -0.035 * (1 - amount) - this.lookSwayX * 0.65 * (1 - amount) + this.recoilYaw + slashArc * 0.18;

    // Blend weaponMount rest orientation cleanly to zero as ADS approaches 1,
    // and animate the cohesive support hand toward the magwell during reloads.
    if (this.currentPose) {
      const [mx, my, mz] = this.currentPose.mountRotation;
      const [amx = 0, amy = 0, amz = 0] = this.currentPose.mountAimRotation ?? [0, 0, 0];
      const hipFactor = 1 - amount;
      const guardPitch = -this.blockingAmount * 0.04;
      const guardYaw = -this.blockingAmount * 0.14;
      this.weaponMount.rotation.set(
        mx * hipFactor + amx * amount + guardPitch,
        my * hipFactor + amy * amount + guardYaw,
        mz * hipFactor + amz * amount,
      );
      const [lx, ly, lz] = this.currentPose.leftPos;
      this.leftHandGroup.position.set(
        lx + reloadWave * 0.018,
        ly - reloadWave * 0.075,
        lz + reloadWave * 0.095,
      );
    }
    this.syncForearmAnchors();

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
    if (this.shellRoot) {
      this.camera.remove(this.shellRoot);
    }
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();
    this.impactGeometry.dispose();
    if (this.shellGeometry) {
      this.shellGeometry.dispose();
      this.shellGeometry = null;
    }
    if (this.shellMaterial) {
      this.shellMaterial.dispose();
      this.shellMaterial = null;
    }
    if (this.surfaceSparkGeometry) {
      this.surfaceSparkGeometry.dispose();
      this.surfaceSparkGeometry = null;
    }
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
    this.flashMaterial.dispose();
    this.camera.remove(this.viewModel);
    if (this.viewModelLight) this.camera.remove(this.viewModelLight);
  }
}
