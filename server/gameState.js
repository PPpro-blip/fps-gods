import { randomUUID } from 'node:crypto';
import { EVENTS, ROOM_MODES } from '../shared/events.js';
import { CURRENCY_CONFIG } from '../shared/economy.js';
import {
  BOT,
  DEFAULT_BOT_DIFFICULTY,
  getBotDifficultyConfig,
  PLAYER,
  resolveBotDifficulty,
} from '../shared/gameConfig.js';
import { collidesWithCover, simulateMovement } from '../shared/movement.js';
import { getMap, resolveMapId } from '../shared/maps.js';
import { DEFAULT_BUNDLE_ID } from '../shared/bundles.js';
import { castShot, raycastCover } from './hitDetection.js';
import { BUNDLE_IDS, getBundleLoadout, getWeapon, WEAPONS } from './weaponConfig.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapAngle = (angle) => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const finiteNumber = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const MAX_PROJECTILES = 64;

function stepAngleToward(current, desired, maxDelta) {
  const delta = wrapAngle(desired - current);
  if (Math.abs(delta) <= maxDelta) return wrapAngle(desired);
  return wrapAngle(current + Math.sign(delta) * maxDelta);
}

function randomBetween(minimum, maximum) {
  return minimum + Math.random() * Math.max(0, maximum - minimum);
}

function randomIntInclusive(minimum, maximum) {
  const low = Math.ceil(minimum);
  const high = Math.floor(Math.max(low, maximum));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function aimDirection(yaw, pitch) {
  const horizontal = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * horizontal,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * horizontal,
  };
}

function applySpread(direction, spread) {
  if (!spread) return direction;
  const yaw = Math.atan2(-direction.x, -direction.z);
  const pitch = Math.atan2(direction.y, Math.hypot(direction.x, direction.z));
  return aimDirection(
    yaw + (Math.random() * 2 - 1) * spread,
    pitch + (Math.random() * 2 - 1) * spread,
  );
}

// Waypoints are drawn from the room's own arena, so bots never path toward a
// corner that only exists on a different map.
function randomBotWaypoint(map, cover) {
  const { halfWidth, halfDepth, wallThickness } = map.bounds;
  const maxX = halfWidth - wallThickness / 2 - PLAYER.radius - 1;
  const maxZ = halfDepth - wallThickness / 2 - PLAYER.radius - 1;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const waypoint = {
      x: (Math.random() * 2 - 1) * maxX,
      z: (Math.random() * 2 - 1) * maxZ,
    };
    if (!collidesWithCover(waypoint.x, waypoint.z, 0, cover)) return waypoint;
  }
  return { ...map.spawns[Math.floor(Math.random() * map.spawns.length)] };
}

function botWaypointDuration() {
  return BOT.minimumWaypointTimeMs
    + Math.random() * (BOT.maximumWaypointTimeMs - BOT.minimumWaypointTimeMs);
}

/**
 * Find a walkable pocket on the sheltered side of a nearby cover block away
 * from `threat`, so hurt or reloading bots duck behind real cover instead of
 * standing exposed in open lanes. Runs in O(cover.length) with zero allocation
 * pressure at the 10 Hz bot think cadence.
 */
function findShelteredCoverPoint(bot, threat, map, cover) {
  if (!Array.isArray(cover) || cover.length === 0 || !threat) return null;
  const maxX = map.bounds.halfWidth - map.bounds.wallThickness / 2 - PLAYER.radius - 0.6;
  const maxZ = map.bounds.halfDepth - map.bounds.wallThickness / 2 - PLAYER.radius - 0.6;
  let bestPoint = null;
  let bestScore = Infinity;

  for (let i = 0; i < cover.length; i += 1) {
    const block = cover[i];
    if (!block || block.destroyed || block.height < 1.1) continue;
    const distToBot = Math.hypot(block.x - bot.x, block.z - bot.z);
    if (distToBot > 12.5) continue;

    let awayX = block.x - threat.x;
    let awayZ = block.z - threat.z;
    const awayLen = Math.hypot(awayX, awayZ);
    if (awayLen < 0.25) continue;
    awayX /= awayLen;
    awayZ /= awayLen;

    const standOff = Math.max(block.width, block.depth) * 0.5 + PLAYER.radius + 0.65;
    const candX = clamp(block.x + awayX * standOff, -maxX, maxX);
    const candZ = clamp(block.z + awayZ * standOff, -maxZ, maxZ);
    if (collidesWithCover(candX, candZ, 0, cover)) continue;

    const score = distToBot - Math.min(2.2, block.height) * 0.6;
    if (score < bestScore) {
      bestScore = score;
      bestPoint = { x: candX, z: candZ };
    }
  }
  return bestPoint;
}

function createWeaponState(weapon, now) {
  return {
    ammo: weapon.magSize,
    reserveAmmo: weapon.reserveAmmo ?? 0,
    reloadUntil: null,
    nextShotAt: now,
    firingStartedAt: null,
    lastFiredAt: null,
    overheatedUntil: null,
  };
}

function syncActiveWeapon(player, now = Date.now()) {
  const weapon = getWeapon(player.currentWeaponId);
  const state = player.weaponStates?.[player.currentWeaponId];
  if (!weapon || !state) return;

  player.currentWeaponName = weapon.name;
  player.currentWeaponIcon = weapon.icon;
  player.auto = weapon.auto === true;
  player.fireRate = weapon.fireRate;
  player.ammo = state.ammo;
  player.reserveAmmo = state.reserveAmmo;
  player.maxAmmo = weapon.magSize;
  player.totalAmmo = weapon.unlimitedAmmo ? null : state.ammo + state.reserveAmmo;
  player.unlimitedAmmo = weapon.unlimitedAmmo === true;
  player.reloading = state.reloadUntil !== null;
  player.reloadUntil = state.reloadUntil;
  player.nextShotAt = state.nextShotAt;
  player.overheated = state.overheatedUntil !== null && now < state.overheatedUntil;
  player.overheatCompletesAt = state.overheatedUntil;
}

function createBotBrain(spawn, now, map, cover) {
  return {
    waypoint: randomBotWaypoint(map, cover),
    nextWaypointAt: now + botWaypointDuration(),
    stuckThinkCount: 0,
    lastX: spawn.x,
    lastZ: spawn.z,
    targetId: null,
    currentlyVisible: false,
    visibleSince: null,
    lastSeenAt: -Infinity,
    lastKnownX: spawn.x,
    lastKnownZ: spawn.z,
    reactionUntil: 0,
    respawnGraceUntil: 0,
    nextFireAt: now,
    burstRemaining: 0,
    burstCooldownUntil: 0,
    lastTargetSpeed: 0,
    strafeSign: -1,
    nextStrafeFlipAt: now + 1_600,
  };
}

function makeGamePlayer(record, spawn, now, map, cover) {
  const bundleId = record.bundleId ?? DEFAULT_BUNDLE_ID;
  const loadout = getBundleLoadout(bundleId);
  const weaponStates = Object.fromEntries(loadout.map((weapon) => [weapon.id, createWeaponState(weapon, now)]));
  const firstWeaponId = loadout[0].id;
  const currentWeaponId = weaponStates[record.currentWeaponId] ? record.currentWeaponId : firstWeaponId;
  const player = {
    id: record.id,
    profileId: record.profileId ?? null,
    accountId: record.accountId ?? null,
    joinedAt: now,
    lifetimeKills: Math.max(0, Number(record.lifetimeKills) || 0),
    bundleId,
    currentWeaponId,
    weaponStates,
    name: record.name,
    color: record.color,
    isBot: record.isBot === true,
    connected: record.isBot === true || record.connected !== false,
    botBrain: record.isBot === true ? createBotBrain(spawn, now, map, cover) : null,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    knockbackVX: 0,
    knockbackVZ: 0,
    yaw: 0,
    pitch: 0,
    health: PLAYER.maxHealth,
    kills: 0,
    assists: 0,
    deaths: 0,
    alive: true,
    grounded: true,
    ready: record.ready,
    input: { forward: 0, strafe: 0, jump: false },
    pendingJump: false,
    recentDamagers: new Map(),
    healthObservers: new Set(),
    teamId: record.teamId ?? null,
    lastInputAt: now,
    lastInputSequence: -1,
    lastProcessedInputSequence: -1,
    wasJumping: false,
    shieldBlocking: false,
    shieldBlockUntil: 0,
    shieldCooldownUntil: 0,
    shieldNeedsRelease: false,
    spawnProtectionUntil: now + PLAYER.spawnProtectionMs,
    respawnAt: null,
  };
  syncActiveWeapon(player, now);
  return player;
}

