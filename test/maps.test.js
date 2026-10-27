import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAP_ID,
  MAP_IDS,
  MAP_LIST,
  MAP_NAMES,
  describeMap,
  getMap,
  isValidMapId,
  resolveMapId,
  validateMap,
} from '../shared/maps.js';
import { COVER, DEFAULT_ARENA, MAP, SPAWN_POINTS } from '../shared/gameConfig.js';

test('every advertised map id resolves to a complete, valid map', () => {
  assert.ok(MAP_LIST.length >= 3, 'at least three playable maps are advertised');
  assert.deepEqual(
    MAP_LIST.map((map) => map.id),
    Object.values(MAP_IDS),
    'the ordered map list matches the stable id table',
  );

  for (const map of MAP_LIST) {
    assert.equal(isValidMapId(map.id), true, `${map.id} passes the allowlist`);
    assert.equal(getMap(map.id).id, map.id);
    assert.equal(MAP_NAMES[map.id], map.name);
    assert.deepEqual(validateMap(map), [], `${map.id} has no geometry problems`);
    assert.ok(map.name.length > 0);
    assert.ok(map.description.length > 0);
    assert.ok(map.palette.accent.startsWith('#'));
    assert.ok(map.lighting.exposure > 0);
    assert.ok(map.lighting.accents.length <= 3, 'accent lights stay bounded');
  }
});

test('the default map is one of the registry maps', () => {
  assert.equal(isValidMapId(DEFAULT_MAP_ID), true);
  assert.equal(getMap(DEFAULT_MAP_ID).id, DEFAULT_MAP_ID);
  assert.equal(describeMap(DEFAULT_MAP_ID).mapId, DEFAULT_MAP_ID);
  assert.equal(describeMap(DEFAULT_MAP_ID).mapName, getMap(DEFAULT_MAP_ID).name);
});

test('unknown, empty, and hostile map ids fall back to the documented default', () => {
  for (const value of [undefined, null, '', 'nope', 'NEON-FOUNDRY', '../etc/passwd', 42, {}, []]) {
    assert.equal(isValidMapId(value), false, `${String(value)} is not an allowlisted id`);
    assert.equal(resolveMapId(value), DEFAULT_MAP_ID);
  }
  // Case differences must not silently alias to a real map.
  assert.equal(resolveMapId('SKYBRIDGE'), DEFAULT_MAP_ID);
  assert.equal(resolveMapId('Skybridge'), DEFAULT_MAP_ID);
  // Every real id does resolve, of course.
  for (const id of Object.values(MAP_IDS)) assert.equal(resolveMapId(id), id);
});

test('spawns sit inside every map bounds and clear of cover', () => {
  for (const map of MAP_LIST) {
    const { halfWidth, halfDepth } = map.bounds;
    assert.ok(map.spawns.length >= 8, `${map.id} has enough spawns for a FFA lobby`);
    const seen = new Set();
    for (const spawn of map.spawns) {
      const key = `${spawn.x}:${spawn.z}`;
      assert.equal(seen.has(key), false, `${map.id} spawn ${key} is unique`);
      seen.add(key);
      assert.ok(Math.abs(spawn.x) <= halfWidth - 1, `${map.id} spawn x in bounds`);
      assert.ok(Math.abs(spawn.z) <= halfDepth - 1, `${map.id} spawn z in bounds`);
      for (const block of map.cover) {
        const dx = Math.abs(spawn.x - block.x) - block.width / 2;
        const dz = Math.abs(spawn.z - block.z) - block.depth / 2;
        assert.ok(
          dx > 0.6 || dz > 0.6,
          `${map.id} spawn ${key} is not buried inside cover at ${block.x},${block.z}`,
        );
      }
    }
    // Spawns are spread over the arena rather than stacked in one corner.
    const xs = map.spawns.map((spawn) => spawn.x);
    assert.ok(Math.max(...xs) - Math.min(...xs) > halfWidth, `${map.id} spawns span the width`);
  }
});

test('cover never pokes outside the playable bounds', () => {
  for (const map of MAP_LIST) {
    const { halfWidth, halfDepth } = map.bounds;
    for (const block of map.cover) {
      assert.ok(block.width > 0 && block.depth > 0 && block.height > 0);
      assert.ok(Math.abs(block.x) + block.width / 2 <= halfWidth + 0.001, `${map.id} cover x in bounds`);
      assert.ok(Math.abs(block.z) + block.depth / 2 <= halfDepth + 0.001, `${map.id} cover z in bounds`);
      assert.ok(block.height <= map.bounds.wallHeight, `${map.id} cover is not taller than the walls`);
    }
  }
});

test('gameConfig derives its arena from the default map, not a hardcoded copy', () => {
  const defaultMap = getMap(DEFAULT_MAP_ID);
  assert.equal(DEFAULT_ARENA.id, defaultMap.id);
  assert.deepEqual(MAP, defaultMap.bounds);
  assert.equal(COVER.length, defaultMap.cover.length);
  assert.equal(SPAWN_POINTS.length, defaultMap.spawns.length);
  assert.deepEqual(
    SPAWN_POINTS.map((spawn) => [spawn.x, spawn.z]),
    defaultMap.spawns.map((spawn) => [spawn.x, spawn.z]),
  );
});

test('validateMap reports the specific problem it found', () => {
  const base = getMap(DEFAULT_MAP_ID);
  const mutate = (patch) => ({ ...base, ...patch });
  const problems = (map) => validateMap(map).join(' | ');

  assert.match(problems(mutate({ spawns: [] })), /six spawns/);
  assert.match(problems(mutate({ spawns: [{ x: 999, z: 0 }] })), /outside the playable box/);
  assert.match(
    problems(mutate({ cover: [{ x: 0, z: 0, width: 4, depth: 4, height: 99 }] })),
    /unusable height/,
  );
  assert.match(
    problems(mutate({ cover: [{ x: 0, z: 0, width: 400, depth: 4, height: 1 }] })),
    /side wall|front wall/,
  );
  assert.deepEqual(validateMap(null), ['map has no bounds'], 'a missing map is not valid');
});
