// Shared, authoritative map registry.
//
// Every arena is declared here as data: bounds, cover, spawns and the palette
// the renderer uses. The Node server reads the same records the browser does, so
// collision, world boundaries, spawn placement and bot navigation cannot drift
// from what a player sees. Nothing in this file is client-specific.

/** Stable ids. Persisted in rooms and sent over the socket, so never renumber. */
export const MAP_IDS = Object.freeze({
  FOUNDRY: 'neon-foundry',
  SKYBRIDGE: 'skybridge',
  DUSTLINE: 'dustline',
});

export const DEFAULT_MAP_ID = MAP_IDS.FOUNDRY;

const cover = (x, z, width, depth, height, kind = 'crate') => Object.freeze({
  x, z, width, depth, height, kind,
});

const spawn = (x, z) => Object.freeze({ x, z });

/**
 * Neon Foundry — the original arena, re-lit.
 *
 * Three north/south lanes split by staggered crates, with four tall pillars
 * marking the lane junctions so a player always has a landmark to read.
 */
const NEON_FOUNDRY = Object.freeze({
  id: MAP_IDS.FOUNDRY,
  name: 'NEON FOUNDRY',
  tagline: 'INDUSTRIAL · THREE LANES',
  description: 'Cool steel, cyan process lights and staggered machine crates. The balanced opener: three lanes, tight flanking angles.',
  bounds: Object.freeze({ halfWidth: 30, halfDepth: 24, wallHeight: 6, wallThickness: 1 }),
  cover: Object.freeze([
    // North line
    cover(-17, -12, 3.4, 3.2, 2.6, 'container'),
    cover(-5, -12, 2.8, 2.8, 2.9, 'crate'),
    cover(8, -12, 3.2, 3.2, 2.7, 'container'),
    cover(19, -8, 2.8, 3.8, 2.5, 'crate'),
    // Lane pillars
    cover(-22, 0, 1.8, 1.8, 4.4, 'pillar'),
    cover(22, 0, 1.8, 1.8, 4.4, 'pillar'),
    // Centre band
    cover(-10, 0, 3.8, 2.8, 2.5, 'container'),
    cover(2, 0, 2.8, 4.2, 2.9, 'crate'),
    cover(15, 2, 3.8, 2.8, 2.5, 'container'),
    // South line
    cover(-18, 12, 3.2, 3.2, 2.6, 'container'),
    cover(-6, 12, 2.8, 4.2, 2.9, 'crate'),
    cover(8, 12, 3.8, 2.8, 2.5, 'container'),
    cover(20, 13, 2.8, 2.8, 2.7, 'crate'),
    // Low barriers across the two flank lanes. Deliberately kept off the centre
    // line so the middle of the map stays a clean, readable sightline.
    cover(-16, -6, 1.0, 5.2, 1.5, 'barrier'),
    cover(16, 6, 1.0, 5.2, 1.5, 'barrier'),
  ]),
  spawns: Object.freeze([
    spawn(-25, -19), spawn(0, -20), spawn(25, -19),
    spawn(26, 0), spawn(25, 19), spawn(0, 20),
    spawn(-25, 19), spawn(-26, 0),
    spawn(-13, -19), spawn(13, 19),
  ]),
  palette: Object.freeze({
    background: '#101d2b',
    fog: Object.freeze({ color: '#101d2b', density: 0.0072 }),
    // Floor albedo is held ~1.3:1 darker than the wall albedo on every map, so
    // the walkable plane reads as ground rather than blending into the walls.
    floor: '#263543',
    floorLine: '#4b8fae',
    wall: '#33465a',
    wallFoot: '#182633',
    wallTrim: '#54c8ee',
    grid: '#3f6c84',
    cover: Object.freeze(['#42586d', '#4d657c', '#3a4f62']),
    coverEdge: '#7fd8f2',
    coverSeam: '#63c9e8',
    accent: '#59d8ff',
    secondary: '#ff8b3d',
    skyline: '#1a2938',
  }),
  lighting: Object.freeze({
    exposure: 1.42,
    hemisphere: Object.freeze({ sky: '#cfeaff', ground: '#3b4a5e', intensity: 2.35 }),
    key: Object.freeze({ color: '#e8f4ff', intensity: 2.9, position: Object.freeze([-16, 26, 12]) }),
    fill: Object.freeze({ color: '#6aa6d6', intensity: 1.15, position: Object.freeze([20, 14, -14]) }),
    rim: Object.freeze({ color: '#7fd8f2', intensity: 1.35, position: Object.freeze([0, 10, -34]) }),
    accents: Object.freeze([
      Object.freeze({ color: '#36bfe8', intensity: 90, distance: 46, position: Object.freeze([-20, 5, -12]) }),
      Object.freeze({ color: '#ff874d', intensity: 70, distance: 42, position: Object.freeze([20, 4.5, 13]) }),
    ]),
  }),
  scenery: Object.freeze({ style: 'foundry' }),
});

