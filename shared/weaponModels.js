// Weapon id -> shipped GLB, plus the real-world length of each model.
//
// Shared so the client renderer, the menu stands and the UI (which lists the
// actual asset next to each weapon) can never disagree about which file backs a
// weapon. The shield, knife and launcher are the user-supplied public assets;
// existing shared firearms remain in client/assets. `rifle.glb` duplicates smg.
//
// Lengths are tuned in metres so each model's height-to-length aspect ratio
// produces compact, readable Krunker-inspired first-person and third-person
// proportions without oversized silhouettes blocking the center view.

export const WEAPON_MODEL_FILE = Object.freeze({
  SMG: 'smg.glb',
  SHOTGUN: 'shotgun.glb',
  KNIFE: 'Military knife.glb',
  PISTOL: 'pistol.glb',
  SMOKE_GRENADE: 'pistol.glb',
  SNIPER: 'sniper.glb',
  LMG: 'lmg.glb',
  RAILGUN: 'lmg.glb',
  MINIGUN: 'lmg.glb',
  ROCKET: 'rocket_launcher_low.gltf',
  COMBAT_SHIELD: 'LowPolyShieldPack.glb',
  GOD_FIST: 'knife.glb',
});

export const WEAPON_MODEL_LENGTH = Object.freeze({
  'smg.glb': 0.50,
  'shotgun.glb': 0.72,
  'sniper.glb': 0.94,
  'pistol.glb': 0.38,
  'lmg.glb': 0.78,
  'rocket.glb': 0.66,
  'knife.glb': 0.46,
  'Military knife.glb': 0.34,
  'rocket_launcher_low.gltf': 0.72,
  'LowPolyShieldPack.glb': 0.58,
});

export const WEAPON_MODEL_FILES = Object.freeze([...new Set(Object.values(WEAPON_MODEL_FILE))]);

export const WEAPON_MODEL_DIRECTORY = '/assets/weapons/';
