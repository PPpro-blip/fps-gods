// Only local presentation is predicted. Hits, damage and ammo stay authoritative.
// A bounded set prevents the server's accepted-shot echo from replaying the
// owner's muzzle flash/sound; unknown and rejected shots never imply a hit.
export class ShotFeedback {
  constructor({ ttlMs = 10_000, limit = 128 } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.pending = new Map();
  }

  remember(id, now) {
    this.expire(now);
    this.pending.set(id, now);
    while (this.pending.size > this.limit) this.pending.delete(this.pending.keys().next().value);
  }

  consume(id) {
    if (!Number.isSafeInteger(id) || !this.pending.has(id)) return false;
    this.pending.delete(id);
    return true;
  }

  expire(now) {
    for (const [id, created] of this.pending) {
      if (now - created > this.ttlMs) this.pending.delete(id);
    }
  }

  clear() {
    this.pending.clear();
  }
}
