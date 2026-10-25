import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { WeaponEffects } from '../client/weapons.js';
import { WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';

// A stand-in for WeaponModelLibrary: the real one needs Vite's asset pipeline,
// but the viewmodel maths is what has to be right, so lengths and simple boxes
// of the measured size are enough.
function createStubLibrary() {
  const lastOf = (weaponId) => Number(String(weaponId).length) / 10;
  const lengths = {
    SMG: 0.73, SHOTGUN: 0.84, SNIPER: 1.02, PISTOL: 0.58, LMG: 0.86,
    ROCKET: 0.66, KNIFE: 0.52, MINIGUN: 0.86, RAILGUN: 0.86,
    COMBAT_SHIELD: 0.84, SMOKE_GRENADE: 0.58, GOD_FIST: 0.52,
  };
  return {
    onReady: () => {},
    getLength: (weaponId) => lengths[weaponId] ?? 0.7,
    createModel(weaponId) {
      const length = lengths[weaponId] ?? 0.7;
      const group = new THREE.Group();
      group.userData.weaponId = weaponId;
      group.userData.length = length;
      group.add(new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.12, length),
        new THREE.MeshStandardMaterial({ color: '#2b3644' }),
      ));
      void lastOf;
      return group;
    },
  };
}

function setup() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 125);
  camera.position.set(0, 1.53, 0);
  scene.add(camera);
  const effects = new WeaponEffects(scene, camera, createStubLibrary());
  return { scene, camera, effects };
}

/** Bounding box of the viewmodel in camera space (z is negative in front). */
function viewModelBox(camera, root = camera) {
  camera.updateMatrixWorld(true);
  const inverse = camera.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.updateWorldMatrix(true, false);
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    const toCamera = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld);
    box.union(new THREE.Box3().copy(node.geometry.boundingBox).applyMatrix4(toCamera));
  });
  return box;
}

test('the first-person viewmodel sits in front of the near plane for every weapon', () => {
  const { camera, effects } = setup();
  try {
    const weapons = ['SMG', 'SHOTGUN', 'SNIPER', 'PISTOL', 'LMG', 'ROCKET', 'KNIFE', 'MINIGUN', 'RAILGUN'];
    assert.ok(weapons.length > 0);
    for (const weaponId of weapons) {
      effects.setWeapon(weaponId, 'RUSHER', false);
      for (let frame = 0; frame < 80; frame += 1) effects.update(performance.now() + frame * 16, 0.016);
      const box = viewModelBox(camera, effects.currentModel);
      assert.ok(box.min.z < -0.5, `${weaponId}: the weapon is not held out in front (${box.min.z.toFixed(2)})`);
      assert.ok(box.max.z < -0.2, `${weaponId}: the weapon crosses the near plane (${box.max.z.toFixed(2)})`);
      // Right-hand hold: the weapon sits right of centre and below the
      // crosshair, which is what makes it readable instead of hiding the target.
      assert.ok(box.min.x > 0.05, `${weaponId}: the weapon drifted off the right-hand side`);
      assert.ok(box.max.y < 0, `${weaponId}: the weapon covers the crosshair (${box.max.y.toFixed(2)})`);
      assert.ok(box.min.y > -0.8, `${weaponId}: the weapon sits off the bottom of the screen`);
      assert.ok(box.max.z - box.min.z < 1.6, `${weaponId}: the weapon is absurdly long in view`);
    }
  } finally {
    effects.dispose();
  }
});

test('the muzzle follows the weapon length and points down the barrel', () => {
  const { camera, effects } = setup();
  try {
    effects.setWeapon('SNIPER', 'GHOST', false);
    effects.update(performance.now(), 0.016);
    const muzzle = effects.muzzle.getWorldPosition(new THREE.Vector3());
    const cameraSpace = muzzle.clone().applyMatrix4(camera.matrixWorld.clone().invert());
    assert.ok(cameraSpace.z < -0.6, `muzzle must be well in front of the eye (${cameraSpace.z.toFixed(2)})`);

    effects.setWeapon('PISTOL', 'GHOST', false);
    effects.update(performance.now(), 0.016);
    const shortMuzzle = effects.muzzle.getWorldPosition(new THREE.Vector3())
      .applyMatrix4(camera.matrixWorld.clone().invert());
    assert.ok(
      shortMuzzle.z > cameraSpace.z,
      'a pistol must present its muzzle closer to the eye than a sniper rifle',
    );
  } finally {
    effects.dispose();
  }
});

