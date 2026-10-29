// Player-facing client preferences.
//
// These are local-only: they are never sent to the server, never unlock
// anything, and never change authoritative combat values. They live in
// localStorage because the game has no account-synced settings store yet, and
// the settings screen says so explicitly.

import { DEFAULT_BOT_DIFFICULTY, resolveBotDifficulty } from '../shared/gameConfig.js';

export const SETTINGS_STORAGE_KEY = 'fps-gods-settings';

// Quality only controls things the renderer can actually change at runtime:
// the device-pixel-ratio cap (fill rate) and arena fog density (overdraw).
export const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({ label: 'LOW', pixelRatio: 1, fog: 0.014 }),
  medium: Object.freeze({ label: 'MEDIUM', pixelRatio: 1.35, fog: 0.011 }),
  high: Object.freeze({ label: 'HIGH', pixelRatio: 2, fog: 0.0092 }),
});

export const CROSSHAIR_STYLES = Object.freeze(['standard', 'dot', 'cross', 'minimal']);

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1,
  fov: 77,
  volume: 0.65,
  quality: 'high',
  invertY: false,
  crosshair: 'standard',
  showFps: false,
  botDifficulty: DEFAULT_BOT_DIFFICULTY,
});

export const SETTINGS_LIMITS = Object.freeze({
  sensitivity: Object.freeze({ min: 0.15, max: 3, step: 0.05 }),
  fov: Object.freeze({ min: 65, max: 110, step: 1 }),
  volume: Object.freeze({ min: 0, max: 1, step: 0.05 }),
});

function clampNumber(value, { min, max }, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Coerce any stored/user value into a valid settings object.
 * Unknown keys are dropped so a stale localStorage entry cannot smuggle in new
 * behaviour, and every numeric field is clamped to its supported range.
 */
export function sanitizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    sensitivity: clampNumber(source.sensitivity, SETTINGS_LIMITS.sensitivity, DEFAULT_SETTINGS.sensitivity),
    fov: Math.round(clampNumber(source.fov, SETTINGS_LIMITS.fov, DEFAULT_SETTINGS.fov)),
    volume: clampNumber(source.volume, SETTINGS_LIMITS.volume, DEFAULT_SETTINGS.volume),
    quality: Object.hasOwn(QUALITY_PRESETS, source.quality) ? source.quality : DEFAULT_SETTINGS.quality,
    invertY: source.invertY === true,
    crosshair: CROSSHAIR_STYLES.includes(source.crosshair) ? source.crosshair : DEFAULT_SETTINGS.crosshair,
    showFps: source.showFps === true,
    botDifficulty: resolveBotDifficulty(source.botDifficulty),
  });
}

/** Map the user's sensitivity multiplier onto the controller's radians/pixel. */
export function sensitivityToRadiansPerPixel(multiplier) {
  const safe = clampNumber(multiplier, SETTINGS_LIMITS.sensitivity, DEFAULT_SETTINGS.sensitivity);
  return 0.0022 * safe;
}

export class SettingsStore {
  constructor({ storage = resolveStorage(), onChange = null } = {}) {
    this.storage = storage;
    this.onChange = onChange;
    this.listeners = new Set();
    this.value = sanitizeSettings(this.read());
  }

  read() {
    try {
      const raw = this.storage?.getItem(SETTINGS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  get snapshot() {
    return this.value;
  }

  get(key) {
    return this.value[key];
  }

  /** Apply a partial update, sanitize it, persist it, and notify subscribers. */
  update(patch = {}) {
    const next = sanitizeSettings({ ...this.value, ...patch });
    this.value = next;
    try {
      this.storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A blocked storage write must never break gameplay; the in-memory value
      // still applies for this session.
    }
    this.onChange?.(next);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  reset() {
    return this.update({ ...DEFAULT_SETTINGS });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function resolveStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // Private-mode browsers can throw on access rather than return null.
  }
  return null;
}