// All movement, collision, health, weapon timing, damage, scoring, respawns,
// bundle validation, and win checks live here. Clients provide controls only.
export class GameState {
  constructor(room, {
    emitRoom = () => {},
    emitPlayer = () => {},
    onHumanKill = () => null,
    onElimination = () => null,
    onMatchFinished = () => null,
  } = {}, now = Date.now()) {
    this.room = room;
    this.matchId = randomUUID();
    this.startedAt = now;
    this.killSequence = 0;
    this.mode = room.mode ?? ROOM_MODES.MULTIPLAYER;
    this.botDifficulty = this.mode === ROOM_MODES.SOLO_VS_BOTS
      ? resolveBotDifficulty(room.botDifficulty ?? DEFAULT_BOT_DIFFICULTY)
      : DEFAULT_BOT_DIFFICULTY;
    // The server owns the arena choice. `room.mapId` was already normalised
    // through `resolveMapId` when the room was created; resolving again keeps a
    // hand-built room (tests, recovery) from ever reaching an unknown map.
    this.mapId = resolveMapId(room.mapId);
    this.map = getMap(this.mapId);
    this.emitRoom = emitRoom;
    this.emitPlayer = emitPlayer;
    this.onHumanKill = onHumanKill;
    this.onElimination = onElimination;
    this.onMatchFinished = onMatchFinished;
    this.players = new Map();
    this.feed = [];
    this.finished = false;
    this.winner = null;
    this.lastBotThinkAt = now;
    this.tickSequence = 0;
    this.cover = this.map.cover.map((block, id) => ({ ...block, id }));
    this.smokeClouds = [];
    this.smokeSequence = 0;
    this.projectiles = [];
    this.projectileSequence = 0;

    const records = [...room.players.values()];
    if (this.mode === ROOM_MODES.SOLO_VS_BOTS) {
      const preset = getBotDifficultyConfig(this.botDifficulty);
      const allowedBundles = preset.allowedBundles?.length
        ? preset.allowedBundles.filter((id) => BUNDLE_IDS.includes(id))
        : BUNDLE_IDS.filter((id) => id !== 'GODS_TIER');
      const botColors = ['#ff9858', '#ff647c', '#b18cff', '#ffc857', '#ff72cc'];
      for (let index = 1; index <= BOT.count; index += 1) {
        const name = `GOD_BOT_${String(index).padStart(2, '0')}`;
        records.push({
          id: `bot-${name}`,
          name,
          color: botColors[index - 1],
          ready: true,
          isBot: true,
          bundleId: allowedBundles[(index - 1) % allowedBundles.length],
        });
      }
    }

    const spawns = shuffled(this.map.spawns);
    records.forEach((record, index) => {
      const spawn = spawns[index % spawns.length];
      this.players.set(record.id, makeGamePlayer(record, spawn, now, this.map, this.cover));
    });
  }

  setInput(playerId, payload, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !player.connected || !payload || typeof payload !== 'object') return;
    if (Number.isSafeInteger(payload.seq) && payload.seq <= player.lastInputSequence) return;
    if (Number.isSafeInteger(payload.seq)) player.lastInputSequence = payload.seq;