/**
 * Skybridge — a narrow transit spine over open air.
 *
 * The playable area is long and tight: a central corridor flanked by two long
 * barriers, with crossing gaps so the flanks are reachable. Tall support pylons
 * give opposing silhouettes and break the skyline. Everything outside the walls
 * is non-collidable scenery; nothing decorative is ever placed inside the
 * playable bounds, so what you see is always what you collide with.
 */
const SKYBRIDGE = Object.freeze({
  id: MAP_IDS.SKYBRIDGE,
  name: 'SKYBRIDGE',
  tagline: 'ORBITAL · LONG LANES',
  description: 'A narrow orbital transit deck. One tight central corridor, two long flanking routes and pylons that break sightlines. Long-range fights.',
  bounds: Object.freeze({ halfWidth: 20, halfDepth: 36, wallHeight: 5.2, wallThickness: 1 }),
  cover: Object.freeze([
    // The bridge spine: two long barriers with crossing gaps at z = 0 and ±18.
    cover(-2.6, -22, 1.2, 16, 2.0, 'barrier'),
    cover(2.6, -22, 1.2, 16, 2.0, 'barrier'),
    cover(-2.6, 22, 1.2, 16, 2.0, 'barrier'),
    cover(2.6, 22, 1.2, 16, 2.0, 'barrier'),
    // Flank pylons
    cover(-13, -26, 2.2, 2.2, 4.6, 'pillar'),
    cover(13, -26, 2.2, 2.2, 4.6, 'pillar'),
    cover(-13, 26, 2.2, 2.2, 4.6, 'pillar'),
    cover(13, 26, 2.2, 2.2, 4.6, 'pillar'),
    cover(-13, 0, 2.2, 2.2, 4.6, 'pillar'),
    cover(13, 0, 2.2, 2.2, 4.6, 'pillar'),
    // Flank cover: alternating so neither side is a straight sprint.
    cover(-11, -13, 3.0, 2.4, 2.4, 'container'),
    cover(11, -8, 3.0, 2.4, 2.4, 'container'),
    cover(-11, 9, 3.0, 2.4, 2.4, 'container'),
    cover(11, 14, 3.0, 2.4, 2.4, 'container'),
    // Transit crates at the crossing gaps.
    cover(-7, 0, 2.4, 2.4, 2.6, 'crate'),
    cover(7, 0, 2.4, 2.4, 2.6, 'crate'),
  ]),
  spawns: Object.freeze([
    spawn(-15, -31), spawn(0, -32), spawn(15, -31),
    spawn(-16, -16), spawn(16, -16),
    spawn(-16, 16), spawn(16, 16),
    spawn(-15, 31), spawn(0, 32), spawn(15, 31),
  ]),
  palette: Object.freeze({
    background: '#0b1524',
    fog: Object.freeze({ color: '#0b1524', density: 0.0062 }),
    floor: '#1f2d3b',
    floorLine: '#6ec9f0',
    wall: '#2b3d52',
    wallFoot: '#121e2c',
    wallTrim: '#8fe6ff',
    grid: '#4a7d9b',
    cover: Object.freeze(['#44596f', '#516a84', '#3b4f63']),
    coverEdge: '#9ae9ff',
    coverSeam: '#6fd8ff',
    accent: '#8fe6ff',
    secondary: '#7c8cff',
    skyline: '#16273a',
  }),
  lighting: Object.freeze({
    exposure: 1.48,
    hemisphere: Object.freeze({ sky: '#dff2ff', ground: '#334a63', intensity: 2.6 }),
    key: Object.freeze({ color: '#f0f8ff', intensity: 3.1, position: Object.freeze([-10, 30, 18]) }),
    fill: Object.freeze({ color: '#7fb6e6', intensity: 1.3, position: Object.freeze([16, 16, -20]) }),
    rim: Object.freeze({ color: '#9ae9ff', intensity: 1.6, position: Object.freeze([0, 14, -40]) }),
    accents: Object.freeze([
      Object.freeze({ color: '#69d6ff', intensity: 80, distance: 56, position: Object.freeze([-16, 6, 0]) }),
      Object.freeze({ color: '#69d6ff', intensity: 80, distance: 56, position: Object.freeze([16, 6, 0]) }),
      Object.freeze({ color: '#8b7dff', intensity: 60, distance: 48, position: Object.freeze([0, 7, 30]) }),
    ]),
  }),
  scenery: Object.freeze({ style: 'orbital' }),
});

