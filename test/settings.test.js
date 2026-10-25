import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CROSSHAIR_STYLES,
  DEFAULT_SETTINGS,
  QUALITY_PRESETS,
  SETTINGS_LIMITS,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  sanitizeSettings,
  sensitivityToRadiansPerPixel,
} from '../client/settings.js';

function createStorage(initial = null) {
  const map = new Map();
  if (initial !== null) map.set(SETTINGS_STORAGE_KEY, initial);
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

test('settings default to the documented values and never hold unknown keys', () => {
  const settings = sanitizeSettings(undefined);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(sanitizeSettings({ aimbot: true, sensitivity: 2 })).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.equal(sanitizeSettings({ aimbot: true }).sensitivity, DEFAULT_SETTINGS.sensitivity);
});

test('out-of-range and malformed values are clamped, not trusted', () => {
  const wild = sanitizeSettings({
    sensitivity: 99,
    fov: -400,
    volume: 'loud',
    quality: 'ultra',
    crosshair: 'nonsense',
    invertY: 'yes',
    showFps: 1,
  });
  assert.equal(wild.sensitivity, SETTINGS_LIMITS.sensitivity.max);
  assert.equal(wild.fov, SETTINGS_LIMITS.fov.min);
  assert.equal(wild.volume, DEFAULT_SETTINGS.volume, 'non-numeric volume falls back');
  assert.equal(wild.quality, DEFAULT_SETTINGS.quality);
  assert.equal(wild.crosshair, DEFAULT_SETTINGS.crosshair);
  assert.equal(wild.invertY, false, 'only a real boolean enables inverting');
  assert.equal(wild.showFps, false, 'a truthy non-boolean must not enable the counter');

  assert.equal(sanitizeSettings({ sensitivity: -5 }).sensitivity, SETTINGS_LIMITS.sensitivity.min);
  assert.equal(sanitizeSettings({ fov: 1000 }).fov, SETTINGS_LIMITS.fov.max);
  assert.equal(sanitizeSettings({ volume: 4 }).volume, 1);
  assert.equal(sanitizeSettings({ volume: 0 }).volume, 0);
  for (const style of CROSSHAIR_STYLES) assert.equal(sanitizeSettings({ crosshair: style }).crosshair, style);
});

test('the store persists, reloads, and notifies with sanitized values', () => {
  const storage = createStorage();
  const seen = [];
  const store = new SettingsStore({ storage, onChange: (next) => seen.push(next) });

  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null, 'nothing is written until the player changes something');

  const next = store.update({ sensitivity: 1.5, quality: 'low' });
  assert.equal(next.sensitivity, 1.5);
  assert.equal(seen.length, 1, 'the engine is told about the change');
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).quality, 'low');

  const subscribed = [];
  const unsubscribe = store.subscribe((value) => subscribed.push(value));
  store.update({ fov: 90 });
  assert.equal(subscribed.length, 1);
  unsubscribe();
  store.update({ fov: 91 });
  assert.equal(subscribed.length, 1, 'unsubscribing stops notifications');

  // A fresh store (page reload) reads the stored values back.
  const reloaded = new SettingsStore({ storage });
  assert.equal(reloaded.get('sensitivity'), 1.5);
  assert.equal(reloaded.get('fov'), 91);
  assert.equal(reloaded.get('quality'), 'low');

  // Corrupt storage must not throw or poison the session.
  const broken = new SettingsStore({ storage: createStorage('{not json') });
  assert.deepEqual(broken.snapshot, DEFAULT_SETTINGS);
});

test('a storage that throws on write keeps the in-memory value', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  const store = new SettingsStore({ storage });
  const next = store.update({ volume: 0.2 });
  assert.equal(next.volume, 0.2);
  assert.equal(store.get('volume'), 0.2);
});

test('reset restores defaults and every quality preset is usable', () => {
  const storage = createStorage();
  const store = new SettingsStore({ storage });
  store.update({ sensitivity: 2.4, fov: 104 });
  const reset = store.reset();
  assert.deepEqual(reset, DEFAULT_SETTINGS);

  for (const [key, preset] of Object.entries(QUALITY_PRESETS)) {
    assert.ok(preset.label, `${key} needs a label for the settings screen`);
    assert.ok(preset.pixelRatio >= 1 && preset.pixelRatio <= 2, `${key} pixel ratio out of range`);
    assert.ok(preset.fog > 0 && preset.fog < 0.05, `${key} fog density out of range`);
  }
  assert.equal(new Set(Object.values(QUALITY_PRESETS).map((preset) => preset.fog)).size, 3, 'presets must differ');
});

test('sensitivity multiplier maps to a sane radians-per-pixel range', () => {
  const low = sensitivityToRadiansPerPixel(SETTINGS_LIMITS.sensitivity.min);
  const normal = sensitivityToRadiansPerPixel(1);
  const high = sensitivityToRadiansPerPixel(SETTINGS_LIMITS.sensitivity.max);
  assert.ok(low < normal && normal < high, 'the multiplier is monotonic');
  assert.ok(normal > 0.001 && normal < 0.01, `default sensitivity looks wrong: ${normal}`);
  assert.equal(sensitivityToRadiansPerPixel(1000), sensitivityToRadiansPerPixel(SETTINGS_LIMITS.sensitivity.max));
  assert.equal(sensitivityToRadiansPerPixel('abc'), sensitivityToRadiansPerPixel(1));
});
