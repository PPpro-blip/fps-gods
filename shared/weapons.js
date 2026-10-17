// Shared weapon and bundle catalog. The Node server applies every stat here
// when it resolves damage, fire cadence, magazines and reloads; the browser
// only reads the same numbers for HUD labels, the weapon wheel and viewmodels.
// Changing a value here changes gameplay for everyone, server-side.

/** How many lifetime eliminations unlock the GODS TIER bundle. */
export const GODS_TIER_UNLOCK_KILLS = 30;

const freezeWeapon = (definition) => Object.freeze({ ...definition });

/**
 * Every equippable item. `type` selects the server code path:
 *  - hitscan   instant ray, optional wall/player piercing
 *  - melee     short range cone, instant kill weapons
 *  - projectile simulated rocket with splash damage
 *  - grenade   thrown smoke canister that blocks vision on landing
 *  - shield    held item that blocks frontal damage
 */
export const WEAPONS = Object.freeze({
  // ── BUNDLE 1 · RUSHER ────────────────────────────────────────────────
  smg: freezeWeapon({
    id: 'smg',
    name: 'VORTEX SMG',
    model: 'smg.glb',
    type: 'hitscan',
    auto: true,
    damage: 11,
    headshotMultiplier: 1.9,
    fireRateMs: 85,
    magSize: 30,
    reloadMs: 1_550,
    range: 68,
    spread: 0.03,
    tracer: true,
    icon: 'SMG',
    blurb: 'Fast fire, low damage, 30 round magazine.',
  }),
  shotgun: freezeWeapon({
    id: 'shotgun',
    name: 'HARROW SHOTGUN',
    model: 'shotgun.glb',
    type: 'hitscan',
    auto: false,
    pellets: 8,
    damage: 11,
    headshotMultiplier: 1.4,
    fireRateMs: 750,
    magSize: 6,
    reloadMs: 2_200,
    range: 32,
    spread: 0.085,
    falloffStart: 14,
    falloffEnd: 30,
    falloffFloor: 0.45,
    tracer: true,
    icon: 'SG',
    blurb: 'Close range, high damage spread.',
  }),
  knife: freezeWeapon({
    id: 'knife',
    name: 'TAC KNIFE',
    model: 'knife.glb',
    type: 'melee',
    auto: false,
    damage: 999,
    headshotMultiplier: 1,
    fireRateMs: 470,
    magSize: 0,
    reloadMs: 0,
    range: 2.5,
    spread: 0,
    tracer: false,
    icon: 'KNF',
    blurb: 'Instant kill melee.',
  }),

  // ── BUNDLE 2 · GHOST ─────────────────────────────────────────────────
  pistol: freezeWeapon({
    id: 'pistol',
    name: 'WRAITH PISTOL',
    model: 'pistol.glb',
    type: 'hitscan',
    auto: false,
    damage: 25,
    headshotMultiplier: 2,
    fireRateMs: 150,
    magSize: 12,
    reloadMs: 1_150,
    range: 85,
    spread: 0.01,
    tracer: false,
    icon: 'PST',
    blurb: 'Medium damage, no tracer.',
  }),
  sniper: freezeWeapon({
    id: 'sniper',
    name: 'PHANTOM SNIPER',
    model: 'sniper.glb',
    type: 'hitscan',
    auto: false,
    damage: 60,
    headshotMultiplier: 2.5,
    fireRateMs: 1_250,
    magSize: 5,
    reloadMs: 2_400,
    range: 140,
    spread: 0.0012,
    tracer: true,
    icon: 'SNP',
    blurb: 'One shot headshot.',
  }),
  smoke: freezeWeapon({
    id: 'smoke',
    name: 'SMOKE GRENADE',
    model: null,
    type: 'grenade',
    auto: false,
    damage: 0,
    headshotMultiplier: 1,
    fireRateMs: 900,
    magSize: 2,
    reloadMs: 2_300,
    range: 24,
    spread: 0,
    tracer: false,
    smokeRadius: 5.4,
    smokeDurationMs: 9_000,
    projectileSpeed: 17,
    icon: 'SMK',
    blurb: 'Blocks vision in a radius.',
  }),

  // ── BUNDLE 3 · HEAVY ─────────────────────────────────────────────────
  lmg: freezeWeapon({
    id: 'lmg',
    name: 'TITAN LMG',
    model: 'lmg.glb',
    type: 'hitscan',
    auto: true,
    damage: 15,
    headshotMultiplier: 1.9,
    fireRateMs: 80,
    magSize: 60,
    reloadMs: 3_300,
    range: 92,
    spread: 0.032,
    tracer: true,
    icon: 'LMG',
    blurb: 'High fire rate, 60 round magazine.',
  }),
  rocket: freezeWeapon({
    id: 'rocket',
    name: 'RAVAGER ROCKET',
    model: 'rocket.glb',
    type: 'projectile',
    auto: false,
    damage: 85,
    headshotMultiplier: 1,
    fireRateMs: 1_350,
    magSize: 2,
    reloadMs: 2_800,
    range: 80,
    spread: 0,
    tracer: false,
    splashDamage: 78,
    splashRadius: 4.8,
    projectileSpeed: 34,
    icon: 'RKT',
    blurb: 'Rocket with splash damage.',
  }),
  shield: freezeWeapon({
    id: 'shield',
    name: 'COMBAT SHIELD',
    model: null,
    type: 'shield',
    auto: false,
    damage: 0,
    headshotMultiplier: 1,
    fireRateMs: 0,
    magSize: 0,
    reloadMs: 0,
    range: 0,
    spread: 0,
    tracer: false,
    // A hit is frontal when dot(victimFacing, directionToAttacker) exceeds this.
    blockArc: 0.45,
    icon: 'SHD',
    blurb: 'Blocks frontal damage.',
  }),

  // ── BUNDLE 4 · GODS TIER ─────────────────────────────────────────────
  railgun: freezeWeapon({
    id: 'railgun',
    name: 'GOD RAILGUN',
    model: null,
    type: 'hitscan',
    auto: false,
    damage: 85,
    headshotMultiplier: 1.5,
    fireRateMs: 1_100,
    magSize: 4,
    reloadMs: 2_400,
    range: 170,
    spread: 0,
    tracer: true,
    piercesWalls: true,
    piercesPlayers: true,
    icon: 'RAIL',
    blurb: 'Instant hitscan, pierces walls.',
  }),
  minigun: freezeWeapon({
    id: 'minigun',
    name: 'GOD MINIGUN',
    model: null,
    type: 'hitscan',
    auto: true,
    damage: 10,
    headshotMultiplier: 1.8,
    fireRateMs: 55,
    magSize: 0, // no magazine at all…
    unlimited: true, // …ammo never runs dry
    reloadMs: 0,
    range: 85,
    spread: 0.035,
    tracer: true,
    overheatAfterMs: 5_000,
    cooldownMs: 5_500,
    icon: 'MINI',
    blurb: 'Unlimited ammo, 5 sec then overheats.',
  }),
  fist: freezeWeapon({
    id: 'fist',
    name: 'GOD FIST',
    model: null,
    type: 'melee',
    auto: true,
    damage: 999,
    headshotMultiplier: 1,
    fireRateMs: 430,
    magSize: 0,
    reloadMs: 0,
    range: 3,
    spread: 0,
    tracer: false,
    knockback: 17,
    icon: 'FIST',
    blurb: 'One punch kill, huge knockback.',
  }),
});

