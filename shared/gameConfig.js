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
  // Must exceed a high-RTT intercontinental TCP retransmission window (~330-550ms)
  // so a single delayed WebSocket frame never halts server-side movement mid-stride.
  inputTimeoutMs: 750,
});

export const BOT_DIFFICULTY_IDS = Object.freeze(['easy', 'normal', 'hard']);
export const DEFAULT_BOT_DIFFICULTY = 'easy';

/**
 * Authoritative server-side bot difficulty presets.
 *
 * Every preset uses the exact same weapon damage, hitboxes, cover collision, and
 * cooldown validation as human operators — fairness comes from human-like
 * perception, reaction delay, bounded turn speed, torso aim, tracking lag against
 * moving targets, burst cadence, and coordinated focus-fire limits.
 */
export const BOT_DIFFICULTIES = Object.freeze({
  easy: Object.freeze({
    id: 'easy',
    label: 'EASY',
    summary: 'Forgiving reactions, wider aim spread, and capped focus fire.',
    reactionMinMs: 600,
    reactionMaxMs: 800,
    postRespawnGraceMs: 900,
    targetMemoryMs: 450,
    visionHalfAngleRad: 1.32,
    hearingRadius: 4.5,
    turnSpeedRadPerSec: 2.45,
    pitchSpeedRadPerSec: 1.85,
    patrolTurnSpeedRadPerSec: 2.1,
    fireConeRad: 0.24,
    aimHeightRatio: 0.56,
    trackingLagSeconds: 0.19,
    aimJitterRad: 0.066,
    movingTargetSpreadRad: 0.062,
    missChance: 0.42,
    minimumMissAngleRadians: 0.25,
    maximumMissAngleRadians: 0.46,
    fireIntervalMultiplier: 1.55,
    burstShotsMin: 2,
    burstShotsMax: 4,
    burstCooldownMinMs: 650,
    burstCooldownMaxMs: 920,
    maxSimultaneousAttackers: 2,
    preferredMinRange: 8.5,
    preferredMaxRange: 17.5,
    strafeStrength: 0.42,
    retreatHealthThreshold: 0,
    allowedBundles: Object.freeze(['RUSHER', 'HEAVY']),
  }),
  normal: Object.freeze({
    id: 'normal',
    label: 'NORMAL',
    summary: 'Competent human-paced reactions, bursts, and strafe tracking.',
    reactionMinMs: 360,
    reactionMaxMs: 500,
    postRespawnGraceMs: 580,
    targetMemoryMs: 850,
    visionHalfAngleRad: 1.57,
    hearingRadius: 5.5,
    turnSpeedRadPerSec: 4.2,
    pitchSpeedRadPerSec: 3.0,
    patrolTurnSpeedRadPerSec: 2.8,
    fireConeRad: 0.19,
    aimHeightRatio: 0.62,
    trackingLagSeconds: 0.12,
    aimJitterRad: 0.044,
    movingTargetSpreadRad: 0.042,
    missChance: 0.3,
    minimumMissAngleRadians: 0.24,
    maximumMissAngleRadians: 0.44,
    fireIntervalMultiplier: 1.22,
    burstShotsMin: 3,
    burstShotsMax: 6,
    burstCooldownMinMs: 350,
    burstCooldownMaxMs: 540,
    maxSimultaneousAttackers: 3,
    preferredMinRange: 6.5,
    preferredMaxRange: 16.0,
    strafeStrength: 0.68,
    retreatHealthThreshold: 28,
    allowedBundles: Object.freeze(['RUSHER', 'GHOST', 'HEAVY']),
  }),
  hard: Object.freeze({
    id: 'hard',
    label: 'HARD',
    summary: 'Sharp reactions, tighter bursts, and active combat strafing.',
    reactionMinMs: 150,
    reactionMaxMs: 230,
    postRespawnGraceMs: 340,
    targetMemoryMs: 1_250,
    visionHalfAngleRad: 1.92,
    hearingRadius: 7.5,
    turnSpeedRadPerSec: 6.6,
    pitchSpeedRadPerSec: 4.6,
    patrolTurnSpeedRadPerSec: 3.6,
    fireConeRad: 0.15,
    aimHeightRatio: 0.68,
    trackingLagSeconds: 0.065,
    aimJitterRad: 0.022,
    movingTargetSpreadRad: 0.024,
    missChance: 0.16,
    minimumMissAngleRadians: 0.18,
    maximumMissAngleRadians: 0.34,
    fireIntervalMultiplier: 1.05,
    burstShotsMin: 5,
    burstShotsMax: 8,
    burstCooldownMinMs: 190,
    burstCooldownMaxMs: 320,
    maxSimultaneousAttackers: 4,
    preferredMinRange: 5.5,
    preferredMaxRange: 18.0,
    strafeStrength: 0.9,
    retreatHealthThreshold: 34,
    allowedBundles: Object.freeze(['RUSHER', 'GHOST', 'HEAVY']),
  }),
});

export function isValidBotDifficulty(value) {
  return typeof value === 'string' && Object.hasOwn(BOT_DIFFICULTIES, value.trim().toLowerCase());
}

export function resolveBotDifficulty(value) {
  if (typeof value !== 'string') return DEFAULT_BOT_DIFFICULTY;
  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(BOT_DIFFICULTIES, normalized) ? normalized : DEFAULT_BOT_DIFFICULTY;
}

export function getBotDifficultyConfig(value) {
  return BOT_DIFFICULTIES[resolveBotDifficulty(value)];
}

export const BOT = Object.freeze({
  count: 5,
  thinkIntervalMs: 100,
  missChance: BOT_DIFFICULTIES.normal.missChance,
  minimumMissAngleRadians: BOT_DIFFICULTIES.normal.minimumMissAngleRadians,
  maximumMissAngleRadians: BOT_DIFFICULTIES.normal.maximumMissAngleRadians,
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
