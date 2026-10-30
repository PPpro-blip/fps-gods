import * as THREE from 'three';
import { PLAYER } from '../shared/gameConfig.js';

export const INTEL_RANGE = 55;
export const MAX_DAMAGE_NUMBERS = 24;

// Segment against the same AABBs used by server movement and hit detection.
export function isOccluded(start, end, cover) {
  for (const b of cover) {
    let near = 0; let far = 1;
    for (const [axis, min, max] of [
      ['x', b.x - b.width / 2, b.x + b.width / 2],
      ['y', 0, b.height],
      ['z', b.z - b.depth / 2, b.z + b.depth / 2],
    ]) {
      const d = end[axis] - start[axis];
      if (Math.abs(d) < 1e-8) {
        if (start[axis] < min || start[axis] > max) { near = 2; break; }
      } else {
        const a = (min - start[axis]) / d;
        const c = (max - start[axis]) / d;
        near = Math.max(near, Math.min(a, c));
        far = Math.min(far, Math.max(a, c));
      }
      if (near > far) break;
    }
    if (near <= far && far >= 0 && near < 1) return true;
  }
  return false;
}

export function smokeOccludes(start, end, clouds) {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const length2 = dx * dx + dy * dy + dz * dz;
  return clouds.some(cloud => {
    if (!(cloud.radius > 0) || !length2) return false;
    const t = Math.max(0, Math.min(1, ((cloud.x - start.x) * dx + (cloud.y - start.y) * dy + (cloud.z - start.z) * dz) / length2));
    return (start.x + dx * t - cloud.x) ** 2 + (start.y + dy * t - cloud.y) ** 2 + (start.z + dz * t - cloud.z) ** 2 <= cloud.radius ** 2;
  });
}

export class CombatIntel {
  constructor(root) {
    this.root = root;
    this.bars = new Map();
    this.numbers = [];
    this.projected = new THREE.Vector3();
  }

  health(data) {
    if (!data || typeof data.targetId !== 'string' || !Number.isFinite(data.health) || !(data.maxHealth > 0)) return;
    let bar = this.bars.get(data.targetId);
    if (!bar) {
      const element = document.createElement('div');
      element.className = 'opponent-health';
      element.style.display = 'none';
      const fill = document.createElement('div');
      fill.className = 'opponent-health-fill';
      element.appendChild(fill);
      this.root.appendChild(element);
      bar = { element, fill, receivedAt: performance.now() };
      this.bars.set(data.targetId, bar);
    }
    bar.fill.style.width = `${Math.max(0, Math.min(100, 100 * data.health / data.maxHealth))}%`;
  }

  hit(hit, now = performance.now()) {
    if (!hit?.hit || hit.opponent === false || !(hit.damage > 0) || !hit.point
      || !['x', 'y', 'z'].every(k => Number.isFinite(hit.point[k]))) return;
    if (this.numbers.length >= MAX_DAMAGE_NUMBERS) this.numbers.shift().element.remove();
    const element = document.createElement('div');
    element.className = `damage-number${hit.headshot ? ' is-critical' : ''}`;
    element.style.display = 'none';
    element.textContent = Number.isInteger(hit.damage) ? String(hit.damage) : String(Math.round(hit.damage * 10) / 10);
    this.root.appendChild(element);
    // Alternate small offsets instead of stacking directly over the crosshair.
    const offset = ((this.numbers.length % 5) - 2) * 0.12;
    this.numbers.push({ element, point: { ...hit.point }, start: now, offset });
  }

  resetTarget(id) {
    const bar = this.bars.get(id);
    if (bar) bar.element.remove();
    this.bars.delete(id);
  }

  update(players, interpolator, camera, renderAt, localId, cover, now = performance.now(), smoke = []) {
    const byId = new Map(players.map(p => [p.id, p]));
    const local = byId.get(localId);
    for (const [id, bar] of this.bars) {
      const target = byId.get(id);
      if (!target) {
        bar.element.style.display = 'none';
        if (players.length && now - bar.receivedAt > 1000) this.resetTarget(id);
        continue;
      }
      if (target.alive === false || target.connected === false) { this.resetTarget(id); continue; }
      const sameTeam = local?.teamId != null && local.teamId === target.teamId;
      const pose = interpolator.sample(id, renderAt) ?? target;
      const head = { x: pose.x, y: pose.y + PLAYER.height + 0.18, z: pose.z };
      const distance = camera.position.distanceTo(this.projected.set(head.x, head.y, head.z));
      const visible = !sameTeam && distance <= INTEL_RANGE && !isOccluded(camera.position, head, cover) && !smokeOccludes(camera.position, head, smoke);
      this.projected.set(head.x, head.y, head.z).project(camera);
      const p = this.projected;
      const onScreen = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
      bar.element.style.display = visible && onScreen ? 'block' : 'none';
      if (visible && onScreen) {
        bar.element.style.left = `${(p.x * 0.5 + 0.5) * window.innerWidth}px`;
        bar.element.style.top = `${(-p.y * 0.5 + 0.5) * window.innerHeight}px`;
      }
    }
    this.numbers = this.numbers.filter(item => {
      const age = (now - item.start) / 850;
      if (age >= 1) { item.element.remove(); return false; }
      this.projected.set(item.point.x + item.offset, item.point.y + age * 0.8, item.point.z).project(camera);
      const p = this.projected;
      item.element.style.display = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 ? 'block' : 'none';
      item.element.style.left = `${(p.x * 0.5 + 0.5) * window.innerWidth}px`;
      item.element.style.top = `${(-p.y * 0.5 + 0.5) * window.innerHeight}px`;
      item.element.style.opacity = String(Math.max(0, 1 - age * age));
      return true;
    });
  }

  clear() {
    for (const id of this.bars.keys()) this.resetTarget(id);
    for (const item of this.numbers) item.element.remove();
    this.numbers = [];
  }
}