/** Ordered loadouts. Every player and bot carries exactly these three slots. */
export const BUNDLES = Object.freeze({
  rusher: freezeWeapon({
    id: 'rusher',
    name: 'RUSHER',
    tagline: 'Get in. Stay moving.',
    slots: Object.freeze(['smg', 'shotgun', 'knife']),
    unlockKills: 0,
    accent: '#59d8ff',
  }),
  ghost: freezeWeapon({
    id: 'ghost',
    name: 'GHOST',
    tagline: 'Unseen. Unheard. Unmatched.',
    slots: Object.freeze(['pistol', 'sniper', 'smoke']),
    unlockKills: 0,
    accent: '#b18cff',
  }),
  heavy: freezeWeapon({
    id: 'heavy',
    name: 'HEAVY',
    tagline: 'Bring the whole arsenal.',
    slots: Object.freeze(['lmg', 'rocket', 'shield']),
    unlockKills: 0,
    accent: '#ff9858',
  }),
  gods: freezeWeapon({
    id: 'gods',
    name: 'GODS TIER',
    tagline: 'Thirty kills. Zero mercy.',
    slots: Object.freeze(['railgun', 'minigun', 'fist']),
    unlockKills: GODS_TIER_UNLOCK_KILLS,
    accent: '#ffd66e',
  }),
});

export const BUNDLE_IDS = Object.freeze(Object.keys(BUNDLES));

/** Bundles bots draw from when a solo match is created. */
export const BOT_BUNDLE_IDS = Object.freeze(['rusher', 'ghost', 'heavy']);

/** Look up a weapon definition by id. Throws on unknown ids so bugs surface fast. */
export function getWeapon(weaponId) {
  const weapon = WEAPONS[weaponId];
  if (!weapon) throw new Error(`Unknown weapon id: ${weaponId}`);
  return weapon;
}

/** Look up a bundle definition by id. Throws on unknown ids. */
export function getBundle(bundleId) {
  const bundle = BUNDLES[bundleId];
  if (!bundle) throw new Error(`Unknown bundle id: ${bundleId}`);
  return bundle;
}

/** True when a player with this many lifetime kills may equip the bundle. */
export function isBundleUnlocked(bundleId, lifetimeKills = 0) {
  return lifetimeKills >= getBundle(bundleId).unlockKills;
}

/** Default slot index equipped on spawn: the bundle's primary weapon. */
export const PRIMARY_SLOT = 0;
