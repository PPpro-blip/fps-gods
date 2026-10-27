// Shared gameplay constants are consumed by both the authoritative server and
// the Three.js renderer so collision geometry always matches what players see.
//
// Arena geometry now lives in `shared/maps.js`, which declares every playable
// map (bounds, cover, spawns). The `MAP` / `COVER` / `SPAWN_POINTS` exports
// below are that registry's default map, kept so existing imports keep working;
// anything that can run on more than one arena should call `getMap(mapId)`.
import { DEFAULT_MAP_ID, getMap } from './maps.js';

const defaultMap = getMap(DEFAULT_MAP_ID);

export const DEFAULT_ARENA = defaultMap;
export const MAP = defaultMap.bounds;

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
  shotRange: 140,
  inputTimeoutMs: 300,
});

export const BOT = Object.freeze({
  count: 5,
  thinkIntervalMs: 100,
  missChance: 0.3,
  minimumMissAngleRadians: 0.28,
  maximumMissAngleRadians: 0.48,
  waypointReachDistance: 1.5,
  minimumWaypointTimeMs: 2_500,
  maximumWaypointTimeMs: 7_000,
  stuckThinkCount: 12,
});

/** Default arena cover, in the legacy shape (`{x, z, width, height, depth}`). */
export const COVER = Object.freeze(defaultMap.cover.map((block) => Object.freeze({
  x: block.x,
  z: block.z,
  width: block.width,
  height: block.height,
  depth: block.depth,
  kind: block.kind,
})));

/** Default arena spawns. */
export const SPAWN_POINTS = defaultMap.spawns;
