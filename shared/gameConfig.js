// Shared gameplay constants are consumed by both the authoritative server and
// the Three.js renderer so collision geometry always matches what players see.
// Weapon statistics live in shared/weapons.js.
export const MAP = Object.freeze({
  halfWidth: 30,
  halfDepth: 24,
  wallHeight: 6,
  wallThickness: 1,
});

export const PLAYER = Object.freeze({
  radius: 0.38,
  height: 1.8,
  eyeHeight: 1.53,
  moveSpeed: 7.2,
  jumpVelocity: 7.4,
  gravity: 21,
  maxHealth: 100,
  respawnMs: 3_000,
  spawnProtectionMs: 2_000,
  targetKills: 30,
  minPlayers: 2,
  maxPlayers: 16,
  inputTimeoutMs: 300,
});

// Solo drop-in configuration. Bots are simulated entirely on the server and
// share the same shoot/hit pipeline as human players.
export const BOTS = Object.freeze({
  count: 5,
  tickMs: 100,
  namePrefix: 'GOD_BOT_',
  missChance: 0.3,
  turnSpeed: 7.5,
  waypointTimeoutMs: 6_500,
  fireRangeBuffer: 0.9,
});

// Twelve solid waist-to-head-high cover blocks. Each is an AABB in X/Z with
// its base on the arena floor; the server uses the same dimensions for hits.
export const COVER = Object.freeze([
  { x: -17, z: -12, width: 3.4, height: 2.6, depth: 3.2 },
  { x: -5, z: -12, width: 2.8, height: 2.9, depth: 2.8 },
  { x: 8, z: -12, width: 3.2, height: 2.7, depth: 3.2 },
  { x: 19, z: -8, width: 2.8, height: 2.5, depth: 3.8 },
  { x: -22, z: 0, width: 2.8, height: 2.7, depth: 3.8 },
  { x: -10, z: 0, width: 3.8, height: 2.5, depth: 2.8 },
  { x: 2, z: 0, width: 2.8, height: 2.9, depth: 4.2 },
  { x: 15, z: 2, width: 3.8, height: 2.5, depth: 2.8 },
  { x: -18, z: 12, width: 3.2, height: 2.6, depth: 3.2 },
  { x: -6, z: 12, width: 2.8, height: 2.9, depth: 4.2 },
  { x: 8, z: 12, width: 3.8, height: 2.5, depth: 2.8 },
  { x: 20, z: 13, width: 2.8, height: 2.7, depth: 2.8 },
].map((block) => Object.freeze(block)));

// Eight fixed perimeter spawns, kept clear of the twelve cover blocks.
export const SPAWN_POINTS = Object.freeze([
  Object.freeze({ x: -25, z: -19 }),
  Object.freeze({ x: 0, z: -20 }),
  Object.freeze({ x: 25, z: -19 }),
  Object.freeze({ x: 26, z: 0 }),
  Object.freeze({ x: 25, z: 19 }),
  Object.freeze({ x: 0, z: 20 }),
  Object.freeze({ x: -25, z: 19 }),
  Object.freeze({ x: -26, z: 0 }),
]);

// Open patrol waypoints for bot pathing: lane midpoints between the covers.
export const BOT_WAYPOINTS = Object.freeze([
  Object.freeze({ x: -24, z: -16 }),
  Object.freeze({ x: -11, z: -17 }),
  Object.freeze({ x: 0, z: -8 }),
  Object.freeze({ x: 13, z: -17 }),
  Object.freeze({ x: 24, z: -12 }),
  Object.freeze({ x: 22, z: -2 }),
  Object.freeze({ x: 11, z: 6 }),
  Object.freeze({ x: 0, z: 8 }),
  Object.freeze({ x: -11, z: 6 }),
  Object.freeze({ x: -24, z: 2 }),
  Object.freeze({ x: -14, z: 15 }),
  Object.freeze({ x: -2, z: 17 }),
  Object.freeze({ x: 13, z: 16 }),
  Object.freeze({ x: 24, z: 10 }),
  Object.freeze({ x: -27, z: -8 }),
  Object.freeze({ x: 27, z: 8 }),
]);
