import { BOTS, COVER, MAP, PLAYER, SPAWN_POINTS } from '../shared/gameConfig.js';
import { EVENTS } from '../shared/events.js';
import {
  getBundle,
  getWeapon,
  PRIMARY_SLOT,
} from '../shared/weapons.js';
import { castShot, pointHitsWorld } from './hitDetection.js';
import { BotController } from './bots.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapAngle = (angle) => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const finiteNumber = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const BOT_THINK_SECONDS = BOTS.tickMs / 1_000;

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

function collidesWithCover(x, z, feetY) {
  const playerTop = feetY + PLAYER.height;
  for (const block of COVER) {
    if (feetY >= block.height || playerTop <= 0) continue;
    const nearestX = clamp(x, block.x - block.width / 2, block.x + block.width / 2);
    const nearestZ = clamp(z, block.z - block.depth / 2, block.z + block.depth / 2);
    const dx = x - nearestX;
    const dz = z - nearestZ;
    if (dx * dx + dz * dz < PLAYER.radius * PLAYER.radius) return true;
  }
  return false;
}

function buildSlots(bundleId, now) {
  return getBundle(bundleId).slots.map((weaponId) => {
    const weapon = getWeapon(weaponId);
    return {
      weaponId,
      ammo: weapon.unlimited ? Infinity : weapon.magSize,
      reloadUntil: null,
      nextShotAt: now,
    };
  });
}

function makeGamePlayer(record, spawn, now) {
  const bundleId = record.bundleId && getBundle(record.bundleId) ? record.bundleId : 'rusher';
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    isBot: record.isBot === true,
    bundleId,
    slot: PRIMARY_SLOT,
    slots: buildSlots(bundleId, now),
    heat: 0,
    overheatedUntil: null,
    lastHeatShotAt: 0,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
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
}

// All movement, collision, health, weapon timing, damage, scoring, respawns,
// win checks and bot brains live here. Clients provide controls and render
// these results; nothing gameplay-relevant is trusted from the browser.
export class GameState {
  constructor(room, { emitRoom, emitPlayer }, now = Date.now()) {
    this.room = room;
    this.emitRoom = emitRoom;
    this.emitPlayer = emitPlayer;
    this.players = new Map();
    this.feed = [];
    this.smokes = [];
    this.projectiles = [];
    this.finished = false;
    this.winner = null;
    this.nextProjectileId = 1;
    this.botTimer = 0;

    const spawns = shuffled(SPAWN_POINTS);
    let index = 0;
    for (const record of room.players.values()) {
      const spawn = spawns[index % spawns.length];
      this.players.set(record.id, makeGamePlayer(record, spawn, now));
      index += 1;
    }

    this.bots = [...this.players.values()].some((player) => player.isBot)
      ? new BotController(this)
      : null;
  }

  getActiveSlot(player) {
    return player.slots[player.slot];
  }

  getActiveWeapon(player) {
    return getWeapon(this.getActiveSlot(player).weaponId);
  }

  setInput(playerId, payload, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || player.isBot || !payload || typeof payload !== 'object') return;
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

