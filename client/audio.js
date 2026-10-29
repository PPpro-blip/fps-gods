// Synthesised weapon, movement, feedback, and subtle arena ambience audio.
//
// The repository ships no audio assets, so every cue is synthesised cleanly via
// Web Audio API. Loudness obeys the settings volume slider, rapid combat events
// are rate-limited against stacking, and zero audio nodes are created until a
// real user gesture unlocks the context.

const SOUND_MIN_GAP_MS = Object.freeze({
  shot: 42,
  hit: 32,
  kill: 110,
  reload: 120,
  switch: 90,
  empty: 180,
  spawn: 400,
  ui: 40,
  damage: 90,
  step: 215,
  jump: 180,
  land: 140,
  explosion: 85,
  shield: 85,
});

const AMBIENCE_PROFILES = Object.freeze({
  foundry: Object.freeze({ filterType: 'lowpass', frequency: 165, q: 0.9, gain: 0.018, humHz: 58, humGain: 0.008 }),
  orbital: Object.freeze({ filterType: 'bandpass', frequency: 310, q: 1.4, gain: 0.013, humHz: 92, humGain: 0.006 }),
  desert: Object.freeze({ filterType: 'bandpass', frequency: 440, q: 0.7, gain: 0.015, humHz: 0, humGain: 0 }),
});

