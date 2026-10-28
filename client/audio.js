// Synthesised weapon and UI audio.
//
// The repository ships no audio assets, so this generates short cues with the
// Web Audio API instead of pretending a sound file exists. It is intentionally
// small: loudness is driven by the settings volume slider, a noisy gunfight is
// rate-limited, and nothing is created until the first user gesture (browsers
// block audio contexts otherwise).

const SOUND_MIN_GAP_MS = Object.freeze({
  shot: 45,
  hit: 35,
  kill: 120,
  reload: 120,
  empty: 180,
  spawn: 400,
  ui: 40,
  damage: 90,
});

export class AudioEngine {
  constructor({ volume = 0.65 } = {}) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.lastPlayed = new Map();
    this.enabled = true;
  }

  /** Must be called from a user gesture before any sound will be produced. */
  unlock() {
    if (typeof window === 'undefined') return false;
    if (!this.context) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) return false;
      try {
        this.context = new Ctor({ latencyHint: 'interactive' });
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
        this.noiseBuffer = this.buildNoiseBuffer();
      } catch (error) {
        console.warn('[FPS GODS] Audio is unavailable:', error);
        this.context = null;
        return false;
      }
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return true;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.master) this.master.gain.value = this.volume;
  }

  buildNoiseBuffer(duration = 0.35) {
    const rate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, Math.ceil(rate * duration), rate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  canPlay(kind) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return false;
    const gap = SOUND_MIN_GAP_MS[kind] ?? 40;
    const now = performance.now();
    const last = this.lastPlayed.get(kind);
    // A missing entry must not be read as "played at time zero": on a page that
    // has just loaded, `now` can be smaller than the gap and the first cue would
    // be swallowed.
    if (last !== undefined && now - last < gap) return false;
    this.lastPlayed.set(kind, now);
    return true;
  }

  noise({ duration = 0.12, frequency = 900, gain = 0.35, type = 'bandpass', q = 0.9 } = {}) {
    if (!this.noiseBuffer) return;
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, now + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(envelope).connect(this.master);
    source.start(now);
    source.stop(now + duration + 0.02);
  }

  tone({ frequency = 440, duration = 0.1, gain = 0.18, type = 'sine', slideTo = null } = {}) {
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  /** @param {string} kind one of shot | hit | kill | reload | empty | spawn | ui | damage */
  play(kind, options = {}) {
    if (!this.canPlay(kind)) return false;
    switch (kind) {
      case 'shot': {
        if (options.weaponClass === 'melee') {
          this.noise({ duration: 0.09, frequency: 1350, gain: 0.12, q: 0.7 });
          return true;
        }
        const heavy = options.weaponClass === 'heavy';
        this.noise({ duration: heavy ? 0.2 : 0.1, frequency: heavy ? 520 : 1500, gain: heavy ? 0.42 : 0.3, q: 0.7 });
        this.tone({ frequency: heavy ? 90 : 150, slideTo: heavy ? 45 : 80, duration: 0.12, gain: 0.16, type: 'square' });
        return true;
      }
      case 'hit':
        this.tone({ frequency: 1180, duration: 0.06, gain: 0.12, type: 'triangle' });
        return true;
      case 'kill':
        this.tone({ frequency: 880, duration: 0.09, gain: 0.16, type: 'triangle' });
        this.tone({ frequency: 1320, duration: 0.14, gain: 0.12, type: 'sine' });
        return true;
      case 'reload':
        this.noise({ duration: 0.06, frequency: 2200, gain: 0.16, type: 'highpass', q: 0.6 });
        this.noise({ duration: 0.08, frequency: 700, gain: 0.14, type: 'bandpass', q: 1.4 });
        return true;
      case 'empty':
        this.noise({ duration: 0.04, frequency: 3400, gain: 0.12, type: 'highpass' });
        return true;
      case 'spawn':
        this.tone({ frequency: 260, slideTo: 520, duration: 0.28, gain: 0.1, type: 'sine' });
        return true;
      case 'damage':
        this.noise({ duration: 0.12, frequency: 320, gain: 0.28, type: 'lowpass', q: 0.8 });
        return true;
      case 'ui':
        this.tone({ frequency: 640, duration: 0.035, gain: 0.07, type: 'square' });
        return true;
      default:
        return false;
    }
  }

  dispose() {
    this.context?.close?.().catch?.(() => {});
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}
