import { COVER, PLAYER } from '../shared/gameConfig.js';
import { COMBAT_HITBOXES } from '../shared/combatHitboxes.js';

const EPSILON = 1e-8;

// Slab intersection for an axis-aligned cover block. The result is the first
// non-negative ray distance, or Infinity when the ray misses the block.
export function rayBoxDistance(origin, direction, block, maxDistance = PLAYER.shotRange) {
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

function normalizedRay(direction) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < EPSILON) return null;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

function pointAlong(origin, direction, distance) {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance,
  };
}

// Finds the first cover/floor impact for a projectile. The cover reference is
// per-match so rockets can remove a block without changing other rooms.
export function raycastCover({
  origin,
  direction,
  cover = COVER,
  maxDistance = PLAYER.shotRange,
  includeFloor = true,
}) {
  const ray = normalizedRay(direction);
  if (!ray) return null;

  let nearestDistance = Infinity;
  let nearestBlock = null;
  for (const block of cover) {
    const distance = rayBoxDistance(origin, ray, block, maxDistance);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestBlock = block;
    }
  }

  let hitFloor = false;
  if (includeFloor && ray.y < -EPSILON) {
    const floorDistance = -origin.y / ray.y;
    if (floorDistance >= 0 && floorDistance <= maxDistance && floorDistance < nearestDistance) {
      nearestDistance = floorDistance;
      nearestBlock = null;
      hitFloor = true;
    }
  }

  if (!Number.isFinite(nearestDistance)) return null;
  return {
    distance: nearestDistance,
    block: nearestBlock,
    hitFloor,
    point: pointAlong(origin, ray, nearestDistance),
  };
}

// Intersect a vertical, flat-capped combat cylinder, independent of movement.
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

function raySphereDistance(origin, direction, sphere, maxDistance) {
  const radius = Number(sphere.radius);
  if (!Number.isFinite(radius) || radius <= 0) return Infinity;
  const offsetX = origin.x - sphere.x;
  const offsetY = origin.y - sphere.y;
  const offsetZ = origin.z - sphere.z;
  const projection = offsetX * direction.x + offsetY * direction.y + offsetZ * direction.z;
  const offsetLengthSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
  const c = offsetLengthSquared - radius * radius;
  if (c <= 0) return 0;

  const discriminant = projection * projection - c;
  if (discriminant < 0) return Infinity;
  const distance = -projection - Math.sqrt(discriminant);
  return distance >= 0 && distance <= maxDistance ? distance : Infinity;
}

function nearestSmokeDistance(origin, direction, smokeClouds, maxDistance) {
  let nearest = Infinity;
  for (const cloud of smokeClouds) {
    nearest = Math.min(nearest, raySphereDistance(origin, direction, cloud, maxDistance));
  }
  return nearest;
}

// Returns only the first server-verified target in line of sight. The client
// never sends a target id or damage value, so it cannot choose its own hit.
export function castShot({
  origin,
  direction,
  players,
  shooterId,
  maxDistance = PLAYER.shotRange,
  cover = COVER,
  smokeClouds = [],
  ignoreCover = false,
  onTrace = null,
}) {
  const ray = normalizedRay(direction);
  if (!ray) return null;

  const obstruction = raycastCover({
    origin,
    direction: ray,
    cover: ignoreCover ? [] : cover,
    maxDistance,
    includeFloor: true,
  });
  const coverDistance = obstruction?.distance ?? Infinity;
  const smokeDistance = nearestSmokeDistance(origin, ray, smokeClouds, maxDistance);
  const blockingDistance = Math.min(maxDistance, coverDistance, smokeDistance);
  let nearestPlayer = null;
  let nearestDistance = blockingDistance;
  let headshot = false;

  for (const target of players.values()) {
    if (target.id === shooterId || !target.alive || target.connected === false) continue;

    for (const volume of COMBAT_HITBOXES) {
      const distance = rayCylinderDistance(
        origin, ray, target.x, target.z, volume.radius,
        target.y + volume.bottom, target.y + volume.top, nearestDistance,
      );
      if (!(distance < nearestDistance)) continue;

      // A wider combat volume must not protrude through nearby collision cover.
      // Check the short segment from the struck surface to the target's axis.
      if (!ignoreCover && cover.length) {
        const point = pointAlong(origin, ray, distance);
        const dx = target.x - point.x;
        const dz = target.z - point.z;
        const length = Math.hypot(dx, dz);
        if (length > EPSILON) {
          const inward = { x: dx / length, y: 0, z: dz / length };
          if (cover.some(block => rayBoxDistance(point, inward, block, length) < length - EPSILON)) continue;
        }
      }
      nearestDistance = distance;
      nearestPlayer = target;
      headshot = volume.headshot;
    }
  }

  if (onTrace) {
    const distance = nearestPlayer ? nearestDistance : blockingDistance;
    const kind = nearestPlayer ? 'player' : coverDistance <= smokeDistance && coverDistance <= maxDistance
      ? (obstruction?.hitFloor ? 'floor' : 'cover')
      : smokeDistance <= maxDistance ? 'smoke' : 'miss';
    onTrace({ origin: { ...origin }, point: pointAlong(origin, ray, distance), kind,
      ...(nearestPlayer ? { targetId: nearestPlayer.id, headshot } : {}) });
  }

  if (!nearestPlayer) return null;
  return {
    target: nearestPlayer,
    distance: nearestDistance,
    headshot,
    point: pointAlong(origin, ray, nearestDistance),
  };
}
