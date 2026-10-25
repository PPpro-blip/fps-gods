import * as THREE from 'three';
import { BUNDLE_BY_ID, DEFAULT_BUNDLE_ID } from '../shared/bundles.js';
import { createOperator } from './operator.js';

// The 3D backdrop behind every menu screen.
//
// It lives in its own THREE.Scene, separate from the arena scene, so menu props
// can never drift into gameplay and arena cover can never poke through the
// lobby. The room is assembled from the real environment kit in
// `/assets/map/arena_map.glb` (`Wall_*` modules are 4.00 m x 4.43 m,
// `FloorTile_Double` is 4.00 m x 2.00 m), and the operator is the real rigged
// character holding the equipped bundle's primary weapon.
//
// There are no fake "other players": the stage shows the local operator plus the
// three weapons of the selected bundle on lit display plinths.

const FLOOR_MODULE = 'FloorTile_Double';
const BACK_WALL_MODULES = ['Wall_1', 'Window_Wall_SideA', 'Wall_2', 'Wall_3'];
const SIDE_WALL_MODULE = 'Wall_4';
const COLUMN_MODULE = 'Column_3';
const CEILING_MODULE = 'RoofTile_Details';

// Kit dimensions, measured from the shipped GLB bounding boxes.
const MODULE_WIDTH = 4;
const MODULE_HEIGHT = 4.43;
const FLOOR_MODULE_DEPTH = 2;
const BIOME_END_Z = -9;

const PROPS = [
  { name: 'Props_Crate', position: [-6.2, 0, -7.4], rotation: 0.22 },
  { name: 'Props_Crate', position: [-5.4, 0, -7.9], rotation: -0.35, scale: 0.8 },
  { name: 'Props_CrateLong', position: [-6.0, 0.81, -7.4], rotation: 0.5, scale: 0.9 },
  { name: 'Props_ContainerFull', position: [6.4, 0, -7.6], rotation: 0.16 },
  { name: 'Props_Pod', position: [-8.4, 0, -2.2], rotation: 0.4 },
  { name: 'Props_Statue', position: [8.3, 0, -3.4], rotation: -0.5 },
  { name: 'Props_Computer', position: [4.6, 0, -8.0], rotation: 0.12 },
  { name: 'Props_Shelf', position: [8.2, 0, -6.4], rotation: -Math.PI / 2 },
  { name: 'Props_Vessel_Tall', position: [5.7, 0, -7.6], rotation: 0 },
  { name: 'Props_Vessel', position: [5.2, 0, -7.7], rotation: 0 },
];

const OPERATOR_Z = -2.6;
const STAND_Z = -6.2;
const STAND_X = [-3.2, 0, 3.2];
const CAMERA_POSITION = new THREE.Vector3(0, 1.58, 4.9);
const CAMERA_TARGET = new THREE.Vector3(0, 1.02, OPERATOR_Z - 0.6);

export class MenuStage {
  constructor(assetManager, { weaponModels = null } = {}) {
    this.assetManager = assetManager;
    this.weaponModels = weaponModels;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#05080c');
    this.scene.fog = new THREE.FogExp2('#05080c', 0.026);

    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 90);
    this.camera.position.copy(CAMERA_POSITION);
    this.camera.lookAt(CAMERA_TARGET);

    this.root = new THREE.Group();
    this.root.name = 'menu-stage';
    this.scene.add(this.root);

