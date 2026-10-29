import { simulateMovement } from '../shared/movement.js';

const MAX_PENDING_STEPS = 240;
const MAX_CORRECTION_DISTANCE = 2;
const CORRECTION_DECAY = 16;

function fromSnapshot(snapshot) {
  return {
    x: snapshot.x,
    y: snapshot.y,
    z: snapshot.z,
    vx: snapshot.vx ?? 0,
    vy: snapshot.vy ?? 0,
    vz: snapshot.vz ?? 0,
    yaw: snapshot.yaw ?? 0,
    grounded: snapshot.grounded ?? snapshot.y <= 0,
    wasJumping: snapshot.wasJumping === true,
    knockbackVX: snapshot.knockbackVX ?? 0,
    knockbackVZ: snapshot.knockbackVZ ?? 0,
    input: { forward: 0, strafe: 0, jump: false },
  };
}

/**
 * Prediction is local presentation, never a position sent to the server. The
 * server simulates the latest input at its own tick and acknowledges the last
 * sequence actually used. Replaying only newer render steps keeps the camera
 * responsive while every snapshot corrects collision, knockback and drift.
 */
export class LocalPrediction {
  constructor() {
    this.reset();
  }

  reset(snapshot = null) {
    this.state = snapshot ? fromSnapshot(snapshot) : null;
    this.pending = [];
    this.lastAck = -1;
    this.offset = { x: 0, y: 0, z: 0 };
  }

  hasActiveMotion() {
    if (!this.state) return false;
    return (
      !this.state.grounded
      || Math.hypot(this.state.vx || 0, this.state.vz || 0) > 0.015
      || Math.abs(this.state.vy || 0) > 0.015
    );
  }

  step(input, delta, map, cover) {
    if (!this.state || !map || !Number.isFinite(delta) || delta <= 0) return;
    const step = {
      seq: input.seq,
      delta: Math.min(delta, 0.1),
      input: {
        forward: input.forward,
        strafe: input.strafe,
        jump: input.jump,
        yaw: input.yaw,
        blocking: Boolean(input.blocking),
      },
    };
    this.apply(step, map, cover);
    this.pending.push(step);
    if (this.pending.length > MAX_PENDING_STEPS) this.pending.shift();
  }

  apply(step, map, cover) {
    this.state.yaw = step.input.yaw;
    this.state.input = step.input;
    simulateMovement(this.state, step.delta, map, cover);
  }

  reconcile(snapshot, map, cover) {
    if (!snapshot || !map) return 0;
    if (!this.state) {
      this.reset(snapshot);
      return 0;
    }
    // Older servers do not acknowledge inputs. Still accept authority; do not
    // replay an unknowable history on top of their snapshots.
    const ack = Number.isSafeInteger(snapshot.inputAck) ? snapshot.inputAck : null;
    if (ack !== null && ack < this.lastAck) return 0;
    const displayed = {
      x: this.state.x + this.offset.x,
      y: this.state.y + this.offset.y,
      z: this.state.z + this.offset.z,
    };
    this.pending = ack === null ? [] : this.pending.filter((step) => step.seq > ack);
    if (ack !== null) this.lastAck = ack;
    this.state = fromSnapshot(snapshot);
    for (const step of this.pending) this.apply(step, map, cover);
    const correction = {
      x: displayed.x - this.state.x,
      y: displayed.y - this.state.y,
      z: displayed.z - this.state.z,
    };
    const dist = Math.hypot(correction.x, correction.y, correction.z);
    // Respawns and very large corrections must not interpolate through walls.
    this.offset = dist > MAX_CORRECTION_DISTANCE
      ? { x: 0, y: 0, z: 0 }
      : correction;
    return dist;
  }

  sample(delta = 0) {
    if (!this.state) return null;
    const decay = Math.exp(-CORRECTION_DECAY * Math.max(0, Math.min(delta, 0.1)));
    this.offset.x *= decay;
    this.offset.y *= decay;
    this.offset.z *= decay;
    return {
      x: this.state.x + this.offset.x,
      y: this.state.y + this.offset.y,
      z: this.state.z + this.offset.z,
    };
  }
}

// Latest-state input is sufficient for the server. Send key edges immediately
// and a 20 Hz heartbeat while held, rather than a packet per display frame.
// Angle changes are included in every heartbeat.
export class InputCadence {
  constructor(intervalMs = 50) {
    this.intervalMs = intervalMs;
    this.reset();
  }

  reset() {
    this.lastSentAt = -Infinity;
    this.last = null;
  }

  shouldSend(input, now) {
    const changed = !this.last || ['forward', 'strafe', 'jump', 'blocking']
      .some((key) => Boolean(input[key]) !== Boolean(this.last[key]) || input[key] !== this.last[key]);
    return changed || now - this.lastSentAt >= this.intervalMs;
  }

  sent(input, now) {
    this.last = { ...input };
    this.lastSentAt = now;
  }
}
