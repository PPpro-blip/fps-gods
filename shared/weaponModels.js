// Weapon id -> shipped GLB, plus the real-world length of each model.
//
// Shared so the client renderer, the menu stands and the UI (which lists the
// actual asset next to each weapon) can never disagree about which file backs a
// weapon. There are seven distinct GLBs behind twelve weapons: `rifle.glb` is a
// byte-identical duplicate of `smg.glb` and is not used.
//
// Lengths are measured in metres from each file's bounding box; the models are
// authored at wildly different scales, so they must be normalised to these.

export const WEAPON_MODEL_FILE = Object.freeze({
  SMG: 'smg.glb',
  SHOTGUN: 'shotgun.glb',
  KNIFE: 'knife.glb',
  PISTOL: 'pistol.glb',
  SMOKE_GRENADE: 'pistol.glb',
  SNIPER: 'sniper.glb',
  LMG: 'lmg.glb',
  RAILGUN: 'lmg.glb',
  MINIGUN: 'lmg.glb',
  ROCKET: 'rocket.glb',
  COMBAT_SHIELD: 'shotgun.glb',
  GOD_FIST: 'knife.glb',
});

export const WEAPON_MODEL_LENGTH = Object.freeze({
  'smg.glb': 0.73,
  'shotgun.glb': 0.84,
  'sniper.glb': 1.02,
  'pistol.glb': 0.58,
  'lmg.glb': 0.86,
  'rocket.glb': 0.66,
  'knife.glb': 0.52,
});

export const WEAPON_MODEL_FILES = Object.freeze([...new Set(Object.values(WEAPON_MODEL_FILE))]);

export const WEAPON_MODEL_DIRECTORY = '/assets/weapons/';
