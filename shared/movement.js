import { PLAYER } from './gameConfig.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

// The server owns the result. The client uses these exact rules only to predict
// its own presentation between authoritative snapshots.
export function collidesWithCover(x, z, feetY, cover) {
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

/** Advance one already-validated movement state. Delta is always locally bounded. */
export function simulateMovement(player, deltaSeconds, map, cover) {
  const delta = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.1);
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
  const maxX = map.bounds.halfWidth - map.bounds.wallThickness / 2 - PLAYER.radius;
  const maxZ = map.bounds.halfDepth - map.bounds.wallThickness / 2 - PLAYER.radius;
  const candidateX = clamp(player.x + deltaX, -maxX, maxX);
  if (!collidesWithCover(candidateX, player.z, player.y, cover)) player.x = candidateX;
  const candidateZ = clamp(player.z + deltaZ, -maxZ, maxZ);
  if (!collidesWithCover(player.x, candidateZ, player.y, cover)) player.z = candidateZ;
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
