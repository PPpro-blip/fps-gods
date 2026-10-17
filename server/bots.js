import { BOTS, BOT_WAYPOINTS, PLAYER } from '../shared/gameConfig.js';
import { getBundle, getWeapon, PRIMARY_SLOT } from '../shared/weapons.js';
import { hasLineOfSight } from './hitDetection.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const wrapAngle = (angle) => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const thinkSeconds = BOTS.tickMs / 1_000;

function randomWaypoint(awayFrom) {
  let best = BOT_WAYPOINTS[0];
  let bestScore = -Infinity;
  for (const waypoint of BOT_WAYPOINTS) {
    const distance = awayFrom
      ? Math.hypot(waypoint.x - awayFrom.x, waypoint.z - awayFrom.z)
      : 10;
    // Prefer far waypoints so bots actually cover ground between fights.
    const score = distance + Math.random() * 14;
    if (score > bestScore) {
      bestScore = score;
      best = waypoint;
    }
  }
  return { x: best.x, z: best.z };
}

function makeBrain(player, now) {
  return {
    id: player.id,
    waypoint: null,
    waypointUntil: 0,
    lastX: player.x,
    lastZ: player.z,
    stuckMs: 0,
    nextGrenadeAt: now + 4_000 + Math.random() * 8_000,
    acquiredAt: 0,
    targetId: null,
  };
}

// 10 Hz server-side brains for GOD_BOT_*. Bots never exist on the client as
// anything but ordinary players: they path between waypoints, face the nearest
// human, and fire through GameState.shoot() so every shot obeys the same
// server-side weapon rules and HIT events as a human trigger pull.
export class BotController {
  constructor(game) {
    this.game = game;
    this.brains = new Map();
    for (const player of game.players.values()) {
      if (player.isBot) this.brains.set(player.id, makeBrain(player, Date.now()));
    }
  }

  forget(playerId) {
    this.brains.delete(playerId);
  }

  onRespawn(player, now) {
    const brain = this.brains.get(player.id);
    if (!brain) return;
    brain.waypoint = null;
    brain.waypointUntil = 0;
    brain.stuckMs = 0;
    brain.targetId = null;
    brain.acquiredAt = 0;
    brain.nextGrenadeAt = now + 3_000 + Math.random() * 8_000;
  }

  think(now) {
    for (const [id, brain] of [...this.brains]) {
      const bot = this.game.players.get(id);
      if (!bot) {
        this.brains.delete(id);
        continue;
      }
      if (!bot.alive) continue;
      this.thinkOne(bot, brain, now);
    }
  }

  thinkOne(bot, brain, now) {
    const target = this.pickTarget(bot);
    this.updateTargetMemory(bot, brain, target, now);
    this.chooseSlot(bot, brain, target, now);
    this.faceTarget(bot, target, now);
    this.navigate(bot, brain, target, now);
    this.tryFire(bot, brain, target, now);
  }

