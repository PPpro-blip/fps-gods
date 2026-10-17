import { EVENTS, ROOM_MODES } from '../shared/events.js';
import { BOT, COVER, MAP, PLAYER, SPAWN_POINTS } from '../shared/gameConfig.js';
import { DEFAULT_BUNDLE_ID } from '../shared/bundles.js';
import { castShot, raycastCover } from './hitDetection.js';
import { BUNDLE_IDS, getBundleLoadout, getWeapon, WEAPONS } from './weaponConfig.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapAngle = (angle) => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const finiteNumber = (value, fallback) => (Number.isFinite(value) ? value : fallback);

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

function collidesWithCover(x, z, feetY, cover = COVER) {
  const playerTop = feetY + PLAYER.height;
  for (const block of cover) {
    if (feetY >= block.height || playerTop <= 0) continue;
    const nearestX = clamp(x, block.x - block.width / 2, block.x + block.width / 2);
    const nearestZ = clamp(z, block.z - block.depth / 2, block.z + block.depth / 2);
    const dx = x - nearestX;
    const dz = z - nearestZ;
    if (dx * dx + dz * dz < PLAYER.radius * PLAYER.radius) return true;
  }
  return false;
}

function randomBotWaypoint() {
  const maxX = MAP.halfWidth - MAP.wallThickness / 2 - PLAYER.radius - 1;
  const maxZ = MAP.halfDepth - MAP.wallThickness / 2 - PLAYER.radius - 1;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const waypoint = {
      x: (Math.random() * 2 - 1) * maxX,
      z: (Math.random() * 2 - 1) * maxZ,
    };
    if (!collidesWithCover(waypoint.x, waypoint.z, 0)) return waypoint;
  }
  return { ...SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)] };
}

