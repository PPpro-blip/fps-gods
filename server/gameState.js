import { EVENTS } from '../shared/events.js';
import { COVER, MAP, PLAYER, SPAWN_POINTS } from '../shared/gameConfig.js';
import { castShot } from './hitDetection.js';

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

function makeGamePlayer(record, spawn, now) {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
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
    ammo: PLAYER.magazineSize,
    nextShotAt: now,
    reloadUntil: null,
  };
}

// All movement, collision, health, weapon timing, damage, scoring, respawns,
// and win checks live here. Clients provide controls and render these results.
export class GameState {
  constructor(room, { emitRoom, emitPlayer }, now = Date.now()) {
    this.room = room;
    this.emitRoom = emitRoom;
    this.emitPlayer = emitPlayer;
    this.players = new Map();
    this.feed = [];
    this.finished = false;
    this.winner = null;

    const spawns = shuffled(SPAWN_POINTS);
    let index = 0;
    for (const record of room.players.values()) {
      const spawn = spawns[index % spawns.length];
      this.players.set(record.id, makeGamePlayer(record, spawn, now));
      index += 1;
    }
  }

  setInput(playerId, payload, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !payload || typeof payload !== 'object') return;
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

    for (const player of this.players.values()) {
      if (!player.alive) {
        if (player.respawnAt !== null && now >= player.respawnAt) this.respawn(player, now);
        continue;
      }
      if (now - player.lastInputAt > PLAYER.inputTimeoutMs) {
        player.input.forward = 0;
        player.input.strafe = 0;
        player.input.jump = false;
      }
      this.updatePlayer(player, delta);
      if (player.reloadUntil !== null && now >= player.reloadUntil) {
        player.ammo = PLAYER.magazineSize;
        player.reloadUntil = null;
        this.sendAmmo(player);
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

  shoot(playerId, now = Date.now()) {
    if (this.finished) return;
    const shooter = this.players.get(playerId);
    if (!shooter || !shooter.alive) return;
    if (shooter.reloadUntil !== null) return;
    if (now < shooter.nextShotAt) return;
    if (shooter.ammo <= 0) {
      this.reload(playerId, now);
      return;
    }

    shooter.nextShotAt = now + PLAYER.fireIntervalMs;
    shooter.ammo -= 1;
    if (shooter.ammo === 0) shooter.reloadUntil = now + PLAYER.reloadMs;
    this.sendAmmo(shooter);

    const origin = {
      x: shooter.x,
      y: shooter.y + PLAYER.eyeHeight,
      z: shooter.z,
    };
    const direction = aimDirection(shooter.yaw, shooter.pitch);
    const result = castShot({
      origin,
      direction,
      players: this.players,
      shooterId: shooter.id,
      maxDistance: PLAYER.shotRange,
    });

    if (!result) {
      this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, { hit: false });
      return;
    }

    const target = result.target;
    const protectedAtSpawn = now < target.spawnProtectionUntil;
    const damage = result.headshot ? 50 : 25;
    if (!protectedAtSpawn) target.health = Math.max(0, target.health - damage);

    this.emitPlayer(shooter.id, EVENTS.HIT_CONFIRMED, {
      hit: true,
      targetId: target.id,
      damage: protectedAtSpawn ? 0 : damage,
      headshot: result.headshot,
      protected: protectedAtSpawn,
      killed: !protectedAtSpawn && target.health === 0,
      point: result.point,
    });

    if (protectedAtSpawn) return;

    this.emitPlayer(target.id, EVENTS.HEALTH_UPDATE, {
      health: target.health,
      maxHealth: PLAYER.maxHealth,
      attackerId: shooter.id,
    });

    if (target.health === 0) this.killPlayer(shooter, target, result.headshot, now);
  }

  reload(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || player.reloadUntil !== null || player.ammo >= PLAYER.magazineSize) return;
    player.reloadUntil = now + PLAYER.reloadMs;
    this.sendAmmo(player);
  }

  sendAmmo(player) {
    this.emitPlayer(player.id, EVENTS.AMMO_UPDATE, {
      ammo: player.ammo,
      maxAmmo: PLAYER.magazineSize,
      reloading: player.reloadUntil !== null,
      reloadCompletesAt: player.reloadUntil,
    });
  }

  killPlayer(killer, victim, headshot, now) {
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
    killer.kills += 1;

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
    player.ammo = PLAYER.magazineSize;
    player.reloadUntil = null;
    player.nextShotAt = now + PLAYER.fireIntervalMs;
    player.input.forward = 0;
    player.input.strafe = 0;
    player.input.jump = false;
    player.wasJumping = false;

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
      }))
      .sort((left, right) => right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
  }

  getPublicState(now = Date.now()) {
    return {
      code: this.room.code,
      state: this.room.state,
      serverTime: now,
      targetKills: PLAYER.targetKills,
      players: [...this.players.values()].map((player) => ({
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
        alive: player.alive,
        spawnProtected: now < player.spawnProtectionUntil,
        spawnProtectionUntil: player.spawnProtectionUntil,
        respawnAt: player.respawnAt,
        ammo: player.ammo,
        maxAmmo: PLAYER.magazineSize,
        reloading: player.reloadUntil !== null,
      })),
    };
  }
}
