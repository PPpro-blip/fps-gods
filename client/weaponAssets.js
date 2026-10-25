// Vite turns each of these `?url` imports into a hashed asset URL in the
// production build and a served path in development. Kept in its own module so
// `weapons.js` can be imported by the Node test suite, which has no bundler.
import smgUrl from './assets/weapons/smg.glb?url';
import shotgunUrl from './assets/weapons/shotgun.glb?url';
import sniperUrl from './assets/weapons/sniper.glb?url';
import pistolUrl from './assets/weapons/pistol.glb?url';
import lmgUrl from './assets/weapons/lmg.glb?url';
import rocketUrl from './assets/weapons/rocket.glb?url';
import knifeUrl from './assets/weapons/knife.glb?url';

// Seven distinct GLBs back twelve weapons: `rifle.glb` is byte-identical to
// `smg.glb` and no bundle uses it, so it is intentionally not shipped twice.
export const MODEL_URLS = Object.freeze({
  'smg.glb': smgUrl,
  'shotgun.glb': shotgunUrl,
  'sniper.glb': sniperUrl,
  'pistol.glb': pistolUrl,
  'lmg.glb': lmgUrl,
  'rocket.glb': rocketUrl,
  'knife.glb': knifeUrl,
});