  pickTarget(bot) {
    let best = null;
    let bestDistance = Infinity;
    let bestHumanDistance = Infinity;
    let human = null;

    for (const candidate of this.game.players.values()) {
      if (candidate.id === bot.id || !candidate.alive) continue;
      const distance = Math.hypot(candidate.x - bot.x, candidate.z - bot.z);
      if (!candidate.isBot && distance < bestHumanDistance) {
        bestHumanDistance = distance;
        human = candidate;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }

    // Humans always take priority; bots only duel each other while nobody else
    // is alive, so solo matches stay focused on the player.
    return human ?? best;
  }

  updateTargetMemory(bot, brain, target, now) {
    if (target && brain.targetId !== target.id) {
      brain.targetId = target.id;
      // Human-like reaction pause before the first shot on a new target.
      brain.acquiredAt = now + 260 + Math.random() * 320;
    } else if (!target) {
      brain.targetId = null;
      brain.acquiredAt = 0;
    }
  }

  chooseSlot(bot, brain, target, now) {
    if (!target) return;
    const distance = Math.hypot(target.x - bot.x, target.z - bot.z);
    const bundle = getBundle(bot.bundleId);
    let slot = PRIMARY_SLOT;

    if (bundle.id === 'rusher') {
      if (distance < 2.3) slot = 2; // knife
      else if (distance < 15) slot = 1; // shotgun
      else slot = 0; // smg
    } else if (bundle.id === 'ghost') {
      if (now >= brain.nextGrenadeAt && this.game.smokes.length < 3) slot = 2; // smoke
      else slot = distance > 26 ? 1 : 0; // sniper : pistol
    } else {
      // HEAVY: hold the LMG, occasionally reach for the rocket.
      slot = distance > 16 && distance < 62 && Math.random() < 0.025 ? 1 : 0;
    }

    if (slot !== bot.slot) this.game.switchWeapon(bot.id, slot, now);
  }

  faceTarget(bot, target, now) {
    if (!target) return;
    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const horizontal = Math.hypot(dx, dz) || 1;
    const desiredYaw = Math.atan2(-dx, -dz);
    const desiredPitch = clamp(
      Math.atan2(target.y + PLAYER.height * 0.55 - (bot.y + PLAYER.eyeHeight), horizontal),
      -1.2,
      1.2,
    );

    // Snap-lean aim: closes most of the gap each tick without teleporting.
    const turn = clamp(BOTS.turnSpeed * thinkSeconds, 0, 1);
    bot.yaw = wrapAngle(bot.yaw + wrapAngle(desiredYaw - bot.yaw) * turn);
    bot.pitch += (desiredPitch - bot.pitch) * turn;
  }

  navigate(bot, brain, target, now) {
    const arrived = brain.waypoint
      && Math.hypot(brain.waypoint.x - bot.x, brain.waypoint.z - bot.z) < 1.4;
    if (!brain.waypoint || arrived || now >= brain.waypointUntil) {
      brain.waypoint = randomWaypoint(bot);
      brain.waypointUntil = now + BOTS.waypointTimeoutMs * (0.7 + Math.random() * 0.6);
      brain.stuckMs = 0;
    }

    const moved = Math.hypot(bot.x - brain.lastX, bot.z - brain.lastZ);
    if (moved < 0.09) {
      brain.stuckMs += BOTS.tickMs;
      if (brain.stuckMs > 900) {
        brain.waypoint = randomWaypoint(bot);
        brain.waypointUntil = now + BOTS.waypointTimeoutMs;
        brain.stuckMs = 0;
        bot.input.jump = true;
      }
    } else {
      brain.stuckMs = 0;
      bot.input.jump = false;
    }
    brain.lastX = bot.x;
    brain.lastZ = bot.z;

    const toX = brain.waypoint.x - bot.x;
    const toZ = brain.waypoint.z - bot.z;
    const length = Math.hypot(toX, toZ) || 1;
    const desiredX = toX / length;
    const desiredZ = toZ / length;

    // Movement is expressed in the bot's yaw frame, same contract as humans.
    const forwardX = -Math.sin(bot.yaw);
    const forwardZ = -Math.cos(bot.yaw);
    const rightX = Math.cos(bot.yaw);
    const rightZ = -Math.sin(bot.yaw);
    bot.input.forward = clamp(desiredX * forwardX + desiredZ * forwardZ, -1, 1);
    bot.input.strafe = clamp(desiredX * rightX + desiredZ * rightZ, -1, 1);
  }

  tryFire(bot, brain, target, now) {
    if (!target || now < brain.acquiredAt) return;

    const slot = this.game.getActiveSlot(bot);
    const weapon = getWeapon(slot.weaponId);
    const distance = Math.hypot(target.x - bot.x, target.z - bot.z);

    if (weapon.type === 'shield') {
      this.game.switchWeapon(bot.id, PRIMARY_SLOT, now);
      return;
    }

    const eye = { x: bot.x, y: bot.y + PLAYER.eyeHeight, z: bot.z };
    const targetEye = { x: target.x, y: target.y + PLAYER.height * 0.55, z: target.z };
    const clearShot = hasLineOfSight(eye, targetEye, this.game.smokes);

    if (weapon.type === 'grenade') {
      if (now >= brain.nextGrenadeAt && distance < weapon.range * 0.85) {
        brain.nextGrenadeAt = now + 11_000 + Math.random() * 9_000;
        bot.pitch = clamp(bot.pitch + 0.12, -1.45, 1.45);
        this.game.shoot(bot.id, now);
      }
      return;
    }

    const inRange = weapon.type === 'melee'
      ? distance <= weapon.range * 0.92
      : distance <= weapon.range * BOTS.fireRangeBuffer;

    if (!inRange || !clearShot) {
      // Reload behind cover whenever the magazine is low and nobody is visible.
      if (!clearShot && !weapon.unlimited && weapon.magSize > 0 && slot.ammo <= weapon.magSize * 0.25) {
        this.game.reload(bot.id, now);
      }
      return;
    }

    if (now < slot.nextShotAt) return;
    if (!weapon.unlimited && weapon.magSize > 0 && slot.ammo <= 0) {
      this.game.reload(bot.id, now);
      return;
    }

    // Thirty percent of trigger pulls are deliberate misses: the bot throws a
    // random aim offset before the shared shoot pipeline resolves the shot.
    if (Math.random() < BOTS.missChance) {
      bot.yaw = wrapAngle(bot.yaw + (Math.random() * 2 - 1) * (0.07 + Math.random() * 0.13));
      bot.pitch = clamp(bot.pitch + (Math.random() * 2 - 1) * 0.07, -1.45, 1.45);
    }

    this.game.shoot(bot.id, now);
  }
}
