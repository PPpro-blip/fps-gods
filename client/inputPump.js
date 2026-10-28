// A single gameplay-only timer keeps held input and automatic fire progressing
// independently of requestAnimationFrame. No timer runs while input is disabled.
export class InputPump {
  constructor(tick, { intervalMs = 25, timers = globalThis } = {}) {
    this.tick = tick;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.handle = null;
  }

  start() {
    if (this.handle !== null) return;
    this.handle = this.timers.setInterval(this.tick, this.intervalMs);
  }

  stop() {
    if (this.handle === null) return;
    this.timers.clearInterval(this.handle);
    this.handle = null;
  }
}