/**
 * Dustline — a wide open desert outpost.
 *
 * The widest arena: sandbag lines and rock clusters instead of corridors, so
 * fights are decided by flanking and long sightlines rather than lane control.
 */
const DUSTLINE = Object.freeze({
  id: MAP_IDS.DUSTLINE,
  name: 'DUSTLINE',
  tagline: 'DESERT · WIDE OPEN',
  description: 'A sunlit desert outpost. Wide open ground, rock cover and sandbag lines — flanking and long sightlines instead of corridors.',
  bounds: Object.freeze({ halfWidth: 36, halfDepth: 22, wallHeight: 5.4, wallThickness: 1 }),
  cover: Object.freeze([
    // Outpost core
    cover(0, 0, 4.6, 3.4, 2.6, 'container'),
    cover(-6, -3, 2.6, 2.6, 2.4, 'crate'),
    cover(6, 3, 2.6, 2.6, 2.4, 'crate'),
    // Rock clusters
    cover(-20, -10, 3.6, 3.2, 2.7, 'rock'),
    cover(-20, 10, 3.6, 3.2, 2.7, 'rock'),
    cover(20, -10, 3.6, 3.2, 2.7, 'rock'),
    cover(20, 10, 3.6, 3.2, 2.7, 'rock'),
    cover(-9, -13, 2.8, 2.4, 2.1, 'rock'),
    cover(9, 13, 2.8, 2.4, 2.1, 'rock'),
    // Sandbag lines
    cover(-13, 3, 7.0, 1.1, 1.35, 'sandbag'),
    cover(13, -3, 7.0, 1.1, 1.35, 'sandbag'),
    cover(-27, 0, 1.2, 7.0, 1.5, 'sandbag'),
    cover(27, 0, 1.2, 7.0, 1.5, 'sandbag'),
    // Watchtower bases: tall, deliberate landmarks.
    cover(-24, -13, 2.6, 2.6, 4.8, 'pillar'),
    cover(24, 13, 2.6, 2.6, 4.8, 'pillar'),
  ]),
  spawns: Object.freeze([
    spawn(-32, -18), spawn(-11, -18), spawn(11, -18), spawn(32, -18),
    spawn(-32, 18), spawn(-11, 18), spawn(11, 18), spawn(32, 18),
    spawn(-33, 0), spawn(33, 0),
  ]),
  palette: Object.freeze({
    background: '#2a1e16',
    fog: Object.freeze({ color: '#3a2a1e', density: 0.0058 }),
    floor: '#4c3c2d',
    floorLine: '#a98a63',
    wall: '#5f4b39',
    wallFoot: '#2b1e14',
    wallTrim: '#ffb86b',
    grid: '#8a7150',
    cover: Object.freeze(['#7b6550', '#8a7360', '#6d5945']),
    coverEdge: '#e0b183',
    coverSeam: '#ffc078',
    accent: '#ffb347',
    secondary: '#59d8ff',
    skyline: '#3a2b20',
  }),
  lighting: Object.freeze({
    exposure: 1.36,
    hemisphere: Object.freeze({ sky: '#ffe6c4', ground: '#8a6a4c', intensity: 2.5 }),
    key: Object.freeze({ color: '#fff0d2', intensity: 3.3, position: Object.freeze([-26, 30, -12]) }),
    fill: Object.freeze({ color: '#ffc98d', intensity: 1.0, position: Object.freeze([24, 12, 18]) }),
    rim: Object.freeze({ color: '#ffd8a6', intensity: 1.2, position: Object.freeze([0, 12, -36]) }),
    accents: Object.freeze([
      Object.freeze({ color: '#ffa955', intensity: 60, distance: 40, position: Object.freeze([-28, 5, 14]) }),
      Object.freeze({ color: '#59d8ff', intensity: 45, distance: 34, position: Object.freeze([28, 5, -14]) }),
    ]),
  }),
  scenery: Object.freeze({ style: 'desert' }),
});