function botWaypointDuration() {
  return BOT.minimumWaypointTimeMs
    + Math.random() * (BOT.maximumWaypointTimeMs - BOT.minimumWaypointTimeMs);
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

function makeGamePlayer(record, spawn, now) {
  const bundleId = record.bundleId ?? DEFAULT_BUNDLE_ID;
  const loadout = getBundleLoadout(bundleId);
  const weaponStates = Object.fromEntries(loadout.map((weapon) => [weapon.id, createWeaponState(weapon, now)]));
  const firstWeaponId = loadout[0].id;
  const currentWeaponId = weaponStates[record.currentWeaponId] ? record.currentWeaponId : firstWeaponId;
  const player = {
    id: record.id,
    profileId: record.profileId ?? null,
    lifetimeKills: Math.max(0, Number(record.lifetimeKills) || 0),
    bundleId,
    currentWeaponId,
    weaponStates,
    name: record.name,
    color: record.color,
    isBot: record.isBot === true,
    connected: record.isBot === true || record.connected !== false,
    botBrain: record.isBot === true ? {
      waypoint: randomBotWaypoint(),
      nextWaypointAt: now + botWaypointDuration(),
      stuckThinkCount: 0,
      lastX: spawn.x,
      lastZ: spawn.z,
    } : null,
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
    deaths: 0,
    alive: true,
    grounded: true,
    ready: record.ready,
    input: { forward: 0, strafe: 0, jump: false },
    lastInputAt: now,
    lastInputSequence: -1,
    wasJumping: false,
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
  } = {}, now = Date.now()) {
    this.room = room;
    this.mode = room.mode ?? ROOM_MODES.MULTIPLAYER;
    this.emitRoom = emitRoom;
    this.emitPlayer = emitPlayer;
    this.onHumanKill = onHumanKill;
    this.players = new Map();
    this.feed = [];
    this.finished = false;
    this.winner = null;
    this.lastBotThinkAt = now;
    this.cover = COVER.map((block, id) => ({ ...block, id }));
    this.smokeClouds = [];
    this.smokeSequence = 0;

    const records = [...room.players.values()];
    if (this.mode === ROOM_MODES.SOLO_VS_BOTS) {
      const botColors = ['#ff9858', '#ff647c', '#b18cff', '#ffc857', '#ff72cc'];
      for (let index = 1; index <= BOT.count; index += 1) {
        const name = `GOD_BOT_${String(index).padStart(2, '0')}`;
        records.push({
          id: `bot-${name}`,
          name,
          color: botColors[index - 1],
          ready: true,
          isBot: true,
          bundleId: BUNDLE_IDS[Math.floor(Math.random() * BUNDLE_IDS.length)],
        });
      }
    }

    const spawns = shuffled(SPAWN_POINTS);
    records.forEach((record, index) => {
      const spawn = spawns[index % spawns.length];
      this.players.set(record.id, makeGamePlayer(record, spawn, now));
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
    player.lastInputAt = now;
  }

  update(deltaSeconds, now = Date.now()) {
    if (this.finished) return { winner: this.winner };
    const delta = clamp(finiteNumber(deltaSeconds, 0), 0, 0.1);
    if (this.mode === ROOM_MODES.SOLO_VS_BOTS && now - this.lastBotThinkAt >= BOT.thinkIntervalMs) {
      this.lastBotThinkAt = now;
      this.updateBots(now);
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
      }
      this.updatePlayer(player, delta);
      this.updateWeaponTimers(player, now);
    }

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

  updateBots(now) {
    const humanPlayers = [...this.players.values()].filter((player) => !player.isBot && player.connected && player.alive);
    const humanTargets = new Map(humanPlayers.map((player) => [player.id, player]));

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
        brain.waypoint = randomBotWaypoint();
        brain.nextWaypointAt = now + botWaypointDuration();
        brain.stuckThinkCount = 0;
      }

      const toWaypointX = brain.waypoint.x - bot.x;
      const toWaypointZ = brain.waypoint.z - bot.z;
      const waypointDistance = Math.hypot(toWaypointX, toWaypointZ);
      const target = humanPlayers.reduce((nearest, player) => {
        const distance = Math.hypot(player.x - bot.x, player.z - bot.z);
        return !nearest || distance < nearest.distance ? { player, distance } : nearest;
      }, null)?.player;

      if (target) {
        const deltaX = target.x - bot.x;
        const deltaZ = target.z - bot.z;
        const horizontalDistance = Math.hypot(deltaX, deltaZ);
        bot.yaw = wrapAngle(Math.atan2(-deltaX, -deltaZ));
        bot.pitch = clamp(
          Math.atan2(target.y - bot.y, horizontalDistance),
          -1.45,
          1.45,
        );
      } else {
        if (waypointDistance > 0) bot.yaw = wrapAngle(Math.atan2(-toWaypointX, -toWaypointZ));
        bot.pitch = 0;
      }

      const desiredX = waypointDistance > BOT.waypointReachDistance ? toWaypointX / waypointDistance : 0;
      const desiredZ = waypointDistance > BOT.waypointReachDistance ? toWaypointZ / waypointDistance : 0;
      const forwardX = -Math.sin(bot.yaw);
      const forwardZ = -Math.cos(bot.yaw);
      const rightX = Math.cos(bot.yaw);
      const rightZ = -Math.sin(bot.yaw);
      bot.input.forward = clamp(desiredX * forwardX + desiredZ * forwardZ, -1, 1);
      bot.input.strafe = clamp(desiredX * rightX + desiredZ * rightZ, -1, 1);
      bot.input.jump = false;
      bot.lastInputAt = now;

      if (!target) continue;
      const weapon = getWeapon(bot.currentWeaponId);
      if (!weapon || weapon.behavior === 'shield') continue;
      const visibleShot = castShot({
        origin: { x: bot.x, y: bot.y + PLAYER.eyeHeight, z: bot.z },
        direction: aimDirection(bot.yaw, bot.pitch),
        players: humanTargets,
        shooterId: bot.id,
        maxDistance: weapon.range,
        cover: this.cover,
        smokeClouds: this.smokeClouds,
        ignoreCover: weapon.piercesCover === true,
      });
      if (visibleShot?.target.id === target.id) this.shoot(bot.id, now);
    }
  }

  updatePlayer(player, delta) {
    if (delta <= 0) return;
    const startX = player.x;
    const startZ = player.z;

    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const rightX = Math.cos(player.yaw);
    const rightZ = -Math.sin(player.yaw);
    let moveX = forwardX * player.input.forward + rightX * player.input.strafe;
    let moveZ = forwardZ * player.input.forward + rightZ * player.input.strafe;
    const magnitude = Math.hypot(moveX, moveZ);
    if (magnitude > 1) {
      moveX /= magnitude;
      moveZ /= magnitude;
    }

    const deltaX = moveX * PLAYER.moveSpeed * delta + player.knockbackVX * delta;
    const deltaZ = moveZ * PLAYER.moveSpeed * delta + player.knockbackVZ * delta;
    const maxCenterX = MAP.halfWidth - MAP.wallThickness / 2 - PLAYER.radius;
    const maxCenterZ = MAP.halfDepth - MAP.wallThickness / 2 - PLAYER.radius;
    const minX = -maxCenterX;
    const maxX = maxCenterX;
    const minZ = -maxCenterZ;
    const maxZ = maxCenterZ;

    const candidateX = clamp(player.x + deltaX, minX, maxX);
    if (!collidesWithCover(candidateX, player.z, player.y, this.cover)) player.x = candidateX;
    const candidateZ = clamp(player.z + deltaZ, minZ, maxZ);
    if (!collidesWithCover(player.x, candidateZ, player.y, this.cover)) player.z = candidateZ;
    player.knockbackVX *= Math.exp(-7.5 * delta);
    player.knockbackVZ *= Math.exp(-7.5 * delta);

    if (player.input.jump && !player.wasJumping && player.grounded) {
      player.vy = PLAYER.jumpVelocity;
      player.grounded = false;
    }
    player.wasJumping = player.input.jump;

    player.vy -= PLAYER.gravity * delta;
    player.y += player.vy * delta;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      player.grounded = true;
    }

    player.vx = (player.x - startX) / delta;
    player.vz = (player.z - startZ) / delta;
  }

  updateDeadKnockback(player, delta) {
    const startX = player.x;
    const startZ = player.z;
    const maxCenterX = MAP.halfWidth - MAP.wallThickness / 2 - PLAYER.radius;
    const maxCenterZ = MAP.halfDepth - MAP.wallThickness / 2 - PLAYER.radius;
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
    if (!player || !player.connected || !player.alive || !player.weaponStates[weaponId]) return false;
    if (player.currentWeaponId === weaponId) return true;

    player.currentWeaponId = weaponId;
    syncActiveWeapon(player, now);
    const data = {
      playerId: player.id,
      bundleId: player.bundleId,
      weaponId,
      weaponName: player.currentWeaponName,
      weaponIcon: player.currentWeaponIcon,
    };
    this.emitRoom(EVENTS.WEAPON_UPDATE, data);
    this.sendAmmo(player, now);
    return true;
  }

  shoot(playerId, now = Date.now()) {
    if (this.finished) return;
    const shooter = this.players.get(playerId);
    if (!shooter || !shooter.connected || !shooter.alive) return;
    const weapon = getWeapon(shooter.currentWeaponId);
    const weaponState = shooter.weaponStates[shooter.currentWeaponId];
    if (!weapon || !weaponState || weapon.behavior === 'shield') return;

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
    if (shooter.isBot && Math.random() < BOT.missChance) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const missAngle = BOT.minimumMissAngleRadians
        + Math.random() * (BOT.maximumMissAngleRadians - BOT.minimumMissAngleRadians);
      direction = aimDirection(wrapAngle(shooter.yaw + side * missAngle), shooter.pitch);
    }

    this.emitRoom(EVENTS.WEAPON_FIRED, {
      playerId: shooter.id,
      weaponId: weapon.id,
      bundleId: shooter.bundleId,
      origin,
      direction,
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
        ignoreCover: weapon.piercesCover === true,
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
    const coverImpact = raycastCover({
      origin,
      direction,
      cover: this.cover,
      maxDistance: weapon.range,
      includeFloor: true,
    });
    const players = shooter.isBot
      ? new Map([...this.players].filter(([, player]) => !player.isBot))
      : this.players;
    const directHit = castShot({
      origin,
      direction,
      players,
      shooterId: shooter.id,
      maxDistance: weapon.range,
      cover: this.cover,
      smokeClouds: [],
    });

    let impactPoint = {
      x: origin.x + direction.x * weapon.range,
      y: Math.max(0, origin.y + direction.y * weapon.range),
      z: origin.z + direction.z * weapon.range,
    };
    if (coverImpact && (!directHit || coverImpact.distance <= directHit.distance)) {
      impactPoint = coverImpact.point;
      if (coverImpact.block) this.destroyCover(coverImpact.block);
    } else if (directHit) {
      impactPoint = directHit.point;
    }

    const hits = [];
    for (const target of this.players.values()) {
      if (target.id === shooter.id || !target.connected || !target.alive) continue;
      const distance = Math.hypot(target.x - impactPoint.x, target.y + PLAYER.height / 2 - impactPoint.y, target.z - impactPoint.z);
      if (distance > weapon.splashRadius) continue;
      const splash = weapon.splashDamage * Math.max(0, 1 - distance / weapon.splashRadius);
      const damage = directHit?.target.id === target.id ? Math.max(weapon.damage, splash) : splash;
      if (damage <= 0) continue;
      hits.push({ target, damage, headshot: false, point: impactPoint });
    }

    if (hits.length === 0) {
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false, weaponId: weapon.id });
      return;
    }
    this.applyDamageBatch(shooter, hits, now, weapon);
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
    const x = clamp(origin.x + direction.x * distance, -MAP.halfWidth + 1, MAP.halfWidth - 1);
    const z = clamp(origin.z + direction.z * distance, -MAP.halfDepth + 1, MAP.halfDepth - 1);
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
      const blockedByShield = this.isFrontalShieldBlock(target, shooter, hit.point);
      const blocked = protectedAtSpawn || blockedByShield;
      const damage = blocked ? 0 : hit.damage;
      if (!blocked) target.health = Math.max(0, target.health - damage);

      const killed = !blocked && target.health === 0;
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
        hit: true,
        targetId: target.id,
        weaponId: weapon.id,
        damage,
        headshot: hit.headshot,
        protected: protectedAtSpawn,
        blockedByShield,
        killed,
        point: hit.point,
      });

      if (!blocked) {
        this.emitPlayer(target.id, EVENTS.HEALTH_UPDATE, {
          health: target.health,
          maxHealth: PLAYER.maxHealth,
          attackerId: shooter.id,
        });
      }
      if (!blocked && weapon.knockback) this.applyKnockback(shooter, target, weapon);
      if (killed) this.killPlayer(shooter, target, hit.headshot, now);
    }
  }

  isFrontalShieldBlock(target, attacker, point) {
    const shield = getWeapon(target.currentWeaponId);
    if (shield?.behavior !== 'shield' || !attacker) return false;
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

  killPlayer(killer, victim, headshot, now) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.respawnAt = now + PLAYER.respawnMs;
    victim.vx = 0;
    victim.vz = 0;
    if (Math.abs(victim.knockbackVX) + Math.abs(victim.knockbackVZ) < 0.01) victim.vy = 0;
    victim.input.forward = 0;
    victim.input.strafe = 0;
    victim.input.jump = false;
    killer.kills += 1;

    if (!killer.isBot && killer.profileId) {
      const profile = this.onHumanKill(killer);
      if (profile) {
        killer.lifetimeKills = profile.lifetimeKills;
        this.emitPlayer(killer.id, EVENTS.PROFILE_UPDATE, profile);
      }
    }

    const feedEntry = {
      id: `${now}-${killer.id}-${victim.id}`,
      killerId: killer.id,
      killerName: killer.name,
      victimId: victim.id,
      victimName: victim.name,
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
    player.wasJumping = false;
    syncActiveWeapon(player, now);

    this.emitRoom(EVENTS.PLAYER_RESPAWNED, {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      health: player.health,
      spawnProtectionUntil: player.spawnProtectionUntil,
    });
    this.sendAmmo(player, now);
  }

  chooseRespawn(playerId) {
    const otherPlayers = [...this.players.values()].filter((player) => player.id !== playerId && player.alive);
    let bestSpawn = SPAWN_POINTS[0];
    let bestDistance = -Infinity;

    for (const spawn of SPAWN_POINTS) {
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
    player.lastInputSequence = -1;
    player.input = { forward: 0, strafe: 0, jump: false };
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.wasJumping = false;
    this.players.set(nextId, player);
    for (const cloud of this.smokeClouds) {
      if (cloud.ownerId === previousId) cloud.ownerId = nextId;
    }
    for (const entry of this.feed) {
      if (entry.killerId === previousId) entry.killerId = nextId;
      if (entry.victimId === previousId) entry.victimId = nextId;
    }
    syncActiveWeapon(player, now);
    this.sendAmmo(player, now);
    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
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
        health: player.health,
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
      targetKills: PLAYER.targetKills,
      mode: this.mode,
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
      cover: this.cover.map((block) => block.id),
    };
  }
}
