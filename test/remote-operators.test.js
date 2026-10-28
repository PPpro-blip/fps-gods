import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { JSDOM } from 'jsdom';
import { ANIMATION_STATES, CharacterRig, buildAnimationSet } from '../client/animation.js';
import { RemotePlayers } from '../client/player.js';
import { BONES, WEAPON_SOCKET_NAME } from '../client/operator.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The seam this covers is the one no single-module test can reach: a server
// snapshot goes into RemotePlayers, which builds a real rigged operator out of
// character.glb, dresses it, sockets a weapon, animates it, and disposes it when
// the operator leaves. Everything here runs headless in Node.

async function loadCharacterRigFactory() {
  const buffer = readFileSync(resolve(repoRoot, 'public/assets/characters/character.glb'));
  const gltf = await new Promise((resolvePromise, reject) => {
    new GLTFLoader().parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      '',
      resolvePromise,
      reject,
    );
  });
  const animationSet = buildAnimationSet(gltf.scene, gltf.animations);
  return () => new CharacterRig(gltf.scene, animationSet, { tint: '#59d8ff' });
}

// Stands in for WeaponModelLibrary, which needs Vite's `?url` imports.
function createWeaponStub() {
  const listeners = new Set();
  return {
    settled: true,
    onReady(listener) {
      listener();
      return () => listeners.delete(listener);
    },
    createModel(weaponId) {
      const model = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.6),
        new THREE.MeshStandardMaterial(),
      );
      mesh.name = `stub-${weaponId}`;
      model.add(mesh);
      model.userData.weaponId = weaponId;
      model.userData.length = 0.73;
      return model;
    },
    getLength() {
      return 0.73;
    },
  };
}

