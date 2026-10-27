// Critical GLB assets imported through Vite so the bundler — not a deployment
// convention — decides their URL.
//
// `?url` makes Vite emit the file into the build output with a content hash and
// rewrite the import to that exact path (`/bundled/character-<hash>.glb`). That
// matters for two reasons:
//
//  1. The URL cannot drift from the file: if the asset is missing from the
//     repository the build fails instead of shipping a 404.
//  2. Hashed URLs are safe to cache forever, so a redeploy can never leave a
//     player pinned to a stale copy (or a stale 404) of an unhashed path.
//
// The previous build served these two assets from `public/assets/...` with
// unhashed names, which is exactly the class of path that produced the
// production 404s for `character.glb` and `arena_map.glb`.
//
// Kept in its own module so `AssetManager.js` can import it dynamically: the
// Node test suite has no bundler, and a `?url` specifier cannot be resolved
// outside Vite.
import characterUrl from './assets/characters/character.glb?url';
import arenaMapUrl from './assets/map/arena_map.glb?url';

export const ASSET_URLS = Object.freeze({
  // The rigged operator, which also carries the twelve animation clips.
  character: characterUrl,
  // The modular environment kit that MenuStage assembles the menu backdrop from.
  map: arenaMapUrl,
});
