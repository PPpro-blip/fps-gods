import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CharacterRig, buildAnimationSet } from '../client/animation.js';
import { MenuStage } from '../client/MenuStage.js';
import { BONES, WEAPON_SOCKET_NAME, createOperator } from '../client/operator.js';
import { BUNDLE_BY_ID } from '../shared/bundles.js';
import { WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadGlb(relativePath) {
  const buffer = readFileSync(resolve(repoRoot, relativePath));
  return new Promise((resolvePromise, reject) => {
    new GLTFLoader().parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      '',
      resolvePromise,
      reject,
    );
  });
}

async function loadAssets() {
  const character = await loadGlb('public/assets/characters/character.glb');
  const map = await loadGlb('public/assets/map/arena_map.glb');
  const animationSet = buildAnimationSet(character.scene, character.animations);
  return { character, map, animationSet };
}

function createFakeAssetManager({ character, map, animationSet }) {
  const modules = new Map(map.scene.children.map((child) => [child.name, child]));
  return {
    hasCharacter: () => true,
    kitReady: modules.size > 0,
    animationSet,
    modules,
    createCharacterRig(options = {}) {
      return new CharacterRig(character.scene, animationSet, options);
    },
    createKitModule(name) {
      const source = modules.get(name);
      if (!source) return null;
      const clone = source.clone(true);
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.scale.set(1, 1, 1);
      return clone;
    },
  };
}

function createFakeWeaponModels() {
  const models = new Map();
  return {
    createModel(weaponId) {
      const key = Object.keys(WEAPON_MODEL_LENGTH).find((file) => file.startsWith(weaponId.slice(0, 3).toLowerCase()));
      const length = WEAPON_MODEL_LENGTH[key] ?? 0.7;
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.1, length),
        new THREE.MeshStandardMaterial({ color: '#2b3644' }),
      );
      group.add(mesh);
      models.set(weaponId, group);
      return group;
    },
    getLength(weaponId) {
      return WEAPON_MODEL_LENGTH[Object.keys(WEAPON_MODEL_LENGTH)[0]] ?? 0.7;
    },
    settled: true,
  };
}

const OPERATOR_BONES = [
  BONES.head, BONES.spine2, BONES.leftArm, BONES.rightArm,
  BONES.leftLeg, BONES.rightLeg, BONES.leftFoot, BONES.rightFoot,
];

test('the operator is dressed on the real bones and holds the weapon forward', async () => {
  const { character, animationSet } = await loadAssets();
  const rig = new CharacterRig(character.scene, animationSet);
  const operator = createOperator(rig, { color: '#59d8ff' });

  try {
    operator.group.updateMatrixWorld(true);

    // Gear must be parented to bones, not floating in world space.
    for (const boneName of OPERATOR_BONES) {
      const bone = rig.getBone(boneName);
      assert.ok(bone, `${boneName} must exist on the shipped rig`);
      assert.ok(bone.children.length > 0, `${boneName} has no gear attached`);
    }

    const socket = rig.getBone(BONES.rightHand)?.getObjectByName(WEAPON_SOCKET_NAME);
    assert.ok(socket, `the weapon socket must hang off ${BONES.rightHand}`);

    // A weapon parented to the socket points away from the operator's chest.
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.7));
    operator.setWeapon(weapon);
    operator.group.updateMatrixWorld(true);
    const muzzle = new THREE.Vector3(0, 0, -0.35).applyMatrix4(weapon.matrixWorld);
    const chest = new THREE.Vector3(0, 1.33, 0).applyMatrix4(operator.group.matrixWorld);
    assert.ok(muzzle.z < chest.z, 'the muzzle must sit in front of the chest');

    // The model itself faces +Z; gameplay yaw 0 looks down -Z, so the body is
    // flipped inside the wrapper and the wrapper carries the yaw.
    const modelFacing = new THREE.Vector3(0, 0, 1).transformDirection(operator.body.matrixWorld);
    assert.ok(modelFacing.z < -0.9, 'the flipped body must face the wrapper\'s -Z');
    operator.group.rotation.y = Math.PI;
    operator.group.updateMatrixWorld(true);
    const facingCamera = new THREE.Vector3(0, 0, 1).transformDirection(operator.body.matrixWorld);
    assert.ok(facingCamera.z > 0.9, `a yawed operator must face the camera, faces ${facingCamera.z.toFixed(2)}`);

    // Gear has to sit on the body: from the boots to the helmet, never at 0.
    const gear = new THREE.Box3();
    for (const boneName of OPERATOR_BONES) {
      for (const child of rig.getBone(boneName).children) {
        if (!child.isMesh) continue;
        gear.expandByObject(child);
      }
    }
    assert.ok(gear.min.y > -0.2 && gear.max.y > 1.5, `gear volume looks wrong: ${gear.min.y}..${gear.max.y}`);
  } finally {
    operator.dispose();
  }
});