function createScene() {
  const dom = new JSDOM('<!doctype html><div id="name-tags"></div>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(77, 16 / 9, 0.05, 125);
  camera.position.set(0, 1.6, 8);
  camera.updateMatrixWorld(true);
  return { dom, scene, camera, nameTagRoot: dom.window.document.getElementById('name-tags') };
}

const PLAYERS = [
  { id: 'me', name: 'Me', x: 0, y: 0, z: 0, yaw: 0, alive: true, connected: true, currentWeaponId: 'SMG', color: '#59d8ff' },
  { id: 'p1', name: 'Vega', x: -3, y: 0, z: -2, yaw: 0.5, alive: true, connected: true, currentWeaponId: 'SNIPER', currentWeaponName: 'Sniper', color: '#c18aff', vx: 1.5, vz: 0 },
  { id: 'p2', name: 'Rook', x: 2, y: 0, z: -4, yaw: -0.8, alive: true, connected: true, currentWeaponId: 'LMG', currentWeaponName: 'LMG', color: '#ff8b3d', vx: 5.2, vz: 0 },
];

test('server snapshots drive real operators, weapons, animations and disposal', async () => {
  const createRig = await loadCharacterRigFactory();
  const { dom, scene, camera, nameTagRoot } = createScene();
  const weaponModels = createWeaponStub();
  const assetManager = { createCharacterRig: createRig };
  const players = new RemotePlayers(scene, nameTagRoot, weaponModels, assetManager);
  const interpolator = { sample: () => null };

  try {
    players.update(PLAYERS, interpolator, camera, performance.now(), 'me');

    // The local player is never duplicated in the world.
    assert.equal(players.players.size, 2);
    assert.ok(!players.players.has('me'));

    const vega = players.players.get('p1');
    assert.ok(vega.rig, 'the remote operator must be the real rigged character');
    assert.equal(vega.rig.root.getObjectByName('Beta_Surface001') !== null, true);

    // Pose comes straight from the authoritative snapshot.
    assert.deepEqual(
      [vega.group.position.x, vega.group.position.y, vega.group.position.z],
      [-3, 0, -2],
    );
    assert.equal(vega.group.rotation.y, 0.5);
    assert.equal(vega.group.visible, true);

    // The weapon hangs off the operator's own hand socket, not the scene root.
    const hand = vega.rig.root.getObjectByName(BONES.rightHand);
    assert.ok(hand, 'the right hand bone must exist');
    const socketParents = [];
    vega.socket.traverseAncestors((node) => socketParents.push(node.name));
    assert.ok(socketParents.includes(BONES.rightHand), 'the weapon socket must be parented to the hand');
    assert.equal(vega.socket.name, WEAPON_SOCKET_NAME);
    assert.equal(vega.socket.parent.name, BONES.rightHand);
    assert.equal(vega.weaponModel?.userData.weaponId, 'SNIPER');
    assert.equal(vega.weaponLabel.textContent, 'Sniper');

    // Locomotion follows the measured speed in the snapshot.
    assert.equal(players.players.get('p1').rig.state, ANIMATION_STATES.WALK);
    assert.equal(players.players.get('p2').rig.state, ANIMATION_STATES.RUN);

    // Standing still drops back to idle rather than freezing mid-stride.
    players.update([{ ...PLAYERS[1], vx: 0, vz: 0 }, PLAYERS[2]], interpolator, camera, performance.now(), 'me');
    assert.equal(players.players.get('p1').rig.state, ANIMATION_STATES.IDLE);

    // A kill plays the death clip and hides the tag; a respawn revives the rig.
    players.update([{ ...PLAYERS[1], alive: false }, PLAYERS[2]], interpolator, camera, performance.now(), 'me');
    assert.equal(players.players.get('p1').rig.state, ANIMATION_STATES.DEATH);
    assert.equal(players.players.get('p1').dead, true);
    assert.equal(players.players.get('p1').label.style.display, 'none');
    const stillVega = { ...PLAYERS[1], vx: 0, vz: 0 };
    players.update([stillVega, PLAYERS[2]], interpolator, camera, performance.now(), 'me');
    assert.equal(players.players.get('p1').rig.state, ANIMATION_STATES.IDLE);
    assert.equal(players.players.get('p1').dead, false);

    // A dropped connection hides the body and says so on the tag.
    players.update([PLAYERS[1], { ...PLAYERS[2], connected: false }], interpolator, camera, performance.now(), 'me');
    const rook = players.players.get('p2');
    assert.equal(rook.group.visible, false);
    assert.equal(rook.label.classList.contains('is-offline'), true);
    assert.equal(rook.weaponLabel.textContent, 'OFFLINE · RECONNECTING');

    // A swapped weapon re-equips without leaking the previous model.
    players.update([PLAYERS[1], { ...PLAYERS[2], currentWeaponId: 'ROCKET', currentWeaponName: 'Rocket' }], interpolator, camera, performance.now(), 'me');
    assert.equal(rook.weaponModel.userData.weaponId, 'ROCKET');
    assert.equal(nameTagRoot.children.length, 2, 'one name tag per remote operator');

    // Leaving the room tears every record down: scene, DOM and GPU resources.
    const disposedRigs = [...players.players.values()].map((record) => record.rig);
    players.clear();
    assert.equal(players.players.size, 0);
    assert.equal(scene.children.length, 0, 'no operator groups may be left in the scene');
    assert.equal(nameTagRoot.children.length, 0, 'no name tags may be left in the DOM');
    for (const rig of disposedRigs) assert.equal(rig.state, null, 'a disposed rig has no action playing');
  } finally {
    players.clear();
    dom.window.close();
  }
});

test('bursts of remote joins are spread across frames and weapon switch retains fitted scale', () => {
  const { dom, scene, camera, nameTagRoot } = createScene();
  const weaponModels = createWeaponStub();
  const createModel = weaponModels.createModel;
  weaponModels.createModel = (id) => { const model = createModel(id); model.scale.setScalar(0.2); return model; };
  const remotes = new RemotePlayers(scene, nameTagRoot, weaponModels, null);
  const interpolator = { sample: () => null };
  const burst = Array.from({ length: 5 }, (_, index) => ({ ...PLAYERS[1], id: `new-${index}` }));
  const now = performance.now();
  try {
    remotes.update(burst, interpolator, camera, now, 'me');
    assert.equal(remotes.players.size, 2);
    remotes.update(burst, interpolator, camera, now + 16, 'me');
    assert.equal(remotes.players.size, 4);
    remotes.update(burst, interpolator, camera, now + 32, 'me');
    assert.equal(remotes.players.size, 5);
    remotes.update([{ ...burst[0], currentWeaponId: 'ROCKET' }, ...burst.slice(1)], interpolator, camera, now + 48, 'me');
    remotes.update([{ ...burst[0], currentWeaponId: 'ROCKET' }, ...burst.slice(1)], interpolator, camera, now + 500, 'me');
    const record = remotes.players.get('new-0');
    remotes.updateWeaponTransition(record, performance.now() + 500);
    assert.ok(Math.abs(record.weaponModel.scale.x - 0.2) < 1e-9);
    assert.equal(record.muzzleFlash.parent, record.socket);
  } finally {
    remotes.clear();
    dom.window.close();
  }
});
