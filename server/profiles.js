import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUNDLE_UNLOCK_KILLS } from '../shared/bundles.js';
import { GODS_TIER_BUNDLE_ID } from './weaponConfig.js';

const DEFAULT_PROFILE_PATH = process.env.FPS_GODS_PROFILE_PATH || join(process.cwd(), '.data', 'profiles.json');

function normalizeGuestProfileId(value) {
  // Reserved prefix `acct_` belongs exclusively to server-verified authenticated
  // accounts. Rejecting `acct_*` for unverified guests prevents any client from
  // reading, mutating, or impersonating a persistent account via Socket.IO.
  if (typeof value === 'string' && value.startsWith('acct_')) {
    return randomUUID();
  }
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
    ? value
    : randomUUID();
}

function cleanCallsign(value) {
  return [...String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 16).join('');
}

// Lifetime kills are trusted server data. Authenticated accounts persist in
// SQLite (`authService`); guests remain isolated in ephemeral/guest records.
export class PlayerProfileStore {
  constructor(filePath = DEFAULT_PROFILE_PATH, authService = null) {
    this.filePath = filePath;
    this.authService = authService;
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
        if (record.id.startsWith('acct_')) continue;
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

  accountSnapshot(account) {
    if (!account) return null;
    return Object.freeze({
      profileId: account.accountId,
      accountId: account.accountId,
      authenticated: true,
      emailMasked: account.emailMasked,
      callsign: account.callsign,
      selectedBundle: account.selectedBundle,
      lifetimeKills: account.lifetimeKills,
      godsTierUnlocked: Boolean(account.godsTierUnlocked),
      matchesPlayed: account.matchesPlayed ?? 0,
      matchesWon: account.matchesWon ?? 0,
    });
  }

  getOrCreate(profileId, callsign = '', verifiedAccountId = null) {
    if (verifiedAccountId && this.authService) {
      const account = this.authService.getAccountById(verifiedAccountId);
      if (account) {
        return this.accountSnapshot(account);
      }
    }

    const id = normalizeGuestProfileId(profileId);
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

  recordLifetimeKill(profileId, verifiedAccountId = null) {
    if (verifiedAccountId && this.authService) {
      const updated = this.authService.recordAccountKill(verifiedAccountId, 1);
      return this.accountSnapshot(updated);
    }
    const id = typeof profileId === 'string' && !profileId.startsWith('acct_') && this.profiles.has(profileId)
      ? profileId
      : null;
    if (!id) return null;
    const profile = this.profiles.get(id);
    profile.lifetimeKills += 1;
    profile.updatedAt = Date.now();
    this.save();
    return this.snapshot(profile);
  }

  isBundleUnlocked(profileId, bundleId, verifiedAccountId = null) {
    if (bundleId !== GODS_TIER_BUNDLE_ID) return true;
    if (verifiedAccountId && this.authService) {
      const account = this.authService.getAccountById(verifiedAccountId);
      return Boolean(account && account.godsTierUnlocked);
    }
    const profile = typeof profileId === 'string' && !profileId.startsWith('acct_')
      ? this.profiles.get(profileId)
      : null;
    return Boolean(profile && profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS);
  }

  snapshot(profileOrId) {
    const profile = typeof profileOrId === 'string'
      ? this.profiles.get(profileOrId)
      : profileOrId;
    if (!profile) return null;
    return Object.freeze({
      profileId: profile.id,
      accountId: null,
      authenticated: false,
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
