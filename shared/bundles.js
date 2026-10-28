// Client-safe bundle presentation data. Combat numbers and weapon behavior are
// intentionally kept in server/weaponConfig.js and never trusted from a client.
export const BUNDLE_UNLOCK_KILLS = 30;
export const DEFAULT_BUNDLE_ID = 'RUSHER';

export const BUNDLE_INFO = Object.freeze([
  Object.freeze({
    id: 'RUSHER',
    name: 'RUSHER',
    title: 'Close fast. Finish faster.',
    description: 'Aggressive close-quarters pressure with a fast primary and instant melee finish.',
    accent: '#ff9858',
    weapons: Object.freeze([
      Object.freeze({ id: 'SMG', name: 'SMG', icon: '↯', role: 'FAST FIRE · 30 ROUNDS' }),
      Object.freeze({ id: 'SHOTGUN', name: 'SHOTGUN', icon: '▤', role: 'CLOSE-RANGE BURST' }),
      Object.freeze({ id: 'KNIFE', name: 'KNIFE', icon: '†', role: 'INSTANT-KILL MELEE' }),
    ]),
  }),
  Object.freeze({
    id: 'GHOST',
    name: 'GHOST',
    title: 'Quiet shots. Clean picks.',
    description: 'A precise pistol, a one-shot headshot bolt action, and cover for a clean escape.',
    accent: '#80aaff',
    weapons: Object.freeze([
      Object.freeze({ id: 'PISTOL', name: 'PISTOL', icon: '⊙', role: 'NO BULLET TRACER' }),
      Object.freeze({ id: 'SNIPER', name: 'SNIPER', icon: '⌖', role: 'ONE-SHOT HEADSHOT' }),
      Object.freeze({ id: 'SMOKE_GRENADE', name: 'SMOKE GRENADE', icon: '◌', role: 'VISION-BLOCKING CLOUD' }),
    ]),
  }),
  Object.freeze({
    id: 'HEAVY',
    name: 'HEAVY',
    title: 'Hold ground. Break cover.',
    description: 'Sustained machine-gun fire, a cover-breaking rocket, and a frontal combat shield.',
    accent: '#ffc857',
    weapons: Object.freeze([
      Object.freeze({ id: 'LMG', name: 'LMG', icon: '≋', role: 'HIGH FIRE RATE · 60 ROUNDS' }),
      Object.freeze({ id: 'ROCKET', name: 'ROCKET', icon: '➤', role: 'SPLASH DAMAGE · DESTROYS COVER' }),
      Object.freeze({ id: 'COMBAT_SHIELD', name: 'COMBAT SHIELD', icon: '⬡', role: 'HOLD RMB · FRONT GUARD' }),
    ]),
  }),
  Object.freeze({
    id: 'GODS_TIER',
    name: 'GODS TIER',
    title: 'Earned, never given.',
    description: 'A wall-piercing railgun, a five-second minigun burst, and a knockback god fist.',
    accent: '#59d8ff',
    unlockKills: BUNDLE_UNLOCK_KILLS,
    weapons: Object.freeze([
      Object.freeze({ id: 'RAILGUN', name: 'RAILGUN', icon: '╱', role: 'INSTANT HITSCAN · PIERCES WALLS' }),
      Object.freeze({ id: 'MINIGUN', name: 'MINIGUN', icon: '✺', role: 'UNLIMITED AMMO · 5 SECOND BURST' }),
      Object.freeze({ id: 'GOD_FIST', name: 'GOD FIST', icon: '✊', role: 'ONE-PUNCH KILL · HUGE KNOCKBACK' }),
    ]),
  }),
]);

export const BUNDLE_BY_ID = Object.freeze(Object.fromEntries(BUNDLE_INFO.map((bundle) => [bundle.id, bundle])));
export const WEAPON_PRESENTATION = Object.freeze(Object.fromEntries(
  BUNDLE_INFO.flatMap((bundle) => bundle.weapons.map((weapon) => [weapon.id, weapon])),
));
