import * as THREE from 'three';
import { WEAPON_MODEL_FILE, WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';

// The seven GLB URLs are imported lazily (see `client/weaponAssets.js`) so this
// module stays importable outside Vite — the tests exercise the viewmodel,
// tracers and smoke without a bundler.

const WEAPON_MODEL = WEAPON_MODEL_FILE;
// Real lengths in metres, measured from each GLB's bounding box.
const MODEL_LENGTH = WEAPON_MODEL_LENGTH;

const BUNDLE_TRACER_COLOR = Object.freeze({
  RUSHER: '#59d8ff',
  GHOST: '#c18aff',
  HEAVY: '#ff8b3d',
  GODS_TIER: '#ffd45e',
});

const NO_TRACER = new Set(['PISTOL', 'KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD', 'ROCKET']);
const NO_FLASH = new Set(['KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD']);
const SWITCH_DURATION_MS = 200;
const RECOIL_DECAY_PER_SECOND = 9;
// Where each weapon class sits in first-person view. `reach` multiplies the
// model length into the distance from the camera, so long guns stay in front of
// the near plane without swallowing the frame.
const WEAPON_PROFILES = Object.freeze({
  light: Object.freeze({ x: 0.2, y: -0.2, reach: 0.4, handX: 0.0, handY: 0.0, handScale: 1 }),
  heavy: Object.freeze({ x: 0.24, y: -0.26, reach: 0.4, handX: 0.01, handY: -0.01, handScale: 1.05 }),
  melee: Object.freeze({ x: 0.19, y: -0.23, reach: 0.4, handX: 0.0, handY: -0.02, handScale: 0.95 }),
  utility: Object.freeze({ x: 0.21, y: -0.24, reach: 0.32, handX: 0.0, handY: -0.01, handScale: 1 }),
  shield: Object.freeze({ x: 0.35, y: -0.34, reach: 0.4, handX: 0.0, handY: -0.01, handScale: 1 }),
});

const WEAPON_CLASS = Object.freeze({
  SMG: 'light', PISTOL: 'light', SHOTGUN: 'heavy', SNIPER: 'heavy', LMG: 'heavy',
  ROCKET: 'heavy', RAILGUN: 'heavy', MINIGUN: 'heavy', KNIFE: 'melee', GOD_FIST: 'melee',
  SMOKE_GRENADE: 'utility', COMBAT_SHIELD: 'shield',
});

/**
 * Rotate a loaded GLB so its barrel points down -Z and normalise its length to
 * the measured real-world size. Clones share geometry, so every weapon rig in
 * the game is cheap after the first load.
 */
export function orientModel(scene, file) {
  // The shield file is a pack of twelve separate shields. Clone exactly one,
  // not the entire pack (which would otherwise cover the view and waste draw
  // calls). Its original faces lie in YZ; guns/knife use different axes.
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
    oriented.rotation.x = -Math.PI / 2; // authored long axis +Y -> forward -Z
  } else if (file !== 'rocket_launcher_low.gltf') {
    // Existing GLBs were authored along +X with +Z up.
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
  fitted.traverse((part) => {
    if (part.isMesh) {
      part.castShadow = false;
      part.receiveShadow = false;
      part.frustumCulled = false;
    }
  });
  return fitted;
}

// Core firearms preload for the menu. The three larger new models load only
// when a menu stand or a player actually needs them; requests are deduplicated.
const CORE_FILES = ['smg.glb', 'shotgun.glb', 'sniper.glb', 'pistol.glb', 'lmg.glb', 'knife.glb'];

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

// Clones borrow cached geometry/materials/textures. Dispose the shared owners
// once on teardown, never while a viewmodel or remote operator still uses them.
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

// First-person presentation: a GLB weapon plus gloved hands, both parented to
// the camera. The server independently resolves every shot and every point of
// damage; nothing here can change the outcome of a fight.
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
    this.geometries = [];
    this.materials = [];
    this.viewMaterialCache = new Map();

    this.viewModel = new THREE.Group();
    this.viewModel.position.set(0.26, -0.24, -0.62);
    this.viewModel.rotation.set(-0.015, -0.035, 0);
    camera.add(this.viewModel);
    this.gun = this.viewModel;
    this.handRig = new THREE.Group();
    this.viewModel.add(this.handRig);

    this.buildHands();
    this.buildFlash();
    // Draw hands/weapons after all world geometry (including transparency) so
    // nearby cover cannot clip the first-person model. Keep depth within the rig.
    for (const material of this.materials) material.transparent = true;
    this.viewModel.traverse((object) => { if (object.isMesh) object.renderOrder = 1000; });
    this.buildViewModelDepthReset();
    this.buildViewModelLight();
    this.setWeapon('SMG', 'RUSHER', false);
    this.modelLibrary.onReady(() => this.installActiveModel(performance.now(), false));
  }

  /**
   * Gloved hands wrapped around the grip.
   *
   * Placement rule this method exists to enforce: nothing may sit closer than
   * ~0.35 m to the camera. The previous rig put the forearm capsules at local
   * z +0.42/+0.50, which after the group offset left them 0.10–0.20 m from the
   * lens — straddling the near plane, so they were clipped into a screen-filling
   * black mass. Every part below stays forward of the gun's rear face and the
   * arms run back toward the bottom corners of the frame.
   */
  buildHands() {
    const sleeve = new THREE.MeshStandardMaterial({
      color: '#3a5169', roughness: 0.82, metalness: 0.12, emissive: '#10222f', emissiveIntensity: 0.85,
    });
    const glove = new THREE.MeshStandardMaterial({
      color: '#243141', roughness: 0.62, metalness: 0.28, emissive: '#0b2532', emissiveIntensity: 0.9,
    });
    const seam = new THREE.MeshStandardMaterial({
      color: '#4a7891', roughness: 0.4, metalness: 0.55, emissive: '#123a4a', emissiveIntensity: 1,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: '#2b6b84', roughness: 0.35, metalness: 0.6, emissive: '#1e8fb0', emissiveIntensity: 1.2,
    });
    this.materials.push(sleeve, glove, seam, accent);

    const armGeometry = new THREE.CapsuleGeometry(0.055, 0.34, 4, 10);
    const palmGeometry = new THREE.SphereGeometry(0.062, 12, 10);
    const fingerGeometry = new THREE.CapsuleGeometry(0.016, 0.075, 2, 6);
    const cuffGeometry = new THREE.CylinderGeometry(0.062, 0.056, 0.08, 10);
    const thumbGeometry = new THREE.CapsuleGeometry(0.017, 0.055, 2, 6);
    const knuckleGeometry = new THREE.BoxGeometry(0.05, 0.012, 0.05);
    this.geometries.push(armGeometry, palmGeometry, fingerGeometry, cuffGeometry, thumbGeometry, knuckleGeometry);

    // Forearms enter from the bottom corners and converge on the grip. Their
    // rear ends sit at z ≈ +0.2 in viewmodel space, i.e. ~0.45 m from the eye.
    this.leftArm = part(armGeometry, sleeve, this.handRig, [-0.16, -0.30, 0.06], [0.45, 0, -0.42]);
    this.rightArm = part(armGeometry, sleeve, this.handRig, [0.17, -0.28, 0.10], [0.4, 0, 0.4]);
    this.leftCuff = part(cuffGeometry, seam, this.handRig, [-0.115, -0.19, -0.02], [0.35, 0, -0.4]);
    this.rightCuff = part(cuffGeometry, seam, this.handRig, [0.125, -0.175, 0.035], [0.32, 0, 0.4]);

    // Trigger hand on the grip, support hand on the handguard.
    this.rightPalm = part(palmGeometry, glove, this.handRig, [0.085, -0.075, 0.115], [0.25, 0, 0], [1, 0.85, 0.95]);
    this.leftPalm = part(palmGeometry, glove, this.handRig, [-0.085, -0.085, -0.145], [0.25, 0, 0], [1.05, 0.8, 0.9]);

    this.fingers = [];
    for (let finger = 0; finger < 4; finger += 1) {
      const offset = (finger - 1.5) * 0.024;
      this.fingers.push(part(fingerGeometry, glove, this.handRig,
        [0.055 + offset * 0.4, -0.055, 0.075 - offset], [0.9, 0, 0.15]));
      this.fingers.push(part(fingerGeometry, glove, this.handRig,
        [-0.055 + offset * 0.4, -0.045, -0.185 - offset], [1.1, 0, -0.15]));
    }
    this.leftThumb = part(thumbGeometry, glove, this.handRig, [-0.115, -0.065, -0.13], [0.5, 0, -0.9]);
    this.rightThumb = part(thumbGeometry, glove, this.handRig, [0.045, -0.07, 0.15], [0.4, 0, 0.9]);

    // Cyan knuckle plates: a readable accent that separates glove from weapon.
    this.knuckles = [
      part(knuckleGeometry, accent, this.handRig, [0.075, -0.028, 0.075], [0.9, 0, 0.15]),
      part(knuckleGeometry, accent, this.handRig, [-0.075, -0.03, -0.19], [1.1, 0, -0.15]),
    ];
  }

  buildFlash() {
    this.muzzle = new THREE.Object3D();
    this.viewModel.add(this.muzzle);
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

  /**
   * Dedicated viewmodel lighting.
   *
   * The hands and gun are lit by their own small rig parented to the camera, so
   * they keep their form and highlights on a dark map and never read as a flat
   * black shape. Short range keeps it from flattening the arena itself.
   */
  buildViewModelLight() {
    this.viewModelLight = new THREE.Group();
    this.viewModelLight.position.set(0.18, 0.22, -0.12);

    const key = new THREE.PointLight('#dff2ff', 3.4, 2.6, 2);
    key.position.set(0.1, 0.18, 0.35);
    const rim = new THREE.PointLight('#4fd8ff', 1.6, 2.2, 2);
    rim.position.set(-0.35, -0.1, -0.6);
    this.viewModelLight.add(key, rim);
    this.camera.add(this.viewModelLight);
    this.lights = [key, rim];
  }

  /** Pull the viewmodel closer for short guns and push long guns forward. */
  layoutForWeapon(weaponId) {
    const length = this.modelLibrary.getLength(weaponId);
    const weaponClass = WEAPON_CLASS[weaponId] ?? 'light';
    // Bulky weapons sit lower and further out; sidearms sit tighter and higher.
    const profile = WEAPON_PROFILES[weaponClass] ?? WEAPON_PROFILES.light;
    this.basePosition = {
      x: profile.x,
      y: profile.y,
      z: -0.42 - length * profile.reach,
    };
    // Hands ride with the grip; the support hand only reaches as far as the
    // handguard, which is why short weapons tuck it back.
    this.handRig.position.set(profile.handX, profile.handY, Math.min(0.12, length * 0.1));
    this.handRig.scale.setScalar(profile.handScale);
    if (this.leftPalm) {
      this.leftPalm.position.z = -Math.min(0.24, length * 0.34);
    }
    this.updateMuzzlePosition();
  }

  /**
   * Reset transient presentation (reload dip, recoil, switch animation).
   * Called on respawn so a player never comes back mid-reload or mid-swap.
   */
  resetPresentation() {
    this.reloadStartedAt = null;
    this.recoil = 0;
    this.meleeStartedAt = null;
    this.blockingTarget = false;
    this.blockingAmount = 0;
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
    if (this.basePosition) this.viewModel.position.set(this.basePosition.x, this.basePosition.y, this.basePosition.z);
  }

  /**
   * Show or hide the whole first-person rig (gun + hands + its light).
   * Kept as one switch so hands can never float in the menu or over the
   * scoreboard while the weapon is hidden.
   */
  setVisible(visible) {
    const on = Boolean(visible);
    this.viewModel.visible = on;
    if (this.viewModelLight) this.viewModelLight.visible = on;
    if (!on) {
      this.flashMesh.visible = false;
      this.flashLight.visible = false;
    }
  }

  setWeapon(weaponId, bundleId = this.bundleId, animate = true) {
    if (!weaponId) return;
    const changed = weaponId !== this.weaponId;
    const bundleChanged = bundleId && bundleId !== this.bundleId;
    if (!changed && !bundleChanged) return;
    this.weaponId = weaponId;
    if (bundleId) this.bundleId = bundleId;
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
      // Never show the previous weapon under the newly selected HUD label.
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
          copy.transparent = true; // draw after the world's transparent objects
          this.viewMaterialCache.set(source, copy);
        }
        return this.viewMaterialCache.get(source);
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(overlayMaterial)
        : overlayMaterial(object.material);
    });
    this.viewModel.add(next);
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

  // Cosmetic feedback is allowed before the server confirms the shot. It never
  // creates a hit marker, damage or explosion; accepted events carry those.
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
      this.recoil = Math.min(1.4, this.recoil + (weaponId === 'SHOTGUN' || weaponId === 'SNIPER' || weaponId === 'RAILGUN' ? 0.9 : 0.45));
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
    const bob = Math.sin(now * 0.011) * 0.013 * moving;
    const sway = Math.cos(now * 0.0055) * 0.007 * moving;
    const reloadProgress = this.reloadStartedAt === null
      ? 0
      : Math.max(0, Math.min(1, (now - this.reloadStartedAt) / this.reloadDuration));
    if (reloadProgress >= 1) this.reloadStartedAt = null;
    const reloadDip = this.reloadStartedAt === null ? 0 : Math.sin(reloadProgress * Math.PI) * 0.13;

    this.recoil = Math.max(0, this.recoil - RECOIL_DECAY_PER_SECOND * delta);

    const base = this.basePosition ?? { x: 0.26, y: -0.22, z: -0.62 };
    const aim = this.aimProfile?.offset ?? [base.x, base.y, base.z];
    const amount = this.aimAmount;
    this.blockingAmount += ((this.blockingTarget ? 1 : 0) - this.blockingAmount) * (1 - Math.exp(-12 * delta));
    const meleeProgress = this.meleeStartedAt === null ? 1 : (now - this.meleeStartedAt) / 260;
    const swing = meleeProgress >= 0 && meleeProgress < 1 ? Math.sin(meleeProgress * Math.PI) : 0;
    if (meleeProgress >= 1) this.meleeStartedAt = null;
    this.viewModel.position.x = base.x + (aim[0] - base.x) * amount + sway * (1 - amount * 0.85) - this.recoil * 0.004 - this.blockingAmount * 0.07 + swing * 0.05;
    this.viewModel.position.y = base.y + (aim[1] - base.y) * amount + bob * (1 - amount * 0.85) - reloadDip + this.recoil * 0.012 + this.blockingAmount * 0.10;
    this.viewModel.position.z = base.z + (aim[2] - base.z) * amount + reloadDip * 0.5 + this.recoil * 0.05 - swing * 0.12;
    this.viewModel.rotation.z = Math.sin(now * 0.0055) * 0.015 * moving * (1 - amount) - swing * 0.35;
    this.viewModel.rotation.x = -0.015 * (1 - amount) + reloadDip * 0.55 - this.recoil * 0.06 + swing * 0.5;
    this.viewModel.rotation.y = -0.035 * (1 - amount);

    if (this.switchTransition) {
      const { from, to, startedAt } = this.switchTransition;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / SWITCH_DURATION_MS));
      if (from) {
        from.position.y = -progress * 0.18;
        from.rotation.x = -progress * 0.14;
        from.scale.copy(from.userData.baseScale ?? from.scale).multiplyScalar(1 - progress * 0.1);
      }
      to.position.y = (1 - progress) * 0.18;
      to.rotation.x = (1 - progress) * 0.14;
      to.scale.copy(to.userData.baseScale ?? to.scale).multiplyScalar(0.9 + progress * 0.1);
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
