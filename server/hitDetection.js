import { COVER, PLAYER } from '../shared/gameConfig.js';

const EPSILON = 1e-8;

// Slab intersection for an axis-aligned cover block. The result is the first
// non-negative ray distance, or Infinity when the ray misses the block.
export function rayBoxDistance(origin, direction, block, maxDistance) {
  const bounds = [
    [block.x - block.width / 2, block.x + block.width / 2, origin.x, direction.x],
    [0, block.height, origin.y, direction.y],
    [block.z - block.depth / 2, block.z + block.depth / 2, origin.z, direction.z],
  ];
  let near = 0;
  let far = maxDistance;

  for (const [minimum, maximum, position, velocity] of bounds) {
    if (Math.abs(velocity) < EPSILON) {
      if (position < minimum || position > maximum) return Infinity;
      continue;
    }

    let first = (minimum - position) / velocity;
    let second = (maximum - position) / velocity;
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first);
    far = Math.min(far, second);
    if (near > far) return Infinity;
  }

  return near <= maxDistance ? near : Infinity;
}

// Intersect a vertical, flat-capped cylinder. Separate body and head cylinders
// let the server award a headshot only in the capsule's top twenty percent.
function rayCylinderDistance(origin, direction, centerX, centerZ, radius, bottom, top, maxDistance) {
  const offsetX = origin.x - centerX;
  const offsetZ = origin.z - centerZ;
  const a = direction.x * direction.x + direction.z * direction.z;
  const b = 2 * (offsetX * direction.x + offsetZ * direction.z);
  const c = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
  let nearest = Infinity;

  if (a > EPSILON) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const distance of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (distance < 0 || distance > maxDistance || distance >= nearest) continue;
        const height = origin.y + direction.y * distance;
        if (height >= bottom - EPSILON && height <= top + EPSILON) nearest = distance;
      }
    }
  }

  if (Math.abs(direction.y) > EPSILON) {
    for (const capHeight of [bottom, top]) {
      const distance = (capHeight - origin.y) / direction.y;
      if (distance < 0 || distance > maxDistance || distance >= nearest) continue;
      const x = origin.x + direction.x * distance - centerX;
      const z = origin.z + direction.z * distance - centerZ;
      if (x * x + z * z <= radius * radius + EPSILON) nearest = distance;
    }
  }

  return nearest;
}

function nearestCover(origin, direction, maxDistance) {
  let nearest = Infinity;
  for (const block of COVER) {
    nearest = Math.min(nearest, rayBoxDistance(origin, direction, block, maxDistance));
  }

  // A downward shot can hit the arena floor before reaching another player.
  if (direction.y < -EPSILON) {
    const floorDistance = -origin.y / direction.y;
    if (floorDistance >= 0 && floorDistance <= maxDistance) nearest = Math.min(nearest, floorDistance);
  }
  return nearest;
}

// Distance at which a ray first touches an active smoke cloud, or Infinity.
function nearestSmoke(origin, direction, smokes, maxDistance) {
  let nearest = Infinity;
  for (const smoke of smokes ?? []) {
    const offsetX = smoke.x - origin.x;
    const offsetY = smoke.y - origin.y;
    const offsetZ = smoke.z - origin.z;
    const along = offsetX * direction.x + offsetY * direction.y + offsetZ * direction.z;
    if (along < 0 || along > maxDistance) continue;
    const closestSq = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - along * along;
    const radius = smoke.radius;
    if (closestSq <= radius * radius) nearest = Math.min(nearest, along);
  }
  return nearest;
}

/** True when a straight segment from `from` to `to` ignores cover and smoke. */
export function hasLineOfSight(from, to, smokes = []) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < EPSILON) return true;

  const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
  const coverDistance = nearestCover(from, direction, distance);
  if (coverDistance < distance - 0.05) return false;

  const smokeDistance = nearestSmoke(from, direction, smokes, distance);
  return smokeDistance >= distance - 0.05;
}

/** True when a projectile-sized point sits inside cover or outside the arena. */
export function pointHitsWorld(x, y, z, { halfWidth, halfDepth, wallThickness }) {
  const limitX = halfWidth - wallThickness / 2;
  const limitZ = halfDepth - wallThickness / 2;
  if (x < -limitX || x > limitX || z < -limitZ || z > limitZ || y > 12) return true;
  if (y < 0) return true;
  for (const block of COVER) {
    if (
      x >= block.x - block.width / 2 && x <= block.x + block.width / 2
      && z >= block.z - block.depth / 2 && z <= block.z + block.depth / 2
      && y <= block.height
    ) return true;
  }
  return false;
}

// Returns only the first server-verified target in line of sight. The client
// never sends a target id or damage value, so it cannot choose its own hit.
// `piercesWalls` (railgun) flies through cover; `piercesPlayers` collects
// every player along the ray, nearest first.
export function castShot({
  origin,
  direction,
  players,
  shooterId,
  maxDistance = 85,
  smokes = [],
  piercesWalls = false,
  piercesPlayers = false,
}) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < EPSILON) return null;

  const ray = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };

  let wallDistance = piercesWalls ? maxDistance : nearestCover(origin, ray, maxDistance);
  if (!piercesWalls) wallDistance = Math.min(wallDistance, nearestSmoke(origin, ray, smokes, maxDistance));

  const hits = [];
  let nearestDistance = Math.min(maxDistance, wallDistance);
  let nearestPlayer = null;
  let headshot = false;

  for (const target of players.values()) {
    if (target.id === shooterId || !target.alive) continue;

    const headBottom = target.y + PLAYER.height * 0.8;
    const headDistance = rayCylinderDistance(
      origin,
      ray,
      target.x,
      target.z,
      PLAYER.radius * 0.63,
      headBottom,
      target.y + PLAYER.height,
      piercesPlayers ? maxDistance : nearestDistance,
    );
    const bodyDistance = rayCylinderDistance(
      origin,
      ray,
      target.x,
      target.z,
      PLAYER.radius,
      target.y + 0.2,
      headBottom + 0.03,
      piercesPlayers ? maxDistance : nearestDistance,
    );
    const playerDistance = Math.min(headDistance, bodyDistance);
    const playerHeadshot = headDistance <= bodyDistance;

    if (piercesPlayers) {
      if (playerDistance < wallDistance && playerDistance < maxDistance) {
        hits.push({
          target,
          distance: playerDistance,
          headshot: playerHeadshot,
          point: {
            x: origin.x + ray.x * playerDistance,
            y: origin.y + ray.y * playerDistance,
            z: origin.z + ray.z * playerDistance,
          },
        });
      }
      continue;
    }

    if (playerDistance < nearestDistance) {
      nearestDistance = playerDistance;
      nearestPlayer = target;
      headshot = playerHeadshot;
    }
  }

  if (piercesPlayers) {
    hits.sort((left, right) => left.distance - right.distance);
    return hits.length ? { hits } : null;
  }

  if (!nearestPlayer) return null;
  return {
    target: nearestPlayer,
    distance: nearestDistance,
    headshot,
    point: {
      x: origin.x + ray.x * nearestDistance,
      y: origin.y + ray.y * nearestDistance,
      z: origin.z + ray.z * nearestDistance,
    },
  };
}
