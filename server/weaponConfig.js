import { BUNDLE_INFO, DEFAULT_BUNDLE_ID } from '../shared/bundles.js';

// Authoritative weapon numbers and effects. Clients receive only the current
// weapon's display metadata; the server derives every shot from these records.
const weaponRecords = [
  {
    id: 'SMG', bundleId: 'RUSHER', name: 'SMG', icon: '↯', behavior: 'hitscan',
    auto: true,
    damage: 13, fireRate: 90, magSize: 30, reserveAmmo: 90, reloadTime: 1_250,
    range: 58, spread: 0.055, headshotMultiplier: 1.5,
  },
  {
    id: 'SHOTGUN', bundleId: 'RUSHER', name: 'SHOTGUN', icon: '▤', behavior: 'hitscan',
    auto: false,
    damage: 17, fireRate: 850, magSize: 6, reserveAmmo: 24, reloadTime: 1_450,
    range: 18, spread: 0.17, pellets: 8, headshotMultiplier: 1.15,
  },
  {
    id: 'KNIFE', bundleId: 'RUSHER', name: 'KNIFE', icon: '†', behavior: 'melee',
    auto: false,
    damage: 100, fireRate: 560, magSize: 0, reserveAmmo: 0, reloadTime: 0,
    range: 2.3, spread: 0.035, headshotMultiplier: 1,
  },
  {
    id: 'PISTOL', bundleId: 'GHOST', name: 'PISTOL', icon: '⊙', behavior: 'hitscan',
    auto: false,
    damage: 25, fireRate: 150, magSize: 12, reserveAmmo: 60, reloadTime: 1_150,
    range: 68, spread: 0.008, headshotMultiplier: 2, tracer: false,
  },
  {
    id: 'SNIPER', bundleId: 'GHOST', name: 'SNIPER', icon: '⌖', behavior: 'hitscan',
    auto: false,
    damage: 72, headshotDamage: 100, fireRate: 1_350, magSize: 5, reserveAmmo: 20,
    reloadTime: 2_100, range: 125, spread: 0.002, headshotMultiplier: 1,
  },
  {
    id: 'SMOKE_GRENADE', bundleId: 'GHOST', name: 'SMOKE GRENADE', icon: '◌', behavior: 'smoke',
    auto: false,
    damage: 0, fireRate: 1_300, magSize: 1, reserveAmmo: 2, reloadTime: 1_600,
    range: 26, spread: 0.025, smokeRadius: 4.8, smokeDuration: 9_000,
  },
  {
    id: 'LMG', bundleId: 'HEAVY', name: 'LMG', icon: '≋', behavior: 'hitscan',
    auto: true,
    damage: 16, fireRate: 95, magSize: 60, reserveAmmo: 180, reloadTime: 2_600,
    range: 74, spread: 0.064, headshotMultiplier: 1.45,
  },
  {
    id: 'ROCKET', bundleId: 'HEAVY', name: 'ROCKET', icon: '➤', behavior: 'rocket',
    auto: false,
    damage: 90, fireRate: 1_250, magSize: 1, reserveAmmo: 5, reloadTime: 2_300,
    range: 78, spread: 0.018, splashDamage: 88, splashRadius: 5.2, destroysCover: true,
  },
  {
    id: 'COMBAT_SHIELD', bundleId: 'HEAVY', name: 'COMBAT SHIELD', icon: '⬡', behavior: 'shield',
    auto: false,
    damage: 0, fireRate: 0, magSize: 0, reserveAmmo: 0, reloadTime: 0,
    range: 0, spread: 0, frontalArcDegrees: 112,
  },
  {
    id: 'RAILGUN', bundleId: 'GODS_TIER', name: 'RAILGUN', icon: '╱', behavior: 'hitscan',
    auto: false,
    damage: 90, fireRate: 950, magSize: 4, reserveAmmo: 16, reloadTime: 2_250,
    range: 135, spread: 0, headshotMultiplier: 2, piercesCover: true,
  },
  {
    id: 'MINIGUN', bundleId: 'GODS_TIER', name: 'MINIGUN', icon: '✺', behavior: 'hitscan',
    auto: true,
    damage: 8, fireRate: 65, magSize: 0, reserveAmmo: 0, reloadTime: 0,
    range: 68, spread: 0.09, unlimitedAmmo: true, overheatsAfterMs: 5_000,
    overheatCooldownMs: 2_000,
  },
  {
    id: 'GOD_FIST', bundleId: 'GODS_TIER', name: 'GOD FIST', icon: '✊', behavior: 'melee',
    auto: true,
    damage: 100, fireRate: 850, magSize: 0, reserveAmmo: 0, reloadTime: 0,
    range: 2.8, spread: 0.02, knockback: 25, knockbackLift: 3.8,
  },
];

export const WEAPONS = Object.freeze(Object.fromEntries(
  weaponRecords.map((weapon) => [weapon.id, Object.freeze(weapon)]),
));

export const BUNDLE_LOADOUTS = Object.freeze(Object.fromEntries(
  BUNDLE_INFO.map((bundle) => [
    bundle.id,
    Object.freeze(bundle.weapons.map(({ id }) => WEAPONS[id])),
  ]),
));

export const WEAPON_IDS = Object.freeze(Object.keys(WEAPONS));
export const BUNDLE_IDS = Object.freeze(BUNDLE_INFO.map((bundle) => bundle.id));
export const GODS_TIER_BUNDLE_ID = 'GODS_TIER';
export const DEFAULT_LOADOUT_BUNDLE_ID = DEFAULT_BUNDLE_ID;

export function isBundleId(bundleId) {
  return Object.hasOwn(BUNDLE_LOADOUTS, bundleId);
}

export function getBundleLoadout(bundleId) {
  return BUNDLE_LOADOUTS[bundleId] ?? BUNDLE_LOADOUTS[DEFAULT_LOADOUT_BUNDLE_ID];
}

export function getWeapon(weaponId) {
  return WEAPONS[weaponId] ?? null;
}