    player.yaw = wrapAngle(finiteNumber(payload.yaw, player.yaw));
    player.pitch = clamp(finiteNumber(payload.pitch, player.pitch), -1.45, 1.45);
    player.input = {
      forward: clamp(finiteNumber(payload.forward, 0), -1, 1),
      strafe: clamp(finiteNumber(payload.strafe, 0), -1, 1),
      jump: payload.jump === true,
    };
    if (payload.jump === true && player.alive) {
      player.pendingJump = true;
    }
    player.lastInputAt = now;
    this.updateShieldInput(player, payload.blocking === true, now);
  }

  updateShieldInput(player, requested, now) {
    const shield = getWeapon(player.currentWeaponId);
    const eligible = player.connected && player.alive && shield?.behavior === 'shield';
    if (!requested || !eligible) {
      if (player.shieldBlocking) {
        player.shieldBlocking = false;
        player.shieldCooldownUntil = now + (shield?.blockCooldownMs ?? 900);
      }
      if (!requested) player.shieldNeedsRelease = false;
      return;
    }
    if (player.shieldBlocking && now >= player.shieldBlockUntil) {
      player.shieldBlocking = false;
      player.shieldNeedsRelease = true;
      player.shieldCooldownUntil = now + shield.blockCooldownMs;
    }
    if (!player.shieldBlocking && !player.shieldNeedsRelease) {
      if (now < player.shieldCooldownUntil) {
        // Holding a failed early press must not silently re-raise later.
        player.shieldNeedsRelease = true;
      } else {
        player.shieldBlocking = true;
        player.shieldBlockUntil = now + shield.blockDurationMs;
      }
    }
  }

  getBotPreset() {
    return getBotDifficultyConfig(this.botDifficulty);
  }

  setBotDifficulty(nextDifficulty, now = Date.now()) {
    if (this.mode !== ROOM_MODES.SOLO_VS_BOTS) return false;
    const resolved = resolveBotDifficulty(nextDifficulty);
    this.botDifficulty = resolved;
    if (this.room) this.room.botDifficulty = resolved;
    const preset = getBotDifficultyConfig(resolved);
    for (const player of this.players.values()) {
      if (!player.isBot || !player.botBrain) continue;
      const brain = player.botBrain;
      brain.burstRemaining = Math.min(brain.burstRemaining, preset.burstShotsMax);
      if (brain.currentlyVisible && brain.visibleSince !== null) {
        brain.reactionUntil = Math.max(
          now,
          brain.visibleSince + randomBetween(preset.reactionMinMs, preset.reactionMaxMs),
        );
      } else {
        brain.reactionUntil = 0;
      }
    }
    return true;
  }

  hasBotLineOfSight(bot, target, aimY = target.y + PLAYER.height * 0.6) {
    const origin = { x: bot.x, y: bot.y + PLAYER.eyeHeight, z: bot.z };
    const dx = target.x - origin.x;
    const dy = aimY - origin.y;
    const dz = target.z - origin.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 1e-4) return true;
    const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
    const blockedCover = raycastCover({
      origin,
      direction,
      maxDistance: distance,
      cover: this.cover,
    });
    if (blockedCover && blockedCover.distance < distance - 0.15) return false;

    for (const cloud of this.smokeClouds) {
      const toCloudX = cloud.x - origin.x;
      const toCloudY = (cloud.y ?? 1.2) - origin.y;
      const toCloudZ = cloud.z - origin.z;
      const along = toCloudX * direction.x + toCloudY * direction.y + toCloudZ * direction.z;
      if (along <= 0 || along >= distance) continue;
      const closestX = origin.x + direction.x * along - cloud.x;
      const closestY = origin.y + direction.y * along - (cloud.y ?? 1.2);
      const closestZ = origin.z + direction.z * along - cloud.z;
      const radius = (cloud.radius ?? 4.2) * 0.88;
      if (closestX * closestX + closestY * closestY + closestZ * closestZ <= radius * radius) {
        return false;
      }
    }
    return true;
  }

  ensureBotCombatWeapon(bot, targetDistance, now) {
    const current = getWeapon(bot.currentWeaponId);
    const currentState = bot.weaponStates?.[bot.currentWeaponId];
    const currentUsable = current
      && current.behavior !== 'shield'
      && current.behavior !== 'smoke'
      && (current.range >= Math.max(4, targetDistance - 0.5))
      && (current.unlimitedAmmo || (currentState?.ammo ?? 0) + (currentState?.reserveAmmo ?? 0) > 0);
    if (currentUsable) return current;

    for (const [weaponId, state] of Object.entries(bot.weaponStates ?? {})) {
      const candidate = getWeapon(weaponId);
      if (!candidate || candidate.behavior === 'shield' || candidate.behavior === 'smoke') continue;
      const hasAmmo = candidate.unlimitedAmmo || (state.ammo + state.reserveAmmo) > 0;
      if (!hasAmmo) continue;
      if (candidate.range >= Math.max(4, targetDistance - 0.5)) {
        this.switchWeapon(bot.id, weaponId, now);
        return candidate;
      }
    }
    return current;
  }

  update(deltaSeconds, now = Date.now()) {
    if (this.finished) return { winner: this.winner };
    const delta = clamp(finiteNumber(deltaSeconds, 0), 0, 0.1);
    this.tickSequence += 1;
    if (this.mode === ROOM_MODES.SOLO_VS_BOTS && now - this.lastBotThinkAt >= BOT.thinkIntervalMs) {
      const thinkElapsedMs = now - this.lastBotThinkAt;
      this.lastBotThinkAt = now;
      this.updateBots(now, thinkElapsedMs);
    }

    const previousSmokeCount = this.smokeClouds.length;
    this.smokeClouds = this.smokeClouds.filter((cloud) => cloud.expiresAt > now);
    if (this.smokeClouds.length !== previousSmokeCount) this.emitSmokeState();

    for (const player of this.players.values()) {
      if (!player.connected) {
        player.input.forward = 0;
        player.input.strafe = 0;
        player.input.jump = false;
        player.vx = 0;
        player.vy = 0;
        player.vz = 0;
        continue;
      }
      if (!player.alive) {
        if (player.respawnAt !== null && now >= player.respawnAt) this.respawn(player, now);
        else if (delta > 0 && (Math.abs(player.knockbackVX) + Math.abs(player.knockbackVZ) > 0.05)) {
          this.updateDeadKnockback(player, delta);
        }
        continue;
      }
      if (!player.isBot && now - player.lastInputAt > PLAYER.inputTimeoutMs) {
        player.input.forward = 0;
        player.input.strafe = 0;
        player.input.jump = false;
        this.updateShieldInput(player, false, now);
      }
      if (player.shieldBlocking && now >= player.shieldBlockUntil) {
        this.updateShieldInput(player, true, now);
      }
      this.updatePlayer(player, delta);
      if (delta > 0) player.lastProcessedInputSequence = player.lastInputSequence;
      this.updateWeaponTimers(player, now);
    }
    this.updateProjectiles(delta, now);

    return null;
  }

  updateWeaponTimers(player, now) {
    for (const [weaponId, state] of Object.entries(player.weaponStates)) {
      const weapon = WEAPONS[weaponId];
      if (state.reloadUntil !== null && now >= state.reloadUntil) {
        const missing = Math.max(0, weapon.magSize - state.ammo);
        const transferred = Math.min(missing, state.reserveAmmo);
        state.ammo += transferred;
        state.reserveAmmo -= transferred;
        state.reloadUntil = null;
        if (weaponId === player.currentWeaponId) this.sendAmmo(player, now);
      }
      if (weapon.unlimitedAmmo && state.lastFiredAt !== null
        && now - state.lastFiredAt > Math.max(250, weapon.fireRate * 3)) {
        state.firingStartedAt = null;
        state.lastFiredAt = null;
      }
      if (weaponId === player.currentWeaponId) syncActiveWeapon(player, now);
    }
  }

  updateBots(now, thinkElapsedMs = BOT.thinkIntervalMs) {
    const preset = this.getBotPreset();
    const thinkDelta = clamp(finiteNumber(thinkElapsedMs, BOT.thinkIntervalMs) / 1_000, 0.02, 0.25);
    const humanPlayers = [...this.players.values()].filter((player) => !player.isBot && player.connected && player.alive);
    const humanTargets = new Map(humanPlayers.map((player) => [player.id, player]));
    const fireIntents = [];

    for (const bot of this.players.values()) {
      if (!bot.isBot || !bot.alive) continue;
      const brain = bot.botBrain;
      const distanceToWaypoint = brain.waypoint
        ? Math.hypot(brain.waypoint.x - bot.x, brain.waypoint.z - bot.z)
        : Infinity;
      const moved = Math.hypot(bot.x - brain.lastX, bot.z - brain.lastZ);
      if ((Math.abs(bot.input.forward) > 0.05 || Math.abs(bot.input.strafe) > 0.05) && moved < 0.05) {
        brain.stuckThinkCount += 1;
      } else {
        brain.stuckThinkCount = 0;
      }
      brain.lastX = bot.x;
      brain.lastZ = bot.z;

      if (!brain.waypoint
        || distanceToWaypoint <= BOT.waypointReachDistance
        || now >= brain.nextWaypointAt
        || brain.stuckThinkCount >= BOT.stuckThinkCount) {
        brain.waypoint = randomBotWaypoint(this.map, this.cover);
        brain.nextWaypointAt = now + botWaypointDuration();
        brain.stuckThinkCount = 0;
      }

      const inRespawnGrace = now < (brain.respawnGraceUntil ?? 0);
      let chosen = null;
      if (!inRespawnGrace && humanPlayers.length > 0) {
        for (const candidate of humanPlayers) {
          const dx = candidate.x - bot.x;
          const dz = candidate.z - bot.z;
          const distance = Math.hypot(dx, dz);
          const bearingYaw = wrapAngle(Math.atan2(-dx, -dz));
          const angleOffBow = Math.abs(wrapAngle(bearingYaw - bot.yaw));
          const withinAwareness = distance <= preset.hearingRadius
            || angleOffBow <= preset.visionHalfAngleRad
            || brain.targetId === candidate.id;
          if (!withinAwareness) continue;

          const torsoY = candidate.y + PLAYER.height * preset.aimHeightRatio;
          if (!this.hasBotLineOfSight(bot, candidate, torsoY)) continue;

          const switchPenalty = brain.targetId && brain.targetId !== candidate.id ? 2.5 : 0;
          const score = distance + switchPenalty;
          if (!chosen || score < chosen.score) {
            chosen = { player: candidate, distance, score, torsoY };
          }
        }
      }

      if (chosen) {
        const target = chosen.player;
        const targetChanged = brain.targetId !== target.id;
        const reacquiredAfterLoss = !brain.currentlyVisible
          && (now - brain.lastSeenAt > preset.targetMemoryMs || brain.visibleSince === null);

        if (targetChanged || reacquiredAfterLoss) {
          const baseDelay = randomBetween(preset.reactionMinMs, preset.reactionMaxMs);
          const spawnSafeAt = (target.spawnProtectionUntil ?? 0) > now
            ? target.spawnProtectionUntil + baseDelay * 0.4
            : now;
          brain.visibleSince = now;
          brain.reactionUntil = Math.max(now + baseDelay, spawnSafeAt);
          brain.burstRemaining = 0;
        } else if ((target.spawnProtectionUntil ?? 0) > now) {
          brain.reactionUntil = Math.max(
            brain.reactionUntil,
            target.spawnProtectionUntil + preset.reactionMinMs * 0.35,
          );
        }

        brain.targetId = target.id;
        brain.currentlyVisible = true;
        brain.lastSeenAt = now;
        brain.lastKnownX = target.x;
        brain.lastKnownZ = target.z;
        brain.lastTargetSpeed = Math.hypot(target.vx ?? 0, target.vz ?? 0) + Math.abs(target.vy ?? 0) * 0.5;

        // Track torso center-of-mass with human-like velocity lag so strafing and
        // jumping players genuinely reduce incoming accuracy.
        const laggedX = target.x - (target.vx ?? 0) * preset.trackingLagSeconds;
        const laggedZ = target.z - (target.vz ?? 0) * preset.trackingLagSeconds;
        const laggedY = chosen.torsoY - (target.vy ?? 0) * (preset.trackingLagSeconds * 0.6);
        const deltaX = laggedX - bot.x;
        const deltaZ = laggedZ - bot.z;
        const horizontalDistance = Math.max(0.001, Math.hypot(deltaX, deltaZ));
        const desiredYaw = wrapAngle(Math.atan2(-deltaX, -deltaZ));
        const desiredPitch = clamp(
          Math.atan2(laggedY - (bot.y + PLAYER.eyeHeight), horizontalDistance),
          -1.45,
          1.45,
        );

        bot.yaw = stepAngleToward(bot.yaw, desiredYaw, preset.turnSpeedRadPerSec * thinkDelta);
        bot.pitch = clamp(
          bot.pitch + clamp(
            desiredPitch - bot.pitch,
            -preset.pitchSpeedRadPerSec * thinkDelta,
            preset.pitchSpeedRadPerSec * thinkDelta,
          ),
          -1.45,
          1.45,
        );

        const weapon = this.ensureBotCombatWeapon(bot, chosen.distance, now);
        const forwardX = -Math.sin(bot.yaw);
        const forwardZ = -Math.cos(bot.yaw);
        const rightX = Math.cos(bot.yaw);
        const rightZ = -Math.sin(bot.yaw);

        // Tactical positioning: hurt, reloading, or burst-pausing bots seek the
        // sheltered side of nearby cover; otherwise they space according to
        // weapon role and weave laterally instead of clumping or freezing.
        const needsShelter = Boolean(bot.reloading)
          || bot.health <= Math.max(35, preset.retreatHealthThreshold)
          || (now < brain.burstCooldownUntil && preset.id !== 'easy');
        const shelterPoint = needsShelter
          ? findShelteredCoverPoint(bot, target, this.map, this.cover)
          : null;

        let forwardIntent = 0;
        let strafeIntent = 0;

        if (shelterPoint) {
          const sx = shelterPoint.x - bot.x;
          const sz = shelterPoint.z - bot.z;
          const sDist = Math.hypot(sx, sz);
          if (sDist > 0.45) {
            const nx = sx / sDist;
            const nz = sz / sDist;
            forwardIntent = nx * forwardX + nz * forwardZ;
            strafeIntent = nx * rightX + nz * rightZ;
          }
        } else {
          const toWaypointX = brain.waypoint.x - bot.x;
          const toWaypointZ = brain.waypoint.z - bot.z;
          const waypointDistance = Math.hypot(toWaypointX, toWaypointZ);
          const desiredX = waypointDistance > BOT.waypointReachDistance ? toWaypointX / waypointDistance : 0;
          const desiredZ = waypointDistance > BOT.waypointReachDistance ? toWaypointZ / waypointDistance : 0;
          forwardIntent = (desiredX * forwardX + desiredZ * forwardZ) * 0.35;
          strafeIntent = (desiredX * rightX + desiredZ * rightZ) * 0.35;

          if (now >= brain.nextStrafeFlipAt) {
            brain.strafeSign *= -1;
            brain.nextStrafeFlipAt = now + randomBetween(1_250, 2_350);
          }
          if (Math.abs(strafeIntent) < 0.28) {
            strafeIntent = brain.strafeSign * preset.strafeStrength;
          }

          const wid = weapon?.id ?? bot.currentWeaponId;
          const closeRole = wid === 'SHOTGUN' || wid === 'KNIFE' || wid === 'GOD_FIST';
          const longRole = wid === 'SNIPER' || wid === 'RAILGUN' || wid === 'LMG';
          const minRange = closeRole
            ? 3.8
            : (longRole ? Math.max(10.5, preset.preferredMinRange) : preset.preferredMinRange * 0.78);
          const maxRange = closeRole
            ? 8.8
            : (longRole ? Math.max(19.5, preset.preferredMaxRange) : preset.preferredMaxRange);

          if (bot.health <= preset.retreatHealthThreshold || chosen.distance < minRange) {
            forwardIntent = Math.min(forwardIntent, -0.58);
          } else if (chosen.distance > maxRange) {
            forwardIntent = Math.max(forwardIntent, closeRole ? 0.82 : 0.70);
          }
        }

        // Keep bots from stacking onto the exact same coordinate in multi-bot lanes.
        for (const peer of this.players.values()) {
          if (!peer.isBot || !peer.alive || peer.id === bot.id) continue;
          const px = bot.x - peer.x;
          const pz = bot.z - peer.z;
          const pDist = Math.hypot(px, pz);
          if (pDist > 0.01 && pDist < 2.3) {
            const push = ((2.3 - pDist) / 2.3) * 0.55;
            forwardIntent += (px / pDist) * forwardX * push + (pz / pDist) * forwardZ * push;
            strafeIntent += (px / pDist) * rightX * push + (pz / pDist) * rightZ * push;
          }
        }

        bot.input.forward = clamp(forwardIntent, -1, 1);
        bot.input.strafe = clamp(strafeIntent, -1, 1);
        bot.input.jump = false;
        bot.lastInputAt = now;

        if (!weapon || weapon.behavior === 'shield' || weapon.behavior === 'smoke') continue;
        if (chosen.distance > weapon.range) continue;

        const aimError = Math.abs(wrapAngle(desiredYaw - bot.yaw));
        const spawnProtected = now < (target.spawnProtectionUntil ?? 0);
        const reactionComplete = now >= brain.reactionUntil;
        const cadenceReady = now >= brain.nextFireAt && now >= brain.burstCooldownUntil;
        if (!spawnProtected && reactionComplete && cadenceReady && aimError <= preset.fireConeRad) {
          fireIntents.push({ bot, target, weapon, distance: chosen.distance });
        }
        continue;
      }

      // No currently visible target: lose visual lock cleanly and patrol or check
      // brief memory of last known position without snapping through walls.
      brain.currentlyVisible = false;
      brain.lastTargetSpeed = 0;
      if (brain.targetId && now - brain.lastSeenAt > preset.targetMemoryMs) {
        brain.targetId = null;
        brain.visibleSince = null;
        brain.burstRemaining = 0;
      }

      const navX = (brain.targetId && now - brain.lastSeenAt <= preset.targetMemoryMs)
        ? brain.lastKnownX
        : brain.waypoint.x;
      const navZ = (brain.targetId && now - brain.lastSeenAt <= preset.targetMemoryMs)
        ? brain.lastKnownZ
        : brain.waypoint.z;
      const toNavX = navX - bot.x;
      const toNavZ = navZ - bot.z;
      const navDistance = Math.hypot(toNavX, toNavZ);
      if (navDistance > 0.05) {
        const patrolYaw = wrapAngle(Math.atan2(-toNavX, -toNavZ));
        bot.yaw = stepAngleToward(bot.yaw, patrolYaw, preset.patrolTurnSpeedRadPerSec * thinkDelta);
      }
      bot.pitch = clamp(bot.pitch * 0.7, -1.45, 1.45);
      if (Math.abs(bot.pitch) < 0.01) bot.pitch = 0;

      const desiredX = navDistance > BOT.waypointReachDistance ? toNavX / navDistance : 0;
      const desiredZ = navDistance > BOT.waypointReachDistance ? toNavZ / navDistance : 0;
      const forwardX = -Math.sin(bot.yaw);
      const forwardZ = -Math.cos(bot.yaw);
      const rightX = Math.cos(bot.yaw);
      const rightZ = -Math.sin(bot.yaw);
      bot.input.forward = clamp(desiredX * forwardX + desiredZ * forwardZ, -1, 1);
      bot.input.strafe = clamp(desiredX * rightX + desiredZ * rightZ, -1, 1);
      bot.input.jump = false;
      bot.lastInputAt = now;
    }

    // Cap coordinated simultaneous focus fire against any single player per preset.
    fireIntents.sort((left, right) => left.distance - right.distance);
    const activeAttackersByTarget = new Map();
    for (const intent of fireIntents) {
      const count = activeAttackersByTarget.get(intent.target.id) ?? 0;
      if (count >= preset.maxSimultaneousAttackers) continue;

      const { bot, target, weapon } = intent;
      const visibleShot = castShot({
        origin: { x: bot.x, y: bot.y + PLAYER.eyeHeight, z: bot.z },
        direction: aimDirection(bot.yaw, bot.pitch),
        players: humanTargets,
        shooterId: bot.id,
        maxDistance: weapon.range,
        cover: this.cover,
        smokeClouds: this.smokeClouds,
        ignoreCover: false,
      });
      // Allow firing when either the direct aim ray hits the visible target or
      // clear line-of-sight is confirmed (so torso/lagged aim near target edge still fires).
      if (visibleShot?.hitType === 'cover') continue;
      if (visibleShot?.target && visibleShot.target.id !== target.id) continue;

      activeAttackersByTarget.set(target.id, count + 1);
      const brain = bot.botBrain;
      if (brain.burstRemaining <= 0) {
        brain.burstRemaining = randomIntInclusive(preset.burstShotsMin, preset.burstShotsMax);
      }
      this.shoot(bot.id, now);
      brain.nextFireAt = now + Math.round(weapon.fireRate * preset.fireIntervalMultiplier);
      brain.burstRemaining -= 1;
      if (brain.burstRemaining <= 0) {
        brain.burstCooldownUntil = now + randomBetween(preset.burstCooldownMinMs, preset.burstCooldownMaxMs);
      }
    }
  }

  updatePlayer(player, delta) {
    if (player.pendingJump) {
      const heldJump = player.input.jump;
      player.input.jump = true;
      player.pendingJump = false;
      simulateMovement(player, delta, this.map, this.cover);
      player.input.jump = heldJump;
      return;
    }
    simulateMovement(player, delta, this.map, this.cover);
  }

  updateDeadKnockback(player, delta) {
    const startX = player.x;
    const startZ = player.z;
    const maxCenterX = this.map.bounds.halfWidth - this.map.bounds.wallThickness / 2 - PLAYER.radius;
    const maxCenterZ = this.map.bounds.halfDepth - this.map.bounds.wallThickness / 2 - PLAYER.radius;
    const candidateX = clamp(player.x + player.knockbackVX * delta, -maxCenterX, maxCenterX);
    const candidateZ = clamp(player.z + player.knockbackVZ * delta, -maxCenterZ, maxCenterZ);
    if (!collidesWithCover(candidateX, player.z, player.y, this.cover)) player.x = candidateX;
    else player.knockbackVX = 0;
    if (!collidesWithCover(player.x, candidateZ, player.y, this.cover)) player.z = candidateZ;
    else player.knockbackVZ = 0;
    player.knockbackVX *= Math.exp(-7.5 * delta);
    player.knockbackVZ *= Math.exp(-7.5 * delta);
    player.vy -= PLAYER.gravity * delta;
    player.y = Math.max(0, player.y + player.vy * delta);
    if (player.y === 0 && player.vy < 0) player.vy = 0;
    player.vx = (player.x - startX) / delta;
    player.vz = (player.z - startZ) / delta;
  }

  switchWeapon(playerId, weaponId, now = Date.now()) {
    if (this.finished || typeof weaponId !== 'string') return false;
    const player = this.players.get(playerId);
    if (!player || !player.connected || !player.alive || !Object.hasOwn(player.weaponStates, weaponId) || !getWeapon(weaponId)) return false;
    if (player.currentWeaponId === weaponId) return true;

    this.updateShieldInput(player, false, now);
    player.shieldNeedsRelease = false;
    player.currentWeaponId = weaponId;
    syncActiveWeapon(player, now);
    const data = {
      playerId: player.id,
      bundleId: player.bundleId,
      weaponId,
      weaponName: player.currentWeaponName,
      weaponIcon: player.currentWeaponIcon,
      auto: player.auto,
      fireRate: player.fireRate,
    };
    this.emitRoom(EVENTS.WEAPON_UPDATE, data);
    this.sendAmmo(player, now);
    return true;
  }

  shoot(playerId, now = Date.now(), shotId = null) {
    if (this.finished) return;
    const shooter = this.players.get(playerId);
    if (!shooter || !shooter.connected || !shooter.alive) return;
    const weapon = getWeapon(shooter.currentWeaponId);
    const weaponState = shooter.weaponStates[shooter.currentWeaponId];
    if (!weapon || !weaponState || weapon.behavior === 'shield') return;
    if (weapon.behavior === 'rocket' && this.projectiles.length >= MAX_PROJECTILES) return;

    if (weapon.unlimitedAmmo) {
      if (weaponState.overheatedUntil !== null && now < weaponState.overheatedUntil) return;
      if (weaponState.overheatedUntil !== null && now >= weaponState.overheatedUntil) {
        weaponState.overheatedUntil = null;
      }
      const fireGap = Math.max(250, weapon.fireRate * 3);
      if (weaponState.lastFiredAt === null || now - weaponState.lastFiredAt > fireGap) {
        weaponState.firingStartedAt = now;
      }
      if (weaponState.firingStartedAt !== null && now - weaponState.firingStartedAt >= weapon.overheatsAfterMs) {
        weaponState.firingStartedAt = null;
        weaponState.lastFiredAt = null;
        weaponState.overheatedUntil = now + weapon.overheatCooldownMs;
        syncActiveWeapon(shooter, now);
        this.sendAmmo(shooter, now);
        this.emitPlayer(shooter.id, EVENTS.WEAPON_OVERHEATED, {
          weaponId: weapon.id,
          completesAt: weaponState.overheatedUntil,
        });
        return;
      }
    }

    if (weaponState.reloadUntil !== null || now < weaponState.nextShotAt) return;
    if (!weapon.unlimitedAmmo && weapon.magSize > 0 && weaponState.ammo <= 0) {
      this.reload(playerId, now);
      return;
    }

    weaponState.nextShotAt = now + weapon.fireRate;
    if (!weapon.unlimitedAmmo && weapon.magSize > 0) {
      weaponState.ammo = Math.max(0, weaponState.ammo - 1);
      if (weaponState.ammo === 0 && weaponState.reserveAmmo > 0) {
        weaponState.reloadUntil = now + weapon.reloadTime;
      }
    }
    if (weapon.unlimitedAmmo) weaponState.lastFiredAt = now;
    syncActiveWeapon(shooter, now);
    this.sendAmmo(shooter, now);

    const origin = { x: shooter.x, y: shooter.y + PLAYER.eyeHeight, z: shooter.z };
    let direction = aimDirection(shooter.yaw, shooter.pitch);
    if (shooter.isBot) {
      const preset = this.getBotPreset();
      if (Math.random() < preset.missChance) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const missAngle = preset.minimumMissAngleRadians
          + Math.random() * (preset.maximumMissAngleRadians - preset.minimumMissAngleRadians);
        direction = aimDirection(wrapAngle(shooter.yaw + side * missAngle), shooter.pitch);
      } else {
        const targetSpeed = shooter.botBrain?.lastTargetSpeed ?? 0;
        const movingFactor = clamp(targetSpeed / PLAYER.moveSpeed, 0, 1.35);
        const jitterSpan = preset.aimJitterRad + movingFactor * preset.movingTargetSpreadRad;
        const yawJitter = (Math.random() * 2 - 1) * jitterSpan;
        const pitchJitter = (Math.random() * 2 - 1) * (jitterSpan * 0.65);
        direction = aimDirection(
          wrapAngle(shooter.yaw + yawJitter),
          clamp(shooter.pitch + pitchJitter, -1.45, 1.45),
        );
      }
    }

    this.emitRoom(EVENTS.WEAPON_FIRED, {
      playerId: shooter.id,
      weaponId: weapon.id,
      bundleId: shooter.bundleId,
      origin,
      direction,
      ...(Number.isSafeInteger(shotId) && shotId >= 0 ? { shotId } : {}),
    });

    if (weapon.behavior === 'smoke') {
      this.throwSmoke(shooter, weapon, origin, applySpread(direction, weapon.spread), now);
      return;
    }
    if (weapon.behavior === 'rocket') {
      this.fireRocket(shooter, weapon, origin, applySpread(direction, weapon.spread), now);
      return;
    }

    const players = shooter.isBot
      ? new Map([...this.players].filter(([, player]) => !player.isBot))
      : this.players;
    this.fireHitscan(shooter, weapon, origin, direction, players, now);
  }

  fireHitscan(shooter, weapon, origin, direction, players, now) {
    const hits = new Map();
    const pellets = weapon.pellets ?? 1;
    for (let pellet = 0; pellet < pellets; pellet += 1) {
      const ray = applySpread(direction, weapon.spread);
      const result = castShot({
        origin,
        direction: ray,
        players,
        shooterId: shooter.id,
        maxDistance: weapon.range,
        cover: this.cover,
        smokeClouds: this.smokeClouds,
        ignoreCover: weapon.piercesCover === true && !shooter.isBot,
      });
      if (!result) continue;
      const damage = result.headshot
        ? (weapon.headshotDamage ?? weapon.damage * (weapon.headshotMultiplier ?? 1))
        : weapon.damage;
      const existing = hits.get(result.target.id) ?? {
        target: result.target,
        damage: 0,
        headshot: false,
        point: result.point,
      };
      existing.damage += damage;
      existing.headshot ||= result.headshot;
      existing.point = result.point;
      hits.set(result.target.id, existing);
    }

    if (hits.size === 0) {
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false, weaponId: weapon.id });
      return;
    }
    this.applyDamageBatch(shooter, [...hits.values()], now, weapon);
  }

  fireRocket(shooter, weapon, origin, direction, now) {
    // A projectile is created only after shoot() has validated the equipped
    // weapon, ammo and cooldown. No client-provided position is accepted.
    this.projectiles.push({
      id: `${shooter.id}-${this.projectileSequence++}`,
      ownerId: shooter.id,
      weaponId: weapon.id,
      x: origin.x, y: origin.y, z: origin.z,
      direction, source: { ...origin },
      travelled: 0,
      expiresAt: now + weapon.projectileLifetimeMs,
    });
  }

  updateProjectiles(delta, now) {
    const remaining = [];
    for (const projectile of this.projectiles) {
      const weapon = getWeapon(projectile.weaponId);
      const shooter = this.players.get(projectile.ownerId);
      if (!weapon || !shooter || this.finished) continue;
      const origin = { x: projectile.x, y: projectile.y, z: projectile.z };
      const travel = Math.min(weapon.projectileSpeed * delta, weapon.range - projectile.travelled);
      if (travel > 0) {
        const coverHit = raycastCover({ origin, direction: projectile.direction, cover: this.cover, maxDistance: travel });
        const targets = shooter.isBot
          ? new Map([...this.players].filter(([, player]) => !player.isBot))
          : this.players;
        const directHit = castShot({
          origin, direction: projectile.direction, players: targets, shooterId: shooter.id,
          cover: this.cover, smokeClouds: [], maxDistance: travel,
        });
        const wallHit = this.projectileWallHit(origin, projectile.direction, travel);
        let hit = coverHit;
        if (wallHit && (!hit || wallHit.distance < hit.distance)) hit = wallHit;
        if (directHit && (!hit || directHit.distance < hit.distance)) hit = directHit;
        if (hit) {
          this.explodeRocket(projectile, shooter, weapon, hit, now);
          continue;
        }
        projectile.x += projectile.direction.x * travel;
        projectile.y += projectile.direction.y * travel;
        projectile.z += projectile.direction.z * travel;
        projectile.travelled += travel;
      }
      if (now >= projectile.expiresAt || projectile.travelled >= weapon.range - 1e-6) {
        this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false, weaponId: weapon.id });
        continue; // Misses expire harmlessly, without a client-chosen explosion.
      }
      remaining.push(projectile);
    }
    this.projectiles = remaining;
  }

  projectileWallHit(origin, direction, maxDistance) {
    const bounds = this.map.bounds;
    const maxX = bounds.halfWidth - bounds.wallThickness / 2;
    const maxZ = bounds.halfDepth - bounds.wallThickness / 2;
    let distance = Infinity;
    for (const [position, velocity, limit] of [[origin.x, direction.x, maxX], [origin.z, direction.z, maxZ]]) {
      if (Math.abs(velocity) < 1e-8) continue;
      const candidate = ((velocity > 0 ? limit : -limit) - position) / velocity;
      if (candidate >= 0 && candidate <= maxDistance) distance = Math.min(distance, candidate);
    }
    if (!Number.isFinite(distance)) return null;
    return { distance, point: {
      x: origin.x + direction.x * distance,
      y: origin.y + direction.y * distance,
      z: origin.z + direction.z * distance,
    } };
  }

  explodeRocket(projectile, shooter, weapon, impact, now) {
    const point = impact.point;
    this.emitRoom(EVENTS.PROJECTILE_IMPACT, { id: projectile.id, point, radius: weapon.splashRadius });
    const hits = [];
    for (const target of this.players.values()) {
      if (target.id === shooter.id || !target.connected || !target.alive || (shooter.isBot && target.isBot)) continue;
      const toTarget = { x: target.x - point.x, y: target.y + PLAYER.height / 2 - point.y, z: target.z - point.z };
      const distance = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
      if (distance > weapon.splashRadius) continue;
      const direct = impact.target?.id === target.id;
      if (!direct && distance > 0.02) {
        const direction = { x: toTarget.x / distance, y: toTarget.y / distance, z: toTarget.z / distance };
        const start = { x: point.x + direction.x * 0.02, y: point.y + direction.y * 0.02, z: point.z + direction.z * 0.02 };
        const obstruction = raycastCover({ origin: start, direction, cover: this.cover, maxDistance: distance - 0.02, includeFloor: false });
        if (obstruction) continue;
      }
      const splash = weapon.splashDamage * Math.max(0, 1 - distance / weapon.splashRadius);
      const damage = direct ? Math.max(weapon.damage, splash) : splash;
      // A blast reaches the shield from the impact, not from where its owner
      // happened to stand when the rocket launched.
      if (damage > 0) hits.push({ target, damage, headshot: false, point, source: point });
    }
    if (hits.length) this.applyDamageBatch(shooter, hits, now, weapon);
    else this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false, weaponId: weapon.id });
    // Apply blast line-of-sight before removing the struck cover.
    if (impact.block && weapon.destroysCover) this.destroyCover(impact.block);
  }

  throwSmoke(shooter, weapon, origin, direction, now) {
    const impact = raycastCover({
      origin,
      direction,
      cover: this.cover,
      maxDistance: weapon.range,
      includeFloor: false,
    });
    const distance = impact?.distance ?? weapon.range;
    const { halfWidth, halfDepth } = this.map.bounds;
    const x = clamp(origin.x + direction.x * distance, -halfWidth + 1, halfWidth - 1);
    const z = clamp(origin.z + direction.z * distance, -halfDepth + 1, halfDepth - 1);
    const cloud = {
      id: `${shooter.id}-${now}-${this.smokeSequence++}`,
      x,
      y: weapon.smokeRadius * 0.46,
      z,
      radius: weapon.smokeRadius,
      expiresAt: now + weapon.smokeDuration,
      ownerId: shooter.id,
    };
    this.smokeClouds.push(cloud);
    this.emitSmokeState();
  }

  emitSmokeState() {
    this.emitRoom(EVENTS.SMOKE_UPDATE, { smokeClouds: this.smokeClouds.map((cloud) => ({ ...cloud })) });
  }

  destroyCover(block) {
    const blockIndex = this.cover.findIndex((candidate) => candidate.id === block.id);
    if (blockIndex < 0) return;
    this.cover.splice(blockIndex, 1);
    this.emitRoom(EVENTS.COVER_DESTROYED, { blockId: block.id });
  }

  applyDamageBatch(shooter, hits, now, weapon) {
    for (const hit of hits) {
      const target = hit.target;
      if (!target.alive) continue;
      const protectedAtSpawn = now < target.spawnProtectionUntil;
      const blockedByShield = this.isFrontalShieldBlock(target, hit.source ?? shooter, hit.point, now);
      const multiplier = blockedByShield ? getWeapon(target.currentWeaponId).damageMultiplier : 1;
      const damage = protectedAtSpawn ? 0 : hit.damage * multiplier;
      const appliedDamage = Math.min(target.health, damage);
      if (damage > 0) target.health = Math.max(0, target.health - damage);

      const killed = damage > 0 && target.health === 0;
      const opponents = shooter.id !== target.id && !(shooter.teamId != null && shooter.teamId === target.teamId);
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
        hit: true,
        targetId: target.id,
        weaponId: weapon.id,
        damage: appliedDamage,
        opponent: opponents,
        headshot: hit.headshot,
        protected: protectedAtSpawn,
        blockedByShield,
        killed,
        point: hit.point,
      });

      if (damage > 0) {
        if (opponents && !shooter.isBot) target.healthObservers.add(shooter.id);
        for (const observerId of target.healthObservers) {
          const observer = this.players.get(observerId);
          if (observer?.connected && !(observer.teamId != null && observer.teamId === target.teamId)) {
            this.emitPlayer(observerId, EVENTS.OPPONENT_HEALTH, {
              targetId: target.id, health: target.health, maxHealth: PLAYER.maxHealth,
            });
          }
        }
        if (shooter.id !== target.id) {
          const prev = target.recentDamagers.get(shooter.id);
          const fresh = prev && (now - prev.at <= CURRENCY_CONFIG.antiFarming.assistWindowMs);
          target.recentDamagers.set(shooter.id, {
            damage: (fresh ? prev.damage : 0) + damage,
            at: now,
          });
        }
        this.emitPlayer(target.id, EVENTS.HEALTH_UPDATE, {
          health: target.health,
          maxHealth: PLAYER.maxHealth,
          attackerId: shooter.id,
        });
      }
      if (damage > 0 && !blockedByShield && weapon.knockback) this.applyKnockback(shooter, target, weapon);
      if (killed) this.killPlayer(shooter, target, hit.headshot, now, weapon?.id);
    }
  }

  isFrontalShieldBlock(target, attacker, point, now = Date.now()) {
    const shield = getWeapon(target.currentWeaponId);
    if (shield?.behavior !== 'shield' || !attacker || !target.alive || !target.connected
      || !target.shieldBlocking || now >= target.shieldBlockUntil
      || (!target.isBot && now - target.lastInputAt > PLAYER.inputTimeoutMs)) return false;
    const deltaX = (attacker.x ?? point.x) - target.x;
    const deltaZ = (attacker.z ?? point.z) - target.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance < 1e-6) return false;
    const forwardX = -Math.sin(target.yaw);
    const forwardZ = -Math.cos(target.yaw);
    const facingDot = (forwardX * deltaX + forwardZ * deltaZ) / distance;
    return facingDot >= Math.cos((shield.frontalArcDegrees * Math.PI) / 360);
  }

  applyKnockback(attacker, target, weapon) {
    const deltaX = target.x - attacker.x;
    const deltaZ = target.z - attacker.z;
    const distance = Math.hypot(deltaX, deltaZ) || 1;
    target.knockbackVX += (deltaX / distance) * weapon.knockback;
    target.knockbackVZ += (deltaZ / distance) * weapon.knockback;
    target.vy = Math.max(target.vy, weapon.knockbackLift ?? 0);
    target.grounded = false;
  }

  reload(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !player.connected || !player.alive) return;
    const weapon = getWeapon(player.currentWeaponId);
    const state = player.weaponStates[player.currentWeaponId];
    if (!weapon || !state || weapon.magSize <= 0 || weapon.unlimitedAmmo || state.reloadUntil !== null) return;
    if (state.ammo >= weapon.magSize || state.reserveAmmo <= 0) return;
    state.reloadUntil = now + weapon.reloadTime;
    syncActiveWeapon(player, now);
    this.sendAmmo(player, now);
  }

  sendAmmo(player, now = Date.now()) {
    syncActiveWeapon(player, now);
    this.emitPlayer(player.id, EVENTS.AMMO_UPDATE, {
      bundleId: player.bundleId,
      weaponId: player.currentWeaponId,
      weaponName: player.currentWeaponName,
      weaponIcon: player.currentWeaponIcon,
      auto: player.auto,
      fireRate: player.fireRate,
      ammo: player.ammo,
      reserveAmmo: player.reserveAmmo,
      totalAmmo: player.totalAmmo,
      maxAmmo: player.maxAmmo,
      unlimitedAmmo: player.unlimitedAmmo,
      reloading: player.reloading,
      reloadCompletesAt: player.reloadUntil,
      overheated: player.overheated,
      overheatCompletesAt: player.overheatCompletesAt,
    });
  }

  killPlayer(killer, victim, headshot, now, weaponId = null) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.respawnAt = now + PLAYER.respawnMs;
    victim.vx = 0;
    victim.vz = 0;
    if (Math.abs(victim.knockbackVX) + Math.abs(victim.knockbackVZ) < 0.01) victim.vy = 0;
    this.updateShieldInput(victim, false, now);
    victim.input.forward = 0;
    victim.input.strafe = 0;
    victim.input.jump = false;
    victim.pendingJump = false;
    killer.kills += 1;

    const assisters = [];
    for (const [attackerId, entry] of victim.recentDamagers.entries()) {
      if (attackerId === killer.id || attackerId === victim.id) continue;
      if (now - entry.at > CURRENCY_CONFIG.antiFarming.assistWindowMs) continue;
      if (entry.damage < CURRENCY_CONFIG.antiFarming.assistMinDamage) continue;
      const assister = this.players.get(attackerId);
      if (assister && !assister.isBot) {
        assister.assists = (assister.assists || 0) + 1;
        assisters.push(assister);
      }
    }
    victim.recentDamagers.clear();
    victim.healthObservers.clear();

    const killSeq = ++this.killSequence;

    if (!killer.isBot && killer.profileId) {
      const profile = this.onHumanKill(killer);
      if (profile) {
        killer.lifetimeKills = profile.lifetimeKills;
        this.emitPlayer(killer.id, EVENTS.PROFILE_UPDATE, profile);
      }
    }

    this.onElimination({
      matchId: this.matchId,
      killSeq,
      killer,
      victim,
      assisters,
      headshot: Boolean(headshot),
      weaponId,
      isSoloBots: this.mode === ROOM_MODES.SOLO_VS_BOTS,
      now,
    });

    const feedEntry = {
      id: `${now}-${killer.id}-${victim.id}`,
      killerId: killer.id,
      killerName: killer.name,
      victimId: victim.id,
      victimName: victim.name,
      assisterName: assisters[0]?.name ?? null,
      headshot,
      at: now,
    };
    this.feed.push(feedEntry);
    this.feed = this.feed.slice(-8);

    this.emitRoom(EVENTS.PLAYER_DIED, {
      victimId: victim.id,
      killerId: killer.id,
      respawnAt: victim.respawnAt,
      headshot,
    });
    this.emitRoom(EVENTS.KILL_FEED_UPDATE, feedEntry);
    this.emitRoom(EVENTS.SCORE_UPDATE, { players: this.getScoreboard() });

    if (killer.kills >= PLAYER.targetKills) {
      this.finished = true;
      this.winner = {
        id: killer.id,
        name: killer.name,
        kills: killer.kills,
        ...(killer.isBot ? { isBot: true } : {}),
      };
      this.onMatchFinished({
        matchId: this.matchId,
        winner: killer,
        players: [...this.players.values()].map((p) => ({
          id: p.id,
          accountId: p.accountId ?? null,
          isBot: Boolean(p.isBot),
          connected: Boolean(p.connected),
          kills: p.kills,
          assists: p.assists ?? 0,
          participationMs: Math.max(0, now - (p.joinedAt ?? this.startedAt)),
        })),
        isSoloBots: this.mode === ROOM_MODES.SOLO_VS_BOTS,
        now,
      });
    }
  }

  respawn(player, now) {
    const spawn = this.chooseRespawn(player.id);
    player.x = spawn.x;
    player.y = 0;
    player.z = spawn.z;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.knockbackVX = 0;
    player.knockbackVZ = 0;
    player.health = PLAYER.maxHealth;
    player.alive = true;
    player.grounded = true;
    player.respawnAt = null;
    player.spawnProtectionUntil = now + PLAYER.spawnProtectionMs;
    for (const [weaponId, state] of Object.entries(player.weaponStates)) {
      const weapon = WEAPONS[weaponId];
      state.ammo = weapon.magSize;
      state.reserveAmmo = weapon.reserveAmmo ?? 0;
      state.reloadUntil = null;
      state.nextShotAt = now + weapon.fireRate;
      state.firingStartedAt = null;
      state.lastFiredAt = null;
      state.overheatedUntil = null;
    }
    player.input.forward = 0;
    player.input.strafe = 0;
    player.input.jump = false;
    player.pendingJump = false;
    player.recentDamagers.clear();
    player.healthObservers.clear();
    player.wasJumping = false;
    player.shieldBlocking = false;
    player.shieldBlockUntil = 0;
    player.shieldCooldownUntil = 0;
    player.shieldNeedsRelease = false;
    if (player.isBot && player.botBrain) {
      const preset = this.getBotPreset();
      const loadout = getBundleLoadout(player.bundleId);
      player.currentWeaponId = loadout[0]?.id ?? player.currentWeaponId;
      player.pitch = 0;
      Object.assign(player.botBrain, {
        waypoint: randomBotWaypoint(this.map, this.cover),
        nextWaypointAt: now + botWaypointDuration(),
        stuckThinkCount: 0,
        lastX: spawn.x,
        lastZ: spawn.z,
        targetId: null,
        currentlyVisible: false,
        visibleSince: null,
        lastSeenAt: -Infinity,
        reactionUntil: 0,
        respawnGraceUntil: now + preset.postRespawnGraceMs,
        nextFireAt: now + preset.postRespawnGraceMs,
        burstRemaining: 0,
        burstCooldownUntil: 0,
        lastTargetSpeed: 0,
      });
    } else if (!player.isBot) {
      for (const other of this.players.values()) {
        if (!other.isBot || other.botBrain?.targetId !== player.id) continue;
        other.botBrain.targetId = null;
        other.botBrain.currentlyVisible = false;
        other.botBrain.visibleSince = null;
        other.botBrain.burstRemaining = 0;
      }
    }
    syncActiveWeapon(player, now);

    this.emitRoom(EVENTS.PLAYER_RESPAWNED, {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      spawnProtectionUntil: player.spawnProtectionUntil,
    });
    this.sendAmmo(player, now);
  }

  chooseRespawn(playerId) {
    const otherPlayers = [...this.players.values()].filter((player) => player.id !== playerId && player.alive);
    const spawnPoints = this.map.spawns;
    let bestSpawn = spawnPoints[0];
    let bestDistance = -Infinity;

    for (const spawn of spawnPoints) {
      const nearestOpponent = otherPlayers.reduce((nearest, player) => {
        return Math.min(nearest, Math.hypot(spawn.x - player.x, spawn.z - player.z));
      }, Infinity);
      if (nearestOpponent > bestDistance) {
        bestDistance = nearestOpponent;
        bestSpawn = spawn;
      }
    }

    return bestSpawn;
  }

  setPlayerConnected(playerId, connected, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player) return false;
    player.connected = Boolean(connected);
    player.lastInputAt = now;
    if (!player.connected) {
      this.updateShieldInput(player, false, now);
      player.input.forward = 0;
      player.input.strafe = 0;
      player.input.jump = false;
      player.vx = 0;
      player.vy = 0;
      player.vz = 0;
      player.wasJumping = false;
    }
    return true;
  }

  rebindPlayer(previousId, nextId, now = Date.now()) {
    const player = this.players.get(previousId);
    if (!player || player.isBot || this.players.has(nextId)) return false;
    this.players.delete(previousId);
    player.id = nextId;
    player.connected = true;
    player.lastInputAt = now;
    player.shieldBlocking = false;
    player.shieldNeedsRelease = false;
    player.lastInputSequence = -1;
    player.lastProcessedInputSequence = -1;
    player.input = { forward: 0, strafe: 0, jump: false };
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.wasJumping = false;
    this.players.set(nextId, player);
    for (const cloud of this.smokeClouds) {
      if (cloud.ownerId === previousId) cloud.ownerId = nextId;
    }
    for (const projectile of this.projectiles) {
      if (projectile.ownerId === previousId) projectile.ownerId = nextId;
    }
    for (const entry of this.feed) {
      if (entry.killerId === previousId) entry.killerId = nextId;
      if (entry.victimId === previousId) entry.victimId = nextId;
    }
    for (const other of this.players.values()) {
      if (other.healthObservers.delete(previousId)) other.healthObservers.add(nextId);
      if (other.recentDamagers?.has(previousId)) {
        const dmg = other.recentDamagers.get(previousId);
        other.recentDamagers.delete(previousId);
        other.recentDamagers.set(nextId, dmg);
      }
    }
    syncActiveWeapon(player, now);
    this.sendAmmo(player, now);
    return true;
  }

  getRevealedHealthFor(playerId) {
    const observer = this.players.get(playerId);
    if (!observer) return [];
    return [...this.players.values()]
      .filter(target => target.alive && target.connected && target.healthObservers.has(playerId)
        && !(observer.teamId != null && observer.teamId === target.teamId))
      .map(target => ({ targetId: target.id, health: target.health, maxHealth: PLAYER.maxHealth }));
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    for (const other of this.players.values()) other.healthObservers.delete(playerId);
    this.projectiles = this.projectiles.filter((projectile) => projectile.ownerId !== playerId);
    const previousCount = this.smokeClouds.length;
    this.smokeClouds = this.smokeClouds.filter((cloud) => cloud.ownerId !== playerId);
    if (this.smokeClouds.length !== previousCount) this.emitSmokeState();
  }

  getScoreboard() {
    return [...this.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        kills: player.kills,
        deaths: player.deaths,
        alive: player.alive,
        isBot: player.isBot,
        connected: player.connected,
        bundleId: player.bundleId,
        currentWeaponId: player.currentWeaponId,
        currentWeaponName: player.currentWeaponName,
        currentWeaponIcon: player.currentWeaponIcon,
      }))
      .sort((left, right) => right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
  }

  getPublicState(now = Date.now()) {
    return {
      code: this.room.code,
      state: this.room.state,
      serverTime: now,
      tick: this.tickSequence,
      targetKills: PLAYER.targetKills,
      mode: this.mode,
      botDifficulty: this.mode === ROOM_MODES.SOLO_VS_BOTS ? this.botDifficulty : null,
      players: [...this.players.values()].map((player) => {
        syncActiveWeapon(player, now);
        return {
          id: player.id,
          name: player.name,
          color: player.color,
          x: player.x,
          y: player.y,
          z: player.z,
          vx: player.vx,
          vy: player.vy,
          vz: player.vz,
          grounded: player.grounded,
          wasJumping: player.wasJumping,
          knockbackVX: player.knockbackVX,
          knockbackVZ: player.knockbackVZ,
          inputAck: player.lastProcessedInputSequence,
          yaw: player.yaw,
          pitch: player.pitch,
          health: player.health,
          maxHealth: PLAYER.maxHealth,
          kills: player.kills,
          deaths: player.deaths,
          lifetimeKills: player.lifetimeKills,
          alive: player.alive,
          isBot: player.isBot,
          connected: player.connected,
          bundleId: player.bundleId,
          currentWeaponId: player.currentWeaponId,
          currentWeaponName: player.currentWeaponName,
          currentWeaponIcon: player.currentWeaponIcon,
          auto: player.auto,
          fireRate: player.fireRate,
          blocking: player.shieldBlocking && now < player.shieldBlockUntil,
          spawnProtected: now < player.spawnProtectionUntil,
          spawnProtectionUntil: player.spawnProtectionUntil,
          respawnAt: player.respawnAt,
          ammo: player.ammo,
          reserveAmmo: player.reserveAmmo,
          totalAmmo: player.totalAmmo,
          maxAmmo: player.maxAmmo,
          unlimitedAmmo: player.unlimitedAmmo,
          reloading: player.reloading,
          reloadCompletesAt: player.reloadUntil,
          overheated: player.overheated,
          overheatCompletesAt: player.overheatCompletesAt,
        };
      }),
      smokeClouds: this.smokeClouds.map((cloud) => ({ ...cloud })),
      projectiles: this.projectiles.map((projectile) => ({
        id: projectile.id, x: projectile.x, y: projectile.y, z: projectile.z,
        direction: projectile.direction, speed: getWeapon(projectile.weaponId).projectileSpeed,
      })),
      cover: this.cover.map((block) => block.id),
    };
  }
}
