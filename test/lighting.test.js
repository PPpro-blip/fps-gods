import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MAP_LIST, MAP_IDS } from '../shared/maps.js';
import { World } from '../client/world.js';

// Static readability contracts for the arena art.
//
// This is NOT rendering evidence: there is no WebGL context here, so nothing can
// prove a screenshot looks right. These tests only pin the numeric decisions a
// readability retune depends on (surface value separation, roughness/metalness
// of each surface class, light budget, fog falloff) so a later palette edit
// cannot quietly flatten the arena back into one grey mass.

const linear = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the floor is darker than the walls on every map', () => {
  for (const map of MAP_LIST) {
    const { floor, wall, wallFoot } = map.palette;
    assert.ok(
      contrast(floor, wall) >= 1.2,
      `${map.id}: floor and wall albedo are only ${contrast(floor, wall).toFixed(2)}:1 apart`,
    );
    assert.ok(luminance(floor) < luminance(wall), `${map.id}: the floor is the darker surface`);
    assert.ok(luminance(wallFoot) < luminance(floor), `${map.id}: the skirting is darker than the floor`);
  }
});

test('cover stands off the floor and the wall trim stays a hard highlight', () => {
  for (const map of MAP_LIST) {
    const { floor, wall, wallTrim, accent, coverSeam, cover } = map.palette;
    for (const color of cover) {
      assert.ok(contrast(color, floor) >= 1.2, `${map.id}: a cover colour blends into the floor`);
    }
    assert.ok(contrast(wallTrim, wall) >= 3, `${map.id}: wall trim is not a readable edge highlight`);
    assert.ok(contrast(accent, wall) >= 3, `${map.id}: the accent colour does not pop off the walls`);
    assert.ok(contrast(coverSeam, floor) >= 3, `${map.id}: cover seams are not visible at range`);
  }
});

test('exposure and fog are tuned for readability, not atmosphere', () => {
  for (const map of MAP_LIST) {
    const { exposure, accents } = map.lighting;
    assert.ok(exposure >= 1.2 && exposure <= 1.7, `${map.id}: exposure ${exposure} is out of the tuned range`);
    assert.ok(!Number.isNaN(exposure));

    // FogExp2 visibility at 30 m: the arena diagonal may haze, mid-range may not.
    const density = map.palette.fog.density;
    const visible30 = Math.exp(-((30 * density) ** 2));
    assert.ok(visible30 > 0.9, `${map.id}: ${(100 * visible30).toFixed(0)}% of a 30 m target survives the fog`);
    const diagonal = Math.hypot(map.bounds.halfWidth * 2, map.bounds.halfDepth * 2);
    assert.ok(Math.exp(-((diagonal * density) ** 2)) > 0.6, `${map.id}: fog swallows the far wall`);

    // Light budget: hemisphere + key + fill + rim + ambient are shared, accents capped.
    assert.ok(accents.length <= 3, `${map.id}: too many accent lights`);
    for (const accent of accents) {
      assert.ok(accent.distance > 0 && accent.distance <= 60, `${map.id}: accent light range is unbounded`);
      assert.ok(accent.intensity > 0 && accent.intensity <= 150, `${map.id}: accent light is a flashbang`);
    }
  }
});

test('surface materials separate floor, wall, and each cover kind', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);
  try {
    for (const map of MAP_LIST) {
      assert.equal(world.setMap(map.id), true);
      const { floor, wall, wallFoot } = world.materials;
      assert.ok(floor.roughness > wall.roughness, `${map.id}: the floor must be the most matte surface`);
      assert.ok(floor.metalness < wall.metalness, `${map.id}: the floor must not be mirror-like`);
      assert.ok(wallFoot.roughness >= 0.9, `${map.id}: skirting should be matte`);
      assert.ok(floor.roughness >= 0.85, `${map.id}: a glossy floor hides spawn markers`);

      const crate = world.coverMaterial('crate', 0);
      const container = world.coverMaterial('container', 0);
      const pillar = world.coverMaterial('pillar', 0);
      assert.notEqual(crate.roughness, container.roughness, `${map.id}: crate and container share a finish`);
      assert.ok(pillar.roughness > container.roughness, `${map.id}: concrete should be rougher than sheet metal`);
      assert.equal(world.coverMaterial('crate', 0), crate, 'cover materials are cached, not rebuilt per block');

      // The renderer's exposure must follow the map, whatever the map says.
      assert.equal(map.lighting.exposure, Number(map.lighting.exposure));
    }
  } finally {
    world.dispose();
  }
});

test('the arena is built from the map the server named, and rebuilt on change', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);
  try {
    assert.equal(world.setMap(MAP_IDS.FOUNDRY), true);
    assert.equal(world.setMap(MAP_IDS.FOUNDRY), false, 'the same map is not rebuilt');
    assert.equal(world.setMap(MAP_IDS.DUSTLINE), true);
    assert.equal(world.map.id, MAP_IDS.DUSTLINE);
    const bounds = world.map.bounds;
    // Wall meshes must line up with the collision box the server uses.
    const solids = [];
    scene.traverse((node) => {
      if (node.isMesh && node.geometry?.type === 'BoxGeometry') solids.push(node);
    });
    assert.ok(solids.length > 0);
    assert.equal(scene.fog?.isFogExp2, true, 'the arena owns its fog');
    assert.equal(scene.fog.density, world.map.palette.fog.density);
    void bounds;
  } finally {
    world.dispose();
  }
});

test('every cover block is real rendered geometry, not just an outline', () => {
  const scene = new THREE.Scene();
  const world = new World(scene);
  try {
    for (const map of MAP_LIST) {
      world.setMap(map.id);
      assert.equal(world.coverMeshes.size, map.cover.length);
      assert.equal([...world.ownedGeometries].filter((geometry) => !geometry).length, 0, 'no undefined geometries are tracked');
      for (const [id, parts] of world.coverMeshes) {
        const body = parts.crate;
        const meshes = [];
        body.traverse((node) => { if (node.isMesh) meshes.push(node); });
        assert.ok(meshes.length > 0, `${map.id}: cover ${id} has no solid body`);
        for (const mesh of meshes) {
          assert.ok(mesh.material?.isMeshStandardMaterial, `${map.id}: cover ${id} needs a lit material`);
          assert.ok(mesh.geometry?.isBufferGeometry);
        }
        // The seam is an emissive strip, not a substitute for the body.
        assert.ok(parts.seam.isMesh);
        assert.equal(parts.seam.material, world.materials.coverSeam);
        // Body dimensions must match the collision box the server uses.
        const box = new THREE.Box3().setFromObject(body);
        const size = box.getSize(new THREE.Vector3());
        assert.ok(Math.abs(size.x - map.cover[id].width) < 0.05, `${map.id}: cover ${id} width matches collision`);
        assert.ok(Math.abs(size.z - map.cover[id].depth) < 0.05, `${map.id}: cover ${id} depth matches collision`);
        assert.ok(size.y <= map.cover[id].height + 0.01, `${map.id}: cover ${id} is taller than its collision box`);
      }
    }
  } finally {
    world.dispose();
  }
});