test('the menu stage assembles a real kit room and frames the operator', async () => {
  const assets = await loadAssets();
  const assetManager = createFakeAssetManager(assets);
  const weaponModels = createFakeWeaponModels();
  const stage = new MenuStage(assetManager, { weaponModels });

  try {
    assert.equal(stage.build(), true, 'the stage must build with the shipped assets');
    assert.equal(stage.build(), true, 'build() must be idempotent');

    const floorTiles = stage.root.getObjectByName('stage-floor').children.length;
    assert.ok(floorTiles >= 20, `expected a tiled floor, found ${floorTiles} modules`);
    assert.ok(stage.root.getObjectByName('stage-back-wall').children.length >= 3);
    assert.ok(stage.root.getObjectByName('stage-side-walls').children.length >= 6);

    assert.ok(stage.operator, 'the stage must hold the real operator');
    stage.root.updateMatrixWorld(true);

    // The operator stands on the floor, at full height, inside the camera frame.
    const bounds = new THREE.Box3().setFromObject(stage.operator.group);
    assert.ok(Math.abs(bounds.min.y) < 0.08, `feet must touch the floor, got ${bounds.min.y.toFixed(3)}`);
    assert.ok(bounds.max.y > 1.7 && bounds.max.y < 2.1, `unexpected operator height ${bounds.max.y.toFixed(2)}`);

    stage.visible = true;
    stage.update(1 / 60);
    stage.camera.updateMatrixWorld(true);
    stage.camera.updateProjectionMatrix();
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const x of [bounds.min.x, bounds.max.x]) {
        const projected = new THREE.Vector3(x, y, stage.operator.group.position.z).project(stage.camera);
        assert.ok(Math.abs(projected.x) < 0.95, `operator leaves the frame horizontally (${projected.x.toFixed(2)})`);
        assert.ok(Math.abs(projected.y) < 0.95, `operator leaves the frame vertically (${projected.y.toFixed(2)})`);
        assert.ok(projected.z > -1 && projected.z < 1, 'operator must be between the near and far planes');
      }
    }

    // Three weapon plinths, each carrying the bundle's weapon.
    assert.equal(stage.weaponStands.length, 3);
    for (const stand of stage.weaponStands) {
      assert.equal(stand.group.visible, true);
      assert.equal(stand.mount.children.length, 1, 'each plinth shows exactly one weapon');
    }

    // The primary weapon is in the operator's hand.
    const socket = stage.operator.rig.getBone(BONES.rightHand).getObjectByName(WEAPON_SOCKET_NAME);
    assert.equal(socket.children.length, 1, 'the operator must hold the primary weapon');

    // A bundle change swaps the loadout without leaking mounts.
    stage.setBundle('HEAVY');
    assert.equal(stage.bundleId, 'HEAVY');
    for (const stand of stage.weaponStands) assert.equal(stand.mount.children.length, 1);
    assert.equal(stage.landingRing.material.color.getHexString(), BUNDLE_BY_ID.HEAVY.accent.replace('#', ''));

    // Animation and drift must never produce NaN transforms.
    for (let frame = 0; frame < 40; frame += 1) stage.update(1 / 60);
    for (const value of stage.camera.position.toArray()) assert.ok(Number.isFinite(value));
    assert.ok(Number.isFinite(stage.operator.group.rotation.y));
    const posed = new THREE.Box3().setFromObject(stage.operator.group);
    assert.ok(Number.isFinite(posed.max.y) && posed.max.y > 1.5, 'the operator must keep a valid pose');
  } finally {
    stage.dispose();
  }
  assert.equal(stage.root.children.length, 0, 'dispose must empty the stage');
});

test('the menu stage refuses to build without the character asset', () => {
  const stage = new MenuStage({ hasCharacter: () => false, kitReady: false }, {});
  assert.equal(stage.build(), false);
  assert.equal(stage.operator, null);
  stage.dispose();
});