export const MAPS = Object.freeze({
  [MAP_IDS.FOUNDRY]: NEON_FOUNDRY,
  [MAP_IDS.SKYBRIDGE]: SKYBRIDGE,
  [MAP_IDS.DUSTLINE]: DUSTLINE,
});

/** Presentation order for the map picker. */
export const MAP_LIST = Object.freeze([NEON_FOUNDRY, SKYBRIDGE, DUSTLINE]);

export const MAP_NAMES = Object.freeze(
  Object.fromEntries(MAP_LIST.map((map) => [map.id, map.name])),
);

/** @returns {boolean} whether `id` is a map this build knows about. */
export function isValidMapId(id) {
  return typeof id === 'string' && Object.hasOwn(MAPS, id);
}

/**
 * The single place that decides which arena a room plays on. An unknown or
 * missing id becomes the documented default rather than throwing, so an older
 * client that does not send `mapId` keeps working.
 */
export function resolveMapId(id) {
  return isValidMapId(id) ? id : DEFAULT_MAP_ID;
}

/** @returns {object} the map record for `id`, defaulting rather than throwing. */
export function getMap(id) {
  return MAPS[resolveMapId(id)];
}

/** Safe, serialisable summary for room payloads and the lobby browser. */
export function describeMap(id) {
  const map = getMap(id);
  return { mapId: map.id, mapName: map.name, mapTagline: map.tagline };
}

/**
 * Geometric validation shared by the tests and by the server's map guard.
 *
 * Checks the properties that make a map *playable* rather than merely drawn:
 * spawns inside the walls, clear of cover, far enough apart, and cover that is
 * itself inside the playable box.
 */
export function validateMap(map) {
  const problems = [];
  if (!map?.bounds) return ['map has no bounds'];
  const { halfWidth, halfDepth, wallThickness } = map.bounds;
  const inset = wallThickness / 2 + 0.9; // keep a body-width off the walls
  const insideX = halfWidth - inset;
  const insideZ = halfDepth - inset;

  if (!Array.isArray(map.spawns) || map.spawns.length < 6) problems.push('needs at least six spawns');

  for (const [index, point] of (map.spawns ?? []).entries()) {
    if (Math.abs(point.x) > insideX || Math.abs(point.z) > insideZ) {
      problems.push(`spawn ${index} (${point.x}, ${point.z}) is outside the playable box`);
      continue;
    }
    for (const [blockIndex, block] of (map.cover ?? []).entries()) {
      const dx = Math.max(Math.abs(point.x - block.x) - block.width / 2, 0);
      const dz = Math.max(Math.abs(point.z - block.z) - block.depth / 2, 0);
      if (Math.hypot(dx, dz) < 1.1) problems.push(`spawn ${index} overlaps cover ${blockIndex}`);
    }
  }

  for (let a = 0; a < (map.spawns ?? []).length; a += 1) {
    for (let b = a + 1; b < map.spawns.length; b += 1) {
      const distance = Math.hypot(map.spawns[a].x - map.spawns[b].x, map.spawns[a].z - map.spawns[b].z);
      if (distance < 5) problems.push(`spawns ${a} and ${b} are only ${distance.toFixed(1)} m apart`);
    }
  }

  for (const [index, block] of (map.cover ?? []).entries()) {
    if (Math.abs(block.x) + block.width / 2 > halfWidth - wallThickness / 2) {
      problems.push(`cover ${index} pokes through a side wall`);
    }
    if (Math.abs(block.z) + block.depth / 2 > halfDepth - wallThickness / 2) {
      problems.push(`cover ${index} pokes through a front wall`);
    }
    if (block.height <= 0 || block.height > map.bounds.wallHeight) {
      problems.push(`cover ${index} has an unusable height (${block.height})`);
    }
  }

  return problems;
}
