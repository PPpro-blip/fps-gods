const MAX_SAMPLES = 120;
const STALL_THRESHOLD_MS = 34;

function pushBounded(list, value, limit = MAX_SAMPLES) {
  list.push(value);
  if (list.length > limit) {
    list.shift();
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  return total / values.length;
}

/**
 * Correlated client runtime & network telemetry.
 *
 * All round-trip timings compare timestamps captured on the SAME monotonic
 * clock (`now` / `performance.now()`) via correlated sequence IDs (`pingId`,
 * `inputSeq`, `shotSeq`) — never subtracting unsynchronized client vs server
 * wall clocks.
 */
export class RuntimeDiagnostics {
  constructor() {
    this.frameDeltasMs = [];
    this.frameStalls = 0;
    this.pingSamplesMs = [];
    this.rttMs = 0;
    this.jitterMs = 0;
    this.pendingPings = new Map();
    this.nextPingId = 1;

    this.sentInputs = new Map();
    this.inputAckRttSamplesMs = [];
    this.lastAckedSeq = -1;

    this.reconcileErrorSamplesCm = [];
    this.snapshotIntervalsMs = [];
    this.lastSnapshotLocalAt = null;

    this.pendingShotAt = null;
    this.shotConfirmSamplesMs = [];
  }

  resetMatch() {
    this.sentInputs.clear();
    this.inputAckRttSamplesMs.length = 0;
    this.reconcileErrorSamplesCm.length = 0;
    this.snapshotIntervalsMs.length = 0;
    this.lastSnapshotLocalAt = null;
    this.lastAckedSeq = -1;
    this.pendingShotAt = null;
  }

  recordFrame(dtSeconds) {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const ms = dtSeconds * 1000;
    pushBounded(this.frameDeltasMs, ms);
    if (ms > STALL_THRESHOLD_MS) {
      this.frameStalls += 1;
    }
  }

  createPing(localNow) {
    const pingId = this.nextPingId++;
    this.pendingPings.set(pingId, localNow);
    if (this.pendingPings.size > 32) {
      const oldestKey = this.pendingPings.keys().next().value;
      this.pendingPings.delete(oldestKey);
    }
    return { pingId };
  }

  recordPong(payload, localNow) {
    const pingId = Number(payload?.pingId);
    if (!Number.isFinite(pingId)) return null;
    const sentAt = this.pendingPings.get(pingId);
    if (sentAt === undefined) return null;
    this.pendingPings.delete(pingId);
    const sample = Math.max(0, localNow - sentAt);
    if (this.pingSamplesMs.length > 0) {
      const diff = Math.abs(sample - this.rttMs);
      this.jitterMs += (diff - this.jitterMs) / 8;
    }
    this.rttMs = this.pingSamplesMs.length === 0 ? sample : this.rttMs * 0.75 + sample * 0.25;
    pushBounded(this.pingSamplesMs, sample, 60);
    return sample;
  }

  recordInputSent(seq, localNow) {
    if (!Number.isFinite(seq)) return;
    this.sentInputs.set(seq, localNow);
    if (this.sentInputs.size > 256) {
      const oldest = this.sentInputs.keys().next().value;
      this.sentInputs.delete(oldest);
    }
  }

  recordSnapshot(inputAck, reconcileDistanceMeters, localNow) {
    if (this.lastSnapshotLocalAt !== null) {
      const gap = Math.max(0, localNow - this.lastSnapshotLocalAt);
      if (gap < 2000) {
        pushBounded(this.snapshotIntervalsMs, gap, 60);
      }
    }
    this.lastSnapshotLocalAt = localNow;

    if (Number.isFinite(reconcileDistanceMeters) && reconcileDistanceMeters >= 0) {
      pushBounded(this.reconcileErrorSamplesCm, reconcileDistanceMeters * 100, 90);
    }

    if (Number.isFinite(inputAck) && inputAck > this.lastAckedSeq) {
      const sentAt = this.sentInputs.get(inputAck);
      if (sentAt !== undefined) {
        const ackMs = Math.max(0, localNow - sentAt);
        pushBounded(this.inputAckRttSamplesMs, ackMs, 60);
      }
      for (const key of this.sentInputs.keys()) {
        if (key <= inputAck) this.sentInputs.delete(key);
      }
      this.lastAckedSeq = inputAck;
    }
  }

  recordShotSent(localNow) {
    this.pendingShotAt = localNow;
  }

  recordShotConfirmed(localNow) {
    if (this.pendingShotAt === null) return null;
    const ms = Math.max(0, localNow - this.pendingShotAt);
    this.pendingShotAt = null;
    pushBounded(this.shotConfirmSamplesMs, ms, 40);
    return ms;
  }

  getSummary() {
    const avgFrameMs = mean(this.frameDeltasMs);
    const fps = avgFrameMs > 0 ? Math.round(1000 / avgFrameMs) : 0;
    return {
      fps,
      frameMeanMs: +avgFrameMs.toFixed(2),
      frameP95Ms: +percentile(this.frameDeltasMs, 0.95).toFixed(2),
      frameStalls: this.frameStalls,
      rttMs: Math.round(this.rttMs),
      jitterMs: +this.jitterMs.toFixed(1),
      inputAckMeanMs: +mean(this.inputAckRttSamplesMs).toFixed(1),
      reconcileMeanCm: +mean(this.reconcileErrorSamplesCm).toFixed(2),
      reconcileP95Cm: +percentile(this.reconcileErrorSamplesCm, 0.95).toFixed(2),
      snapshotIntervalMeanMs: +mean(this.snapshotIntervalsMs).toFixed(1),
      shotConfirmMeanMs: +mean(this.shotConfirmSamplesMs).toFixed(1),
    };
  }
}