test('firing produces a short-lived tracer and a muzzle flash that decay', () => {
  const { scene, effects } = setup();
  try {
    const baseline = scene.children.length;
    const now = performance.now();
    effects.fire(now, 'SMG', 'RUSHER');
    assert.equal(effects.tracers.length, 1, 'a hitscan shot draws one tracer');
    assert.equal(scene.children.length, baseline + 1);
    assert.equal(effects.flashMesh.visible, true, 'the muzzle flash lights up');

    effects.update(now + 30, 0.016);
    assert.equal(effects.flashMesh.visible, true, 'the flash lasts long enough to be seen');
    effects.update(now + 120, 0.016);
    assert.equal(effects.flashMesh.visible, false, 'the flash must not stick around');
    assert.equal(effects.tracers.length, 0, 'the tracer must expire');
    assert.equal(scene.children.length, baseline, 'expired tracers are removed from the scene');

    // Melee and utility weapons draw no tracer.
    effects.fire(now, 'KNIFE', 'RUSHER');
    effects.fire(now, 'COMBAT_SHIELD', 'HEAVY');
    assert.equal(effects.tracers.length, 0);

    // Recoil decays instead of accumulating.
    const recoil = effects.recoil;
    effects.update(now + 5_000, 1);
    assert.ok(effects.recoil < recoil);
  } finally {
    effects.dispose();
  }
});

test('remote tracers are drawn from the authoritative origin', () => {
  const { scene, effects } = setup();
  try {
    effects.showRemoteTracer({
      origin: { x: 3, y: 1.5, z: -4 },
      direction: { x: 1, y: 0, z: 0 },
      weaponId: 'SNIPER',
      bundleId: 'GHOST',
    });
    assert.equal(effects.tracers.length, 1);
    const points = effects.tracers[0].line.geometry.attributes.position;
    assert.equal(points.count, 2);
    assert.ok(Math.abs(points.getX(0) - 3) < 1e-5, 'the tracer must start where the server said it did');

    // A zero-length direction is rejected rather than producing a NaN line.
    effects.showRemoteTracer({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 }, weaponId: 'SNIPER' });
    assert.equal(effects.tracers.length, 1);
    assert.equal(scene.children.length, 1 + 1);
  } finally {
    effects.dispose();
  }
});

test('smoke clouds are created, moved, and disposed exactly once', () => {
  const { scene, effects } = setup();
  try {
    const clouds = [
      { id: 'smoke-1', x: 2, y: 0, z: -3, radius: 4 },
      { id: 'smoke-2', x: -6, y: 0, z: 8, radius: 5 },
    ];
    effects.updateSmokeClouds(clouds);
    assert.equal(effects.smokeMeshes.size, 2);

    effects.updateSmokeClouds([{ id: 'smoke-1', x: 4, y: 0, z: -3, radius: 4 }]);
    assert.equal(effects.smokeMeshes.size, 1, 'an expired cloud must be removed');
    const group = effects.smokeMeshes.get('smoke-1').group;
    assert.equal(group.position.x, 4, 'an existing cloud moves with the server');
    assert.ok(scene.children.includes(group));

    effects.updateSmokeClouds([]);
    assert.equal(effects.smokeMeshes.size, 0);
    assert.equal(scene.children.filter((child) => child.type === 'Group').length, 0);
  } finally {
    effects.dispose();
  }
});

test('dispose detaches the viewmodel and leaves nothing in the scene', () => {
  const { scene, camera, effects } = setup();
  const baseline = scene.children.length;
  effects.fire(performance.now(), 'LMG', 'HEAVY');
  effects.updateSmokeClouds([{ id: 'smoke', x: 0, y: 0, z: 0, radius: 3 }]);
  effects.dispose();
  assert.equal(camera.children.includes(effects.viewModel), false);
  assert.equal(scene.children.filter((child) => child.isLine).length, 0);
  assert.equal(effects.smokeMeshes.size, 0);
  assert.ok(scene.children.length <= baseline, 'the scene is back to its baseline');
});
