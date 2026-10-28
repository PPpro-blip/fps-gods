// Vite turns each of these `?url` imports into a hashed asset URL in the
// production build and a served path in development. Kept in its own module so
// `weapons.js` can be imported by the Node test suite, which has no bundler.
import smgUrl from './assets/weapons/smg.glb?url';
import shotgunUrl from './assets/weapons/shotgun.glb?url';
import sniperUrl from './assets/weapons/sniper.glb?url';
import pistolUrl from './assets/weapons/pistol.glb?url';
import lmgUrl from './assets/weapons/lmg.glb?url';
import rocketUrl from '../public/assets/weapons/rocket_launcher_low.gltf?url';
import knifeUrl from '../public/assets/weapons/Military knife.glb?url';
import shieldUrl from '../public/assets/weapons/LowPolyShieldPack.glb?url';
import fistUrl from './assets/weapons/knife.glb?url';

// The three new assets stay in public/ and are imported by URL directly, so
// Vite emits hashed URLs without introducing another source copy. The GLTF is
// self-contained; its buffers and images are data URIs.
export const MODEL_URLS = Object.freeze({
  'smg.glb': smgUrl,
  'shotgun.glb': shotgunUrl,
  'sniper.glb': sniperUrl,
  'pistol.glb': pistolUrl,
  'lmg.glb': lmgUrl,
  'rocket_launcher_low.gltf': rocketUrl,
  'Military knife.glb': knifeUrl,
  'LowPolyShieldPack.glb': shieldUrl,
  'knife.glb': fistUrl,
});
