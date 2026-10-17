import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUNDLE_UNLOCK_KILLS } from '../shared/bundles.js';
import { GODS_TIER_BUNDLE_ID } from './weaponConfig.js';

const DEFAULT_PROFILE_PATH = process.env.FPS_GODS_PROFILE_PATH || join(process.cwd(), '.data', 'profiles.json');

function normalizeProfileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
    ? value
    : randomUUID();
}

function cleanCallsign(value) {
  return [...String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 16).join('');
}

// Lifetime kills are trusted server data. The client only owns an opaque local
// profile key and never supplies a kill count or unlock flag.
export class PlayerProfileStore {
  constructor(filePath = DEFAULT_PROFILE_PATH) {
    this.filePath = filePath;
    this.profiles = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : Object.values(parsed?.profiles ?? {});
      for (const record of records) {
        if (typeof record?.id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(record.id)) continue;
        this.profiles.set(record.id, {
          id: record.id,
          callsign: cleanCallsign(record.callsign),
          lifetimeKills: Math.max(0, Math.floor(Number(record.lifetimeKills) || 0)),
          createdAt: Number(record.createdAt) || Date.now(),
          updatedAt: Number(record.updatedAt) || Date.now(),
        });
      }
    } catch (error) {
      console.error('[FPS GODS] Could not load player profiles:', error.message);
      this.profiles.clear();
    }
  }

  getOrCreate(profileId, callsign = '') {
    const id = normalizeProfileId(profileId);
    let profile = this.profiles.get(id);
    if (!profile) {
      const now = Date.now();
      profile = { id, callsign: cleanCallsign(callsign), lifetimeKills: 0, createdAt: now, updatedAt: now };
      this.profiles.set(id, profile);
      this.save();
    } else if (callsign && cleanCallsign(callsign) !== profile.callsign) {
      profile.callsign = cleanCallsign(callsign);
      profile.updatedAt = Date.now();
      this.save();
    }
    return this.snapshot(profile);
  }

  recordLifetimeKill(profileId) {
    const id = typeof profileId === 'string' && this.profiles.has(profileId) ? profileId : null;
    if (!id) return null;
    const profile = this.profiles.get(id);
    profile.lifetimeKills += 1;
    profile.updatedAt = Date.now();
    this.save();
    return this.snapshot(profile);
  }

  isBundleUnlocked(profileId, bundleId) {
    if (bundleId !== GODS_TIER_BUNDLE_ID) return true;
    const profile = this.profiles.get(profileId);
    return Boolean(profile && profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS);
  }

  snapshot(profileOrId) {
    const profile = typeof profileOrId === 'string'
      ? this.profiles.get(profileOrId)
      : profileOrId;
    if (!profile) return null;
    return Object.freeze({
      profileId: profile.id,
      callsign: profile.callsign,
      lifetimeKills: profile.lifetimeKills,
      godsTierUnlocked: profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS,
    });
  }

  save() {
    if (!this.filePath) return;
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const records = [...this.profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
    writeFileSync(temporaryPath, `${JSON.stringify({ profiles: records }, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}

export function createMemoryProfileStore() {
  return new PlayerProfileStore(null);
}
