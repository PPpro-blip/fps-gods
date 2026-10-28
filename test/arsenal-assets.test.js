import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { orientModel, WeaponEffects } from '../client/weapons.js';
import { ADS_PROFILES } from '../client/aim.js';
import { WEAPON_MODEL_FILE, WEAPON_MODEL_LENGTH } from '../shared/weaponModels.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'public/assets/weapons');
const files = ['LowPolyShieldPack.glb', 'Military knife.glb', 'rocket_launcher_low.gltf'];

function metadata(file, bytes) {
  if (file.endsWith('.gltf')) return JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}

test('the uploaded models have complete local or embedded GLTF dependencies', () => {
  for (const file of files) {
    const bytes = readFileSync(resolve(dir, file));
    const json = metadata(file, bytes);
    assert.equal(json.asset.version, '2.0');
    assert.ok(json.meshes?.length > 0, `${file} has meshes`);
    assert.ok(json.materials?.length > 0, `${file} has materials`);
    for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (!resource.uri || resource.uri.startsWith('data:')) continue;
      assert.equal(existsSync(resolve(dir, decodeURIComponent(resource.uri))), true, `${file} missing ${resource.uri}`);
    }
    if (file === 'rocket_launcher_low.gltf') {
      assert.equal(json.buffers.filter((entry) => entry.uri?.startsWith('data:')).length, json.buffers.length);
      assert.ok(json.images.every((entry) => entry.uri?.startsWith('data:')));
    }
    if (file === 'Military knife.glb') assert.equal(json.asset.copyright, 'CC0');
  }
});

test('GLTFLoader parses real uploaded meshes, textures, selected shield and bounded first-person models', async () => {
  // Node lacks browser image decoding. The loader still fetches the real image
  // bytes; the stub validates their signatures, while actual GPU/image decoding
  // remains a browser check.
  const previous = { self: globalThis.self, createImageBitmap: globalThis.createImageBitmap, ProgressEvent: globalThis.ProgressEvent };
  const decodedImages = [];
  globalThis.self = globalThis;
  globalThis.ProgressEvent = class ProgressEvent { constructor(type, data) { this.type = type; Object.assign(this, data); } };
  globalThis.createImageBitmap = async (blob) => {
    const bytes = Buffer.from(await blob.arrayBuffer());
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    assert.ok(png || jpeg, 'embedded image must be PNG or JPEG data');
    decodedImages.push(bytes.length);
    return { width: 1, height: 1, close() {} };
  };
  try {
    const parsed = new Map();
    for (const file of files) {
      const bytes = readFileSync(resolve(dir, file));
      const data = file.endsWith('.gltf') ? bytes.toString('utf8') : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf = await new Promise((resolvePromise, reject) => new GLTFLoader().parse(data, '', resolvePromise, reject));
      let meshCount = 0;
      gltf.scene.traverse((node) => { if (node.isMesh && node.geometry && node.material) meshCount += 1; });
      assert.ok(meshCount > 0, `${file} contains usable meshes`);
      const model = orientModel(gltf.scene, file);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const fittedDimension = file === 'LowPolyShieldPack.glb' ? size.y : size.z;
      assert.ok(Math.abs(fittedDimension - WEAPON_MODEL_LENGTH[file]) < 0.001, `${file} is normalized on its actual long axis`);
      if (file === 'LowPolyShieldPack.glb') {
        let selectedMeshes = 0;
        model.traverse((node) => { if (node.isMesh) selectedMeshes += 1; });
        assert.ok(selectedMeshes > 0 && selectedMeshes < meshCount, 'only one shield is selected from the pack');
        assert.ok(size.x < 0.5 && size.z < 0.15, 'shield is upright and camera-facing');
      }
      parsed.set(file, model);
    }
    assert.ok(decodedImages.length >= 4, 'embedded knife, shield and launcher textures were fetched');
    for (const file of ['smg.glb', 'shotgun.glb', 'sniper.glb', 'pistol.glb', 'lmg.glb']) {
      const bytes = readFileSync(resolve(root, 'client/assets/weapons', file));
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf = await new Promise((resolvePromise, reject) => new GLTFLoader().parse(data, '', resolvePromise, reject));
      parsed.set(file, orientModel(gltf.scene, file));
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 125);
    scene.add(camera);
    const library = {
      onReady() {},
      getLength(id) { return WEAPON_MODEL_LENGTH[WEAPON_MODEL_FILE[id]] ?? 0.7; },
      createModel(id) {
        const source = parsed.get(WEAPON_MODEL_FILE[id]);
        if (!source) return null;
        const model = source.clone(true);
        model.userData.weaponId = id;
        return model;
      },
    };
    const effects = new WeaponEffects(scene, camera, library);
    for (const id of ['KNIFE', 'ROCKET', 'COMBAT_SHIELD']) {
      effects.setWeapon(id, id === 'KNIFE' ? 'RUSHER' : 'HEAVY', false);
      effects.update(performance.now(), 0.016);
      camera.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(effects.currentModel);
      assert.ok(bounds.max.z < -0.1, `${id} is in front of the near plane`);
      assert.ok(bounds.min.x > 0, `${id} stays to the side of the crosshair at hip`);
      assert.ok(bounds.max.y < 0.04, `${id} does not dominate the top of the screen`);
      assert.ok(bounds.getSize(new THREE.Vector3()).length() < 1.4, `${id} has a sane scale`);
    }
    // At full ADS the top of each real, centered model aligns with the reticle
    // instead of its body covering the target. This also covers the RPG sight.
    for (const [id, profile] of Object.entries(ADS_PROFILES)) {
      effects.setWeapon(id, 'HEAVY', false);
      effects.setAim(1, profile);
      effects.update(performance.now(), 0.016);
      camera.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(effects.currentModel);
      assert.ok(Math.abs(bounds.max.y) < 0.025, `${id} sight height is not aligned: ${bounds.max.y}`);
      assert.ok(Math.abs((bounds.min.x + bounds.max.x) / 2) < 0.025, `${id} sight is off-center`);
    }
    effects.dispose();
  } finally {
    if (previous.self === undefined) delete globalThis.self; else globalThis.self = previous.self;
    if (previous.createImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous.createImageBitmap;
    if (previous.ProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previous.ProgressEvent;
  }
});