    this.operator = null;
    this.weaponStands = [];
    this.standModels = new Map();
    this.ownedGeometry = [];
    this.ownedMaterials = [];
    this.ownedLights = [];
    this.built = false;
    this.visible = false;
    this.elapsed = 0;
    this.bundleId = DEFAULT_BUNDLE_ID;
    this.accentColor = new THREE.Color('#39e6ff');
    this.pointer = { x: 0, y: 0 };
  }

  /** Register geometries/materials for disposal; returns nothing. */
  own(...resources) {
    for (const resource of resources) {
      if (!resource) continue;
      if (resource.isMaterial) this.ownedMaterials.push(resource);
      else this.ownedGeometry.push(resource);
    }
  }

  /** Idempotent: safe to call again once a late asset has arrived. */
  build() {
    if (this.built) return true;
    if (this.assetManager?.hasCharacter?.() !== true) return false;

    this.buildLighting();
    this.buildRoom();
    this.buildOperator();
    this.buildWeaponStands();
    this.applyBundle(this.bundleId, { immediate: true });
    this.built = true;
    return true;
  }

  buildLighting() {
    const hemisphere = new THREE.HemisphereLight('#93b8d6', '#070c12', 0.9);
    const key = new THREE.DirectionalLight('#dcefff', 1.35);
    key.position.set(4.2, 8.5, 6.5);
    const rim = new THREE.DirectionalLight(this.accentColor, 1.1);
    rim.position.set(-5.5, 3.4, -7.5);
    const fill = new THREE.PointLight('#9ec6ff', 8, 18, 2);
    fill.position.set(0, 2.6, 3.4);
    const warm = new THREE.PointLight('#ff9b52', 12, 16, 2);
    warm.position.set(6.4, 2.2, -5.4);
    const cool = new THREE.PointLight('#22d3ee', 14, 17, 2);
    cool.position.set(-6.2, 2.6, -5.8);

    this.rimLight = rim;
    for (const light of [hemisphere, key, rim, fill, warm, cool]) this.root.add(light);
    this.root.add(new THREE.AmbientLight('#1a2632', 0.55));
  }

  buildRoom() {
    const kit = this.assetManager?.kitReady === true;
    const floor = new THREE.Group();
    floor.name = 'stage-floor';
    this.root.add(floor);

    if (kit) {
      // 8 m either side of the operator, from the back wall to the camera.
      const columns = 4;
      const rows = 7;
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const tile = this.assetManager.createKitModule(FLOOR_MODULE);
          if (!tile) continue;
          tile.position.set(-6 + column * MODULE_WIDTH, 0, BIOME_END_Z + row * FLOOR_MODULE_DEPTH);
          floor.add(tile);
        }
      }

      const backWall = new THREE.Group();
      backWall.name = 'stage-back-wall';
      backWall.position.set(0, 0, BIOME_END_Z - 0.3);
      BACK_WALL_MODULES.forEach((moduleName, index) => {
        const wall = this.assetManager.createKitModule(moduleName);
        if (!wall) return;
        wall.position.set(-6 + index * MODULE_WIDTH, 0, 0);
        backWall.add(wall);
      });
      this.root.add(backWall);

      const sideWalls = new THREE.Group();
      sideWalls.name = 'stage-side-walls';
      for (const side of [-1, 1]) {
        for (let index = 0; index < 4; index += 1) {
          const wall = this.assetManager.createKitModule(SIDE_WALL_MODULE);
          if (!wall) continue;
          wall.position.set(side * 8.3, 0, BIOME_END_Z + 0.4 + index * MODULE_WIDTH);
          wall.rotation.y = side * Math.PI / 2;
          sideWalls.add(wall);
        }
      }
      this.root.add(sideWalls);

      for (const [x, z] of [[-7.7, -8.2], [7.7, -8.2], [-7.7, -0.6], [7.7, -0.6]]) {
        const column = this.assetManager.createKitModule(COLUMN_MODULE);
        if (!column) continue;
        column.position.set(x, 0, z);
        column.rotation.y = Math.PI / 4;
        this.root.add(column);
      }

      // Ceiling only over the back half: the operator stays under open light,
      // while the weapon wall gets a covered, industrial backdrop.
      for (let column = 0; column < 5; column += 1) {
        for (let row = 0; row < 3; row += 1) {
          const tile = this.assetManager.createKitModule(CEILING_MODULE);
          if (!tile) continue;
          tile.position.set(-4 + column * 2, MODULE_HEIGHT - 0.4, BIOME_END_Z + 1 + row * 2);
          this.root.add(tile);
        }
      }

      for (const prop of PROPS) {
        const module = this.assetManager.createKitModule(prop.name);
        if (!module) continue;
        module.position.set(prop.position[0], prop.position[1], prop.position[2]);
        module.rotation.y = prop.rotation ?? 0;
        if (prop.scale) module.scale.setScalar(prop.scale);
        this.root.add(module);
      }
    } else {
      // The room must still read as a space if the kit fails to load.
      const geometry = new THREE.PlaneGeometry(20, 22);
      const material = new THREE.MeshStandardMaterial({ color: '#0a1017', roughness: 0.9, metalness: 0.1 });
      this.own(geometry, material);
      const plane = new THREE.Mesh(geometry, material);
      plane.rotation.x = -Math.PI / 2;
      plane.position.z = BIOME_END_Z / 2;
      floor.add(plane);
    }

    // Landing ring under the operator, tinted by the equipped bundle.
    const ringGeometry = new THREE.RingGeometry(0.62, 0.78, 64);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: this.accentColor,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    this.own(ringGeometry, ringMaterial);
    this.landingRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.position.set(0, 0.02, OPERATOR_Z);
    this.root.add(this.landingRing);

    // Back-wall light bars pick out the silhouette of the operator.
    const barGeometry = new THREE.BoxGeometry(0.06, 2.6, 0.06);
    const barMaterial = new THREE.MeshBasicMaterial({ color: '#1e7d92' });
    this.own(barGeometry, barMaterial);
    for (const x of [-5.6, -2.8, 2.8, 5.6]) {
      const bar = new THREE.Mesh(barGeometry, barMaterial);
      bar.position.set(x, 1.9, BIOME_END_Z + 0.2);
      this.root.add(bar);
    }
  }

  buildOperator() {
    const rig = this.assetManager.createCharacterRig();
    if (!rig) return;
    const bundle = BUNDLE_BY_ID[this.bundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    this.operator = createOperator(rig, { color: bundle?.accent ?? '#39e6ff' });
    this.operator.group.position.set(0, 0, OPERATOR_Z);
    // Gameplay operators face their yaw (yaw 0 = -Z); the menu camera sits at
    // +Z, so the stage turns the operator around to face the viewer.
    this.operator.group.rotation.y = Math.PI;
    this.root.add(this.operator.group);
    rig.setLocomotion(0);
    rig.update(0);
  }

  buildWeaponStands() {
    const plinthGeometry = new THREE.CylinderGeometry(0.3, 0.38, 0.86, 24);
    const ringGeometry = new THREE.TorusGeometry(0.34, 0.012, 8, 40);
    const plinthMaterial = new THREE.MeshStandardMaterial({
      color: '#101a22', roughness: 0.4, metalness: 0.65,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: this.accentColor, transparent: true, opacity: 0.8,
    });
    this.own(plinthGeometry, ringGeometry, plinthMaterial, ringMaterial);

    STAND_X.forEach((x, index) => {
      const group = new THREE.Group();
      group.position.set(x, 0, STAND_Z);
      const plinth = new THREE.Mesh(plinthGeometry, plinthMaterial);
      plinth.position.y = 0.43;
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.88;
      const mount = new THREE.Group();
      mount.position.y = 1.18;
      group.add(plinth, ring, mount);
      this.root.add(group);
      this.weaponStands.push({ group, mount, phase: index * 1.1, slot: index });
    });
  }

  /** Swap the displayed loadout. Cheap: models are clones of a shared cache. */
  applyBundle(bundleId, { immediate = false } = {}) {
    const bundle = BUNDLE_BY_ID[bundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    if (!bundle) return;
    this.bundleId = bundle.id;
    this.accentColor.set(bundle.accent ?? '#39e6ff');
    this.landingRing?.material.color.set(this.accentColor);
    if (this.rimLight) this.rimLight.color.set(this.accentColor);

    const primary = bundle.weapons?.[0]?.id ?? null;
    if (this.operator?.setWeapon && primary && this.weaponModels) {
      const model = this.weaponModels.createModel(primary);
      if (model) {
        model.rotation.set(0, Math.PI, 0);
        this.operator.setWeapon(model);
      }
    }

    this.weaponStands.forEach((stand, index) => {
      const weaponId = bundle.weapons?.[index]?.id ?? null;
      if (!weaponId || !this.weaponModels) {
        stand.group.visible = false;
        return;
      }
      const model = this.weaponModels.createModel(weaponId);
      if (!model) {
        stand.group.visible = false;
        return;
      }
      stand.group.visible = true;
      for (const child of [...stand.mount.children]) stand.mount.remove(child);
      // Weapon models are authored muzzle-toward -Z; turn them broadside so the
      // silhouette is readable from the camera.
      model.rotation.set(0, Math.PI / 2, 0);
      model.position.y = 0.12;
      stand.mount.add(model);
      stand.weaponId = weaponId;
      stand.appearedAt = immediate ? 0 : performance.now();
    });
  }

  setBundle(bundleId) {
    this.applyBundle(bundleId);
  }

  /** Mouse position in -1..1, used for a subtle camera parallax. */
  setPointer(x, y) {
    this.pointer.x = Math.max(-1, Math.min(1, Number(x) || 0));
    this.pointer.y = Math.max(-1, Math.min(1, Number(y) || 0));
  }

  resize(aspect) {
    const ratio = Number(aspect) > 0 ? Number(aspect) : 16 / 9;
    this.camera.aspect = Math.max(0.55, ratio);
    // Pull the lens wider on phones so the lineup still fits the frame.
    this.camera.fov = this.camera.aspect < 0.9 ? 58 : this.camera.aspect < 1.35 ? 48 : 42;
    this.camera.updateProjectionMatrix();
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  update(delta) {
    if (!this.visible) return;
    const step = Math.max(0, Math.min(0.1, Number(delta) || 0));
    this.elapsed += step;
    const time = this.elapsed;

    if (this.operator) {
      this.operator.rig.update(step);
      this.operator.rig.setLocomotion(0);
      this.operator.group.rotation.y = Math.PI + Math.sin(time * 0.28) * 0.16;
      this.operator.group.position.y = Math.sin(time * 1.1) * 0.004;
    }

    for (const stand of this.weaponStands) {
      if (!stand.group.visible) continue;
      stand.mount.rotation.y = time * 0.5 + stand.phase;
      stand.mount.position.y = 1.18 + Math.sin(time * 0.9 + stand.phase) * 0.018;
    }

    if (this.landingRing) {
      this.landingRing.material.opacity = 0.42 + Math.sin(time * 1.6) * 0.12;
    }
    if (this.rimLight) {
      this.rimLight.intensity = 1.0 + Math.sin(time * 0.7) * 0.18;
    }

    const drift = Math.sin(time * 0.14);
    this.camera.position.set(
      CAMERA_POSITION.x + drift * 0.28 + this.pointer.x * 0.34,
      CAMERA_POSITION.y + Math.sin(time * 0.23) * 0.015 - this.pointer.y * 0.14,
      CAMERA_POSITION.z,
    );
    this.camera.lookAt(
      CAMERA_TARGET.x + this.pointer.x * 0.22,
      CAMERA_TARGET.y + this.pointer.y * 0.1,
      CAMERA_TARGET.z,
    );
  }

  dispose() {
    this.operator?.dispose();
    this.operator = null;
    for (const stand of this.weaponStands) {
      for (const child of [...stand.mount.children]) stand.mount.remove(child);
      this.root.remove(stand.group);
    }
    this.weaponStands.length = 0;
    for (const geometry of this.ownedGeometry) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedGeometry.length = 0;
    this.ownedMaterials.length = 0;
    for (const child of [...this.root.children]) this.root.remove(child);
    this.built = false;
    this.visible = false;
  }
}
