import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const characterGlbPath = resolve(repoRoot, 'public/assets/characters/character.glb');
const animationGlbPath = resolve(repoRoot, 'public/assets/animations/animations.glb');

test('character GLB is valid and contains skinned meshes with humanoid skeleton bones', async () => {
  assert.ok(existsSync(characterGlbPath), 'character.glb must exist');
  const buffer = readFileSync(characterGlbPath);
  const loader = new GLTFLoader();

  const gltf = await new Promise((resolvePromise, reject) => {
    loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '', resolvePromise, reject);
  });

  assert.ok(gltf.scene, 'GLTF scene must be present');
  let skinnedMeshCount = 0;
  let boneCount = 0;
  let hasRightHand = false;

  gltf.scene.traverse((node) => {
    if (node.isSkinnedMesh) skinnedMeshCount++;
    if (node.isBone) {
      boneCount++;
      if (node.name.includes('RightHand')) hasRightHand = true;
    }
  });

  assert.ok(skinnedMeshCount > 0, `Expected skinned meshes, found ${skinnedMeshCount}`);
  assert.ok(boneCount > 10, `Expected humanoid skeleton bones, found ${boneCount}`);
  assert.ok(hasRightHand, 'Expected mixamorigRightHand bone for weapon attachment');
});

test('animations GLB contains humanoid animation clips and attaches to AnimationMixer', async () => {
  assert.ok(existsSync(animationGlbPath), 'animations.glb must exist');
  const animBuffer = readFileSync(animationGlbPath);
  const charBuffer = readFileSync(characterGlbPath);
  const loader = new GLTFLoader();

  const animGltf = await new Promise((res, rej) => {
    loader.parse(animBuffer.buffer.slice(animBuffer.byteOffset, animBuffer.byteOffset + animBuffer.byteLength), '', res, rej);
  });
  const charGltf = await new Promise((res, rej) => {
    loader.parse(charBuffer.buffer.slice(charBuffer.byteOffset, charBuffer.byteOffset + charBuffer.byteLength), '', res, rej);
  });

  assert.ok(animGltf.animations?.length > 0, 'Animation clips must be present');
  const mixer = new THREE.AnimationMixer(charGltf.scene);
  const clip = animGltf.animations[0];
  const action = mixer.clipAction(clip);
  assert.ok(action, 'Clip action must be created');
  action.play();

  // Test mixer update advances without errors
  mixer.update(0.016);
  assert.equal(action.isRunning(), true, 'Animation action must be running');
});

test('SkeletonUtils.clone correctly binds cloned SkinnedMesh to cloned skeleton', async () => {
  const charBuffer = readFileSync(characterGlbPath);
  const loader = new GLTFLoader();
  const charGltf = await new Promise((res, rej) => {
    loader.parse(charBuffer.buffer.slice(charBuffer.byteOffset, charBuffer.byteOffset + charBuffer.byteLength), '', res, rej);
  });

  const originalMesh = charGltf.scene;
  const clone = SkeletonUtils.clone(originalMesh);

  let cloneSkinnedMesh = null;
  clone.traverse((node) => {
    if (node.isSkinnedMesh) cloneSkinnedMesh = node;
  });

  assert.ok(cloneSkinnedMesh, 'Cloned hierarchy must have SkinnedMesh');
  assert.ok(cloneSkinnedMesh.skeleton, 'Cloned SkinnedMesh must have skeleton');

  // Check that cloned skeleton bones belong to the cloned hierarchy
  const firstClonedBone = cloneSkinnedMesh.skeleton.bones[0];
  assert.ok(firstClonedBone, 'Cloned skeleton must have bones');

  let foundInClone = false;
  clone.traverse((node) => {
    if (node === firstClonedBone) foundInClone = true;
  });
  assert.ok(foundInClone, 'Cloned skeleton bones must belong to the cloned hierarchy');
});

test('all weapon GLBs have non-zero geometry volume and compute bounds correctly', async () => {
  const weapons = ['smg', 'shotgun', 'sniper', 'pistol', 'lmg', 'rocket', 'knife', 'rifle'];
  const loader = new GLTFLoader();

  for (const weapon of weapons) {
    const weaponPath = resolve(repoRoot, `public/assets/weapons/${weapon}.glb`);
    assert.ok(existsSync(weaponPath), `${weapon}.glb must exist in public/assets/weapons/`);

    const buf = readFileSync(weaponPath);
    const gltf = await new Promise((res, rej) => {
      loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej);
    });

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    assert.ok(size.length() > 0.01, `Weapon ${weapon} must have non-zero size`);
  }
});