export class AudioEngine {
  constructor({ volume = 0.65 } = {}) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.ambienceBuffer = null;
    this.ambienceNodes = null;
    this.desiredAmbience = null;
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
        this.noiseBuffer = this.buildNoiseBuffer(0.35);
      } catch (error) {
        console.warn('[FPS GODS] Audio is unavailable:', error);
        this.context = null;
        return false;
      }
    }
    if (this.context.state === 'suspended') {
      this.context.resume().then(() => {
        if (this.desiredAmbience) this.syncAmbience();
      }).catch(() => {});
    } else if (this.desiredAmbience) {
      this.syncAmbience();
    }
    return true;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.master) this.master.gain.value = this.volume;
    if (this.volume <= 0) {
      this.stopAmbienceNodes();
    } else if (this.desiredAmbience && !this.ambienceNodes) {
      this.syncAmbience();
    }
  }

  /**
   * Set subtle per-arena ambient room tone (`'foundry' | 'orbital' | 'desert'`)
   * or `null` to stop cleanly when leaving an active match.
   */
  setAmbience(style = null) {
    const normalized = style && Object.hasOwn(AMBIENCE_PROFILES, style) ? style : null;
    if (this.desiredAmbience === normalized && Boolean(this.ambienceNodes) === Boolean(normalized)) {
      return;
    }
    this.desiredAmbience = normalized;
    this.syncAmbience();
  }

  stopAmbienceNodes() {
    if (!this.ambienceNodes) return;
    const { source, hum, filter, gainNode, humGain } = this.ambienceNodes;
    try { source?.stop?.(); } catch {}
    try { hum?.stop?.(); } catch {}
    source?.disconnect?.();
    hum?.disconnect?.();
    filter?.disconnect?.();
    gainNode?.disconnect?.();
    humGain?.disconnect?.();
    this.ambienceNodes = null;
  }

  syncAmbience() {
    this.stopAmbienceNodes();
    if (!this.desiredAmbience || !this.enabled || this.volume <= 0) return;
    if (!this.context || this.context.state !== 'running' || !this.master) return;

    const profile = AMBIENCE_PROFILES[this.desiredAmbience];
    if (!profile) return;

    if (!this.ambienceBuffer) {
      this.ambienceBuffer = this.buildNoiseBuffer(1.8);
    }

    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    source.buffer = this.ambienceBuffer;
    source.loop = true;

    const filter = this.context.createBiquadFilter();
    filter.type = profile.filterType;
    filter.frequency.value = profile.frequency;
    filter.Q.value = profile.q;

    const gainNode = this.context.createGain();
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(profile.gain, now + 0.45);

    source.connect(filter).connect(gainNode).connect(this.master);
    source.start(now);

    let hum = null;
    let humGain = null;
    if (profile.humHz > 0 && profile.humGain > 0) {
      hum = this.context.createOscillator();
      hum.type = 'sine';
      hum.frequency.setValueAtTime(profile.humHz, now);
      humGain = this.context.createGain();
      humGain.gain.setValueAtTime(0.0001, now);
      humGain.gain.linearRampToValueAtTime(profile.humGain, now + 0.5);
      hum.connect(humGain).connect(this.master);
      hum.start(now);
    }

    this.ambienceNodes = { source, hum, filter, gainNode, humGain };
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
    if (last !== undefined && now - last < gap) return false;
    this.lastPlayed.set(kind, now);
    return true;
  }

  noise({ duration = 0.12, frequency = 900, gain = 0.35, type = 'bandpass', q = 0.9, delay = 0 } = {}) {
    if (!this.noiseBuffer) return;
    const now = this.context.currentTime + Math.max(0, delay);
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

  tone({ frequency = 440, duration = 0.1, gain = 0.18, type = 'sine', slideTo = null, delay = 0 } = {}) {
    const now = this.context.currentTime + Math.max(0, delay);
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(gain, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  playShotByWeapon(options = {}) {
    const weaponId = options.weaponId ?? null;
    if (options.weaponClass === 'melee' || weaponId === 'KNIFE' || weaponId === 'GOD_FIST') {
      const heavyFist = weaponId === 'GOD_FIST';
      this.noise({ duration: heavyFist ? 0.13 : 0.085, frequency: heavyFist ? 680 : 1450, gain: heavyFist ? 0.22 : 0.14, q: 0.8 });
      if (heavyFist) this.tone({ frequency: 130, slideTo: 48, duration: 0.11, gain: 0.16, type: 'triangle' });
      return true;
    }

    switch (weaponId) {
      case 'SMG':
        this.noise({ duration: 0.075, frequency: 1750, gain: 0.26, q: 0.85 });
        this.tone({ frequency: 175, slideTo: 78, duration: 0.075, gain: 0.14, type: 'triangle' });
        return true;
      case 'PISTOL':
        this.noise({ duration: 0.09, frequency: 1550, gain: 0.28, q: 0.9 });
        this.tone({ frequency: 220, slideTo: 92, duration: 0.09, gain: 0.15, type: 'triangle' });
        return true;
      case 'SHOTGUN':
        this.noise({ duration: 0.22, frequency: 620, gain: 0.44, q: 0.65 });
        this.tone({ frequency: 120, slideTo: 36, duration: 0.16, gain: 0.22, type: 'sawtooth' });
        this.noise({ duration: 0.055, frequency: 2400, gain: 0.10, type: 'highpass', delay: 0.14 });
        return true;
      case 'SNIPER':
        this.noise({ duration: 0.19, frequency: 1100, gain: 0.40, q: 0.75 });
        this.tone({ frequency: 185, slideTo: 42, duration: 0.17, gain: 0.20, type: 'sawtooth' });
        this.noise({ duration: 0.05, frequency: 3200, gain: 0.14, type: 'highpass' });
        return true;
      case 'RAILGUN':
        this.tone({ frequency: 980, slideTo: 180, duration: 0.18, gain: 0.20, type: 'sawtooth' });
        this.tone({ frequency: 145, slideTo: 38, duration: 0.16, gain: 0.18, type: 'sine' });
        this.noise({ duration: 0.12, frequency: 2400, gain: 0.22, type: 'bandpass', q: 1.5 });
        return true;
      case 'ROCKET':
        this.noise({ duration: 0.24, frequency: 440, gain: 0.40, q: 0.7 });
        this.tone({ frequency: 115, slideTo: 34, duration: 0.20, gain: 0.20, type: 'triangle' });
        return true;
      case 'LMG':
      case 'MINIGUN':
        this.noise({ duration: 0.12, frequency: 880, gain: 0.34, q: 0.8 });
        this.tone({ frequency: 135, slideTo: 56, duration: 0.10, gain: 0.17, type: 'square' });
        return true;
      case 'SMOKE_GRENADE':
        this.noise({ duration: 0.16, frequency: 980, gain: 0.22, type: 'bandpass', q: 1.1 });
        this.tone({ frequency: 260, slideTo: 130, duration: 0.08, gain: 0.10, type: 'sine' });
        return true;
      default: {
        const heavy = options.weaponClass === 'heavy';
        this.noise({ duration: heavy ? 0.2 : 0.1, frequency: heavy ? 520 : 1500, gain: heavy ? 0.42 : 0.3, q: 0.7 });
        this.tone({ frequency: heavy ? 90 : 150, slideTo: heavy ? 45 : 80, duration: 0.12, gain: 0.16, type: 'square' });
        return true;
      }
    }
  }

  /**
   * @param {string} kind shot | hit | kill | reload | switch | empty | spawn | ui | damage | step | jump | land | explosion | shield
   */
  play(kind, options = {}) {
    if (!this.canPlay(kind)) return false;
    switch (kind) {
      case 'shot':
        return this.playShotByWeapon(options);
      case 'hit':
        if (options.blocked) {
          this.tone({ frequency: 520, slideTo: 340, duration: 0.065, gain: 0.11, type: 'triangle' });
          return true;
        }
        if (options.headshot) {
          this.tone({ frequency: 1480, duration: 0.055, gain: 0.15, type: 'triangle' });
          this.tone({ frequency: 1960, duration: 0.075, gain: 0.12, type: 'sine', delay: 0.025 });
          return true;
        }
        this.tone({ frequency: 1180, duration: 0.055, gain: 0.12, type: 'triangle' });
        return true;
      case 'kill':
        this.tone({ frequency: 880, duration: 0.085, gain: 0.16, type: 'triangle' });
        this.tone({ frequency: 1320, duration: 0.14, gain: 0.13, type: 'sine', delay: 0.03 });
        return true;
      case 'reload':
        this.noise({ duration: 0.055, frequency: 2200, gain: 0.15, type: 'highpass', q: 0.6 });
        this.noise({ duration: 0.075, frequency: 720, gain: 0.14, type: 'bandpass', q: 1.4, delay: 0.07 });
        return true;
      case 'switch':
        this.noise({ duration: 0.04, frequency: 1900, gain: 0.09, type: 'bandpass', q: 1.2 });
        this.tone({ frequency: 520, slideTo: 690, duration: 0.04, gain: 0.05, type: 'triangle' });
        return true;
      case 'empty':
        this.noise({ duration: 0.04, frequency: 3400, gain: 0.12, type: 'highpass' });
        return true;
      case 'spawn':
        this.tone({ frequency: 260, slideTo: 520, duration: 0.28, gain: 0.1, type: 'sine' });
        return true;
      case 'damage':
        this.noise({ duration: 0.12, frequency: 320, gain: 0.26, type: 'lowpass', q: 0.8 });
        this.tone({ frequency: 120, slideTo: 48, duration: 0.10, gain: 0.12, type: 'triangle' });
        return true;
      case 'step':
        this.noise({ duration: 0.045, frequency: 360, gain: 0.055, type: 'lowpass', q: 0.7 });
        return true;
      case 'jump':
        this.noise({ duration: 0.065, frequency: 780, gain: 0.07, type: 'bandpass', q: 0.8 });
        this.tone({ frequency: 150, slideTo: 245, duration: 0.07, gain: 0.05, type: 'sine' });
        return true;
      case 'land': {
        const scale = Math.min(1.4, Math.max(0.5, Number(options.intensity) || 1));
        this.noise({ duration: 0.075, frequency: 290, gain: 0.09 * scale, type: 'lowpass', q: 0.7 });
        this.tone({ frequency: 110, slideTo: 44, duration: 0.07, gain: 0.065 * scale, type: 'triangle' });
        return true;
      }
      case 'explosion':
        this.noise({ duration: 0.30, frequency: 260, gain: 0.34, type: 'lowpass', q: 0.65 });
        this.tone({ frequency: 92, slideTo: 28, duration: 0.24, gain: 0.20, type: 'sawtooth' });
        return true;
      case 'shield':
        this.tone({ frequency: 420, slideTo: 280, duration: 0.06, gain: 0.08, type: 'triangle' });
        return true;
      case 'ui':
        this.tone({ frequency: 640, duration: 0.035, gain: 0.07, type: 'square' });
        return true;
      default:
        return false;
    }
  }

  dispose() {
    this.stopAmbienceNodes();
    this.desiredAmbience = null;
    this.context?.close?.().catch?.(() => {});
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.ambienceBuffer = null;
  }
}