  switchWeapon(playerId, slot, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || !Number.isInteger(slot)) return;
    if (slot < 0 || slot >= player.slots.length || slot === player.slot) return;
    player.slot = slot;
    // The updated slot/weaponId ride on AMMO_UPDATE now and on every public
    // snapshot, which is how other players see the switched weapon.
    this.sendAmmo(player);
  }

  update(deltaSeconds, now = Date.now()) {
    if (this.finished) return { winner: this.winner };
    const delta = clamp(finiteNumber(deltaSeconds, 0), 0, 0.1);

    this.updateProjectiles(delta, now);
    this.updateSmokes(now);

    for (const player of this.players.values()) {
      if (!player.alive) {
        if (player.respawnAt !== null && now >= player.respawnAt) this.respawn(player, now);
        continue;
      }
      if (!player.isBot && now - player.lastInputAt > PLAYER.inputTimeoutMs) {
        player.input.forward = 0;
        player.input.strafe = 0;
        player.input.jump = false;
      }
      this.updatePlayer(player, delta);

      for (const slot of player.slots) {
        if (slot.reloadUntil !== null && now >= slot.reloadUntil) {
          slot.ammo = getWeapon(slot.weaponId).unlimited ? Infinity : getWeapon(slot.weaponId).magSize;
          slot.reloadUntil = null;
        }
      }

      if (player.heat > 0 && now - player.lastHeatShotAt > 350) {
        player.heat = Math.max(0, player.heat - delta * 0.45);
      }
    }

    if (this.bots) {
      this.botTimer += delta;
      while (this.botTimer >= BOT_THINK_SECONDS) {
        this.botTimer -= BOT_THINK_SECONDS;
        this.bots.think(now);
      }
    }

    return null;
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

    const deltaX = moveX * PLAYER.moveSpeed * delta;
    const deltaZ = moveZ * PLAYER.moveSpeed * delta;
    const maxCenterX = MAP.halfWidth - MAP.wallThickness / 2 - PLAYER.radius;
    const maxCenterZ = MAP.halfDepth - MAP.wallThickness / 2 - PLAYER.radius;
    const minX = -maxCenterX;
    const maxX = maxCenterX;
    const minZ = -maxCenterZ;
    const maxZ = maxCenterZ;

    const candidateX = clamp(player.x + deltaX, minX, maxX);
    if (!collidesWithCover(candidateX, player.z, player.y)) player.x = candidateX;
    const candidateZ = clamp(player.z + deltaZ, minZ, maxZ);
    if (!collidesWithCover(player.x, candidateZ, player.y)) player.z = candidateZ;

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

  // ── Shooting pipeline ─────────────────────────────────────────────────────
  // Humans and bots both land here; the active weapon's type decides the path.

  shoot(playerId, now = Date.now()) {
    if (this.finished) return;
    const shooter = this.players.get(playerId);
    if (!shooter || !shooter.alive) return;

    const slot = this.getActiveSlot(shooter);
    const weapon = this.getActiveWeapon(shooter);
    if (slot.reloadUntil !== null) return;
    if (weapon.overheatAfterMs && shooter.overheatedUntil !== null && now < shooter.overheatedUntil) return;

    if (weapon.type === 'shield') return;

    if (now < slot.nextShotAt) return;
    if (!weapon.unlimited && weapon.magSize > 0 && slot.ammo <= 0) {
      this.reload(playerId, now);
      return;
    }

    slot.nextShotAt = now + weapon.fireRateMs;

    if (weapon.type === 'melee') {
      this.meleeStrike(shooter, weapon, now);
      return;
    }
    if (weapon.type === 'grenade') {
      this.throwGrenade(shooter, slot, weapon, now);
      return;
    }
    if (weapon.type === 'projectile') {
      this.fireRocket(shooter, slot, weapon, now);
      return;
    }
    this.fireHitscan(shooter, slot, weapon, now);
  }

  consumeAmmo(shooter, slot, weapon, now) {
    if (weapon.unlimited) {
      shooter.lastHeatShotAt = now;
      shooter.heat = clamp(shooter.heat + weapon.fireRateMs / weapon.overheatAfterMs, 0, 1);
      if (shooter.heat >= 1) {
        shooter.overheatedUntil = now + weapon.cooldownMs;
        shooter.heat = 0;
        this.sendAmmo(shooter);
      }
      return;
    }
    if (weapon.magSize <= 0) return;
    slot.ammo = Math.max(0, slot.ammo - 1);
    if (slot.ammo === 0) slot.reloadUntil = now + weapon.reloadMs;
    this.sendAmmo(shooter);
  }

  fireHitscan(shooter, slot, weapon, now) {
    this.consumeAmmo(shooter, slot, weapon, now);

    const origin = {
      x: shooter.x,
      y: shooter.y + PLAYER.eyeHeight,
      z: shooter.z,
    };
    const baseDirection = aimDirection(shooter.yaw, shooter.pitch);
    const pelletCount = weapon.pellets ?? 1;
    const impacts = [];

    for (let pellet = 0; pellet < pelletCount; pellet += 1) {
      const direction = this.applySpread(baseDirection, weapon.spread);
      const result = castShot({
        origin,
        direction,
        players: this.players,
        shooterId: shooter.id,
        maxDistance: weapon.range,
        smokes: this.smokes,
        piercesWalls: Boolean(weapon.piercesWalls),
        piercesPlayers: Boolean(weapon.piercesPlayers),
      });

      if (!result) continue;

      const strikes = weapon.piercesPlayers ? result.hits : [result];
      for (const strike of strikes) {
        const distanceFactor = this.falloffFactor(weapon, strike.distance);
        const rawDamage = weapon.damage
          * (strike.headshot ? weapon.headshotMultiplier : 1)
          * distanceFactor;
        const resolution = this.applyDamage(shooter, strike.target, rawDamage, {
          headshot: strike.headshot,
          weaponId: weapon.id,
          now,
        });
        impacts.push({ strike, resolution, weapon });
      }
    }

    if (!impacts.length) {
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
        hit: false,
        weaponId: weapon.id,
      });
      return;
    }

    // Aggregate the pellet stream into one marker: total damage on the primary
    // target, plus the full per-target breakdown (railgun multi-hits).
    const primaryId = impacts[0].strike.target.id;
    const primaryDamage = impacts
      .filter(({ strike }) => strike.target.id === primaryId)
      .reduce((sum, { resolution }) => sum + resolution.damage, 0);
    this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
      hit: true,
      targetId: primaryId,
      damage: primaryDamage,
      headshot: impacts[0].strike.headshot,
      protected: impacts[0].resolution.protected,
      blocked: impacts[0].resolution.blocked,
      killed: impacts.some(({ resolution }) => resolution.killed),
      point: impacts[0].strike.point,
      weaponId: weapon.id,
      hits: impacts.map(({ strike, resolution }) => ({
        targetId: strike.target.id,
        damage: resolution.damage,
        headshot: strike.headshot,
        protected: resolution.protected,
        blocked: resolution.blocked,
        killed: resolution.killed,
        point: strike.point,
      })),
    });
  }

  applySpread(direction, spreadRadians) {
    if (!spreadRadians) return direction;
    // Uniform offset inside a small cone around the aim vector.
    const yaw = Math.atan2(-direction.x, -direction.z) + (Math.random() * 2 - 1) * spreadRadians;
    const pitch = Math.asin(clamp(direction.y, -1, 1)) + (Math.random() * 2 - 1) * spreadRadians * 0.7;
    return aimDirection(yaw, pitch);
  }

  falloffFactor(weapon, distance) {
    if (!weapon.falloffStart || distance <= weapon.falloffStart) return 1;
    const span = (weapon.falloffEnd ?? weapon.range) - weapon.falloffStart;
    if (span <= 0) return weapon.falloffFloor ?? 1;
    const progress = clamp((distance - weapon.falloffStart) / span, 0, 1);
    return 1 - progress * (1 - (weapon.falloffFloor ?? 1));
  }

  meleeStrike(shooter, weapon, now) {
    const origin = { x: shooter.x, y: shooter.y + PLAYER.eyeHeight, z: shooter.z };
    const direction = aimDirection(shooter.yaw, shooter.pitch);
    let best = null;

    for (const target of this.players.values()) {
      if (target.id === shooter.id || !target.alive) continue;
      const toX = target.x - origin.x;
      const toY = target.y + PLAYER.height * 0.5 - origin.y;
      const toZ = target.z - origin.z;
      const distance = Math.hypot(toX, toY, toZ);
      if (distance > weapon.range) continue;
      const dot = (toX * direction.x + toY * direction.y + toZ * direction.z) / Math.max(distance, 1e-6);
      if (dot < 0.55) continue;
      if (!best || distance < best.distance) best = { target, distance };
    }

    if (!best) {
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false, weaponId: weapon.id });
      return;
    }

    if (weapon.knockback) this.knockback(shooter, best.target, weapon.knockback);

    const resolution = this.applyDamage(shooter, best.target, weapon.damage, {
      headshot: false,
      weaponId: weapon.id,
      now,
      ignoreShield: true,
    });
    this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
      hit: true,
      targetId: best.target.id,
      damage: resolution.damage,
      headshot: false,
      protected: resolution.protected,
      blocked: false,
      killed: resolution.killed,
      point: { x: best.target.x, y: best.target.y + PLAYER.height * 0.5, z: best.target.z },
      weaponId: weapon.id,
    });
  }

  knockback(shooter, target, strength) {
    const dx = target.x - shooter.x;
    const dz = target.z - shooter.z;
    const length = Math.hypot(dx, dz) || 1;
    const pushX = (dx / length) * strength;
    const pushZ = (dz / length) * strength;
    const maxCenterX = MAP.halfWidth - MAP.wallThickness / 2 - PLAYER.radius;
    const maxCenterZ = MAP.halfDepth - MAP.wallThickness / 2 - PLAYER.radius;
    const nextX = clamp(target.x + pushX, -maxCenterX, maxCenterX);
    const nextZ = clamp(target.z + pushZ, -maxCenterZ, maxCenterZ);
    if (!collidesWithCover(nextX, target.z, target.y)) target.x = nextX;
    if (!collidesWithCover(target.x, nextZ, target.y)) target.z = nextZ;
    target.vx = pushX;
    target.vz = pushZ;
  }

  fireRocket(shooter, slot, weapon, now) {
    this.consumeAmmo(shooter, slot, weapon, now);
    const origin = {
      x: shooter.x,
      y: shooter.y + PLAYER.eyeHeight,
      z: shooter.z,
    };
    const direction = aimDirection(shooter.yaw, shooter.pitch);
    this.projectiles.push({
      id: `proj-${this.nextProjectileId++}`,
      kind: 'rocket',
      weaponId: weapon.id,
      ownerId: shooter.id,
      x: origin.x + direction.x * 0.7,
      y: origin.y + direction.y * 0.7,
      z: origin.z + direction.z * 0.7,
      vx: direction.x * weapon.projectileSpeed,
      vy: direction.y * weapon.projectileSpeed,
      vz: direction.z * weapon.projectileSpeed,
      expiresAt: now + (weapon.range / weapon.projectileSpeed) * 1_000 + 700,
      bornAt: now,
    });
  }

  throwGrenade(shooter, slot, weapon, now) {
    this.consumeAmmo(shooter, slot, weapon, now);
    const origin = {
      x: shooter.x,
      y: shooter.y + PLAYER.eyeHeight,
      z: shooter.z,
    };
    const direction = aimDirection(shooter.yaw, shooter.pitch);
    const speed = weapon.projectileSpeed ?? 17;
    this.projectiles.push({
      id: `proj-${this.nextProjectileId++}`,
      kind: 'grenade',
      weaponId: weapon.id,
      ownerId: shooter.id,
      x: origin.x + direction.x * 0.5,
      y: origin.y + direction.y * 0.5,
      z: origin.z + direction.z * 0.5,
      vx: direction.x * speed,
      vy: direction.y * speed + 4.2,
      vz: direction.z * speed,
      expiresAt: now + 6_000,
      bornAt: now,
    });
  }

  updateProjectiles(delta, now) {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      if (projectile.kind === 'grenade') projectile.vy -= PLAYER.gravity * delta;

      // Substep so a fast rocket can never tunnel through a player between
      // ticks: each micro-move covers at most half a metre.
      const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
      const steps = Math.max(1, Math.ceil((speed * delta) / 0.5));
      const stepDelta = delta / steps;
      let done = now >= projectile.expiresAt;

      for (let step = 0; step < steps && !done; step += 1) {
        projectile.x += projectile.vx * stepDelta;
        projectile.y += projectile.vy * stepDelta;
        projectile.z += projectile.vz * stepDelta;

        if (pointHitsWorld(projectile.x, projectile.y, projectile.z, MAP)) {
          done = true;
          break;
        }

        if (projectile.kind !== 'rocket') continue;
        for (const target of this.players.values()) {
          if (!target.alive) continue;
          const horizontal = Math.hypot(projectile.x - target.x, projectile.z - target.z);
          const vertical = projectile.y - target.y;
          const insideBody = vertical >= 0 && vertical <= PLAYER.height;
          if (insideBody && horizontal <= PLAYER.radius + 0.32) {
            done = true;
            break;
          }
        }
      }

      if (!done) continue;
      this.projectiles.splice(index, 1);

      if (projectile.kind === 'rocket') {
        this.explodeRocket(projectile, now);
      } else {
        this.deploySmoke(projectile, now);
      }
    }
  }

  explodeRocket(projectile, now) {
    const owner = this.players.get(projectile.ownerId) ?? null;
    const weapon = getWeapon(projectile.weaponId);
    const blast = { x: projectile.x, y: projectile.y, z: projectile.z };
    let ownerImpact = null;

    for (const target of this.players.values()) {
      if (!target.alive) continue;
      const distance = Math.hypot(target.x - blast.x, target.y + PLAYER.height * 0.5 - blast.y, target.z - blast.z);
      if (distance > weapon.splashRadius) continue;

      const direct = distance <= PLAYER.radius + 0.5;
      const falloff = 1 - (distance / weapon.splashRadius) * 0.75;
      const rawDamage = (direct ? weapon.damage : weapon.splashDamage) * falloff;
      const resolution = owner
        ? this.applyDamage(owner, target, rawDamage, {
          headshot: false,
          weaponId: weapon.id,
          now,
          splash: true,
        })
        : { damage: 0, protected: false, blocked: false, killed: false };

      if (owner && target.id === owner.id) ownerImpact = resolution;
    }

    if (owner) {
      this.emitPlayer(owner.id, EVENTS.HIT_CONFIRMED, {
        hit: true,
        splash: true,
        point: blast,
        weaponId: weapon.id,
        self: Boolean(ownerImpact),
        damage: ownerImpact?.damage ?? 0,
        protected: ownerImpact?.protected ?? false,
        blocked: ownerImpact?.blocked ?? false,
        killed: ownerImpact?.killed ?? false,
      });
    }
  }

  deploySmoke(projectile, now) {
    const weapon = getWeapon(projectile.weaponId);
    this.smokes.push({
      id: projectile.id,
      ownerId: projectile.ownerId,
      x: projectile.x,
      y: Math.max(1, Math.min(projectile.y, 2.4)),
      z: projectile.z,
      radius: weapon.smokeRadius,
      expiresAt: now + weapon.smokeDurationMs,
    });
    if (this.smokes.length > 6) this.smokes.shift();
  }

  updateSmokes(now) {
    this.smokes = this.smokes.filter((smoke) => smoke.expiresAt > now);
  }

  // ── Damage resolution ────────────────────────────────────────────────────

  applyDamage(attacker, target, rawDamage, { headshot = false, weaponId = null, now = Date.now(), ignoreShield = false, splash = false } = {}) {
    if (!target.alive) return { damage: 0, protected: false, blocked: false, killed: false };

    if (now < target.spawnProtectionUntil) {
      return { damage: 0, protected: true, blocked: false, killed: false };
    }

    const shieldActive = this.getActiveWeapon(target).type === 'shield';
    if (shieldActive && !ignoreShield) {
      const facingX = -Math.sin(target.yaw);
      const facingZ = -Math.cos(target.yaw);
      const toX = attacker.x - target.x;
      const toZ = attacker.z - target.z;
      const length = Math.hypot(toX, toZ) || 1;
      const frontal = (facingX * toX + facingZ * toZ) / length;
      const arc = getWeapon('shield').blockArc;
      if (frontal > arc) {
        if (splash) {
          // Explosions wash around the shield: half damage still lands.
          return this.commitDamage(attacker, target, rawDamage * 0.5, headshot, weaponId, now, true);
        }
        this.emitPlayer(target.id, EVENTS.HEALTH_UPDATE, {
          health: target.health,
          maxHealth: PLAYER.maxHealth,
          attackerId: attacker.id,
          blocked: true,
        });
        return { damage: 0, protected: false, blocked: true, killed: false };
      }
    }

    return this.commitDamage(attacker, target, rawDamage, headshot, weaponId, now, false);
  }

  commitDamage(attacker, target, rawDamage, headshot, weaponId, now, halfBlocked) {
    const damage = Math.max(0, Math.round(rawDamage));
    target.health = Math.max(0, target.health - damage);

    this.emitPlayer(target.id, EVENTS.HEALTH_UPDATE, {
      health: target.health,
      maxHealth: PLAYER.maxHealth,
      attackerId: attacker.id,
    });

    const killed = target.health === 0;
    if (killed) this.killPlayer(attacker, target, headshot, now, weaponId);
    return { damage, protected: false, blocked: halfBlocked, killed };
  }

  reload(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    const slot = this.getActiveSlot(player);
    const weapon = this.getActiveWeapon(player);
    if (slot.reloadUntil !== null || weapon.unlimited || weapon.magSize <= 0) return;
    if (slot.ammo >= weapon.magSize) return;
    slot.reloadUntil = now + weapon.reloadMs;
    this.sendAmmo(player);
  }

  sendAmmo(player) {
    const slot = this.getActiveSlot(player);
    const weapon = this.getActiveWeapon(player);
    this.emitPlayer(player.id, EVENTS.AMMO_UPDATE, {
      slot: player.slot,
      weaponId: weapon.id,
      bundleId: player.bundleId,
      ammo: Number.isFinite(slot.ammo) ? slot.ammo : null,
      maxAmmo: weapon.unlimited ? null : weapon.magSize,
      reloading: slot.reloadUntil !== null,
      reloadCompletesAt: slot.reloadUntil,
      overheated: player.overheatedUntil !== null && Date.now() < player.overheatedUntil,
      overheatUntil: player.overheatedUntil,
      heat: player.heat,
    });
  }

  killPlayer(killer, victim, headshot, now, weaponId = null) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.respawnAt = now + PLAYER.respawnMs;
    victim.vx = 0;
    victim.vy = 0;
    victim.vz = 0;
    victim.input.forward = 0;
    victim.input.strafe = 0;
    victim.input.jump = false;
    // Rockets can kill their own shooter; a suicide is a death, never a kill.
    if (killer.id !== victim.id) killer.kills += 1;

    const feedEntry = {
      id: `${now}-${killer.id}-${victim.id}`,
      killerId: killer.id,
      killerName: killer.name,
      killerIsBot: killer.isBot,
      victimId: victim.id,
      victimName: victim.name,
      victimIsBot: victim.isBot,
      weaponId,
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
        isBot: killer.isBot,
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
    player.health = PLAYER.maxHealth;
    player.alive = true;
    player.grounded = true;
    player.respawnAt = null;
    player.spawnProtectionUntil = now + PLAYER.spawnProtectionMs;
    player.slots = buildSlots(player.bundleId, now);
    player.slot = PRIMARY_SLOT;
    player.heat = 0;
    player.overheatedUntil = null;
    player.input.forward = 0;
    player.input.strafe = 0;
    player.input.jump = false;
    player.wasJumping = false;
    if (player.isBot && this.bots) this.bots.onRespawn(player, now);

    this.emitRoom(EVENTS.PLAYER_RESPAWNED, {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      health: player.health,
      spawnProtectionUntil: player.spawnProtectionUntil,
    });
    this.sendAmmo(player);
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

  removePlayer(playerId) {
    this.players.delete(playerId);
    this.bots?.forget(playerId);
  }

  getScoreboard() {
    return [...this.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        isBot: player.isBot,
        bundleId: player.bundleId,
        weaponId: this.getActiveSlot(player).weaponId,
        kills: player.kills,
        deaths: player.deaths,
        health: player.health,
        alive: player.alive,
      }))
      .sort((left, right) => right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
  }

  getPublicState(now = Date.now()) {
    return {
      code: this.room.code,
      state: this.room.state,
      roomType: this.room.type,
      serverTime: now,
      targetKills: PLAYER.targetKills,
      smokes: this.smokes.map((smoke) => ({
        id: smoke.id,
        x: smoke.x,
        y: smoke.y,
        z: smoke.z,
        radius: smoke.radius,
        expiresAt: smoke.expiresAt,
      })),
      players: [...this.players.values()].map((player) => {
        const slot = this.getActiveSlot(player);
        const weapon = getWeapon(slot.weaponId);
        return {
          id: player.id,
          name: player.name,
          color: player.color,
          isBot: player.isBot,
          bundleId: player.bundleId,
          slot: player.slot,
          weaponId: slot.weaponId,
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
          alive: player.alive,
          spawnProtected: now < player.spawnProtectionUntil,
          spawnProtectionUntil: player.spawnProtectionUntil,
          respawnAt: player.respawnAt,
          ammo: Number.isFinite(slot.ammo) ? slot.ammo : null,
          maxAmmo: weapon.unlimited ? null : weapon.magSize,
          reloading: slot.reloadUntil !== null,
          overheated: player.overheatedUntil !== null && now < player.overheatedUntil,
          heat: player.heat,
          shieldActive: weapon.type === 'shield',
        };
      }),
    };
  }
}
