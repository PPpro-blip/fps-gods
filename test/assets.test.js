import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUNDLE_INFO } from '../shared/bundles.js';

// Why this file exists: three of the four asset paths in AssetManager.js pointed
// at files that were never in the repository (`arena_map.glb`, `animations.glb`,
// `rifle.glb`). Every one of those loaders caught its own error and assigned
// null, so nothing failed loudly - players just saw 404s in the network panel and
// a lobby character holding nothing. A test that reads the source is the only
// way to catch this class of bug, because those modules import Three.js and
// cannot be loaded by Node at all.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = resolve(repoRoot, 'client');

/**
 * Remove comments while respecting string literals.
 *
 * These guards police *code*, so a comment that records "this used to fetch
 * /assets/weapons/rifle.glb" must not fail the build - such notes are exactly the
 * kind of context that stops a bug coming back. Quote tracking is what makes the
 * scrub safe: a naive `//` strip would shred the `://` in every URL.
 */
function stripComments(source) {
  let out = '';
  let quote = null;
  let state = 'code'; // code | line | block
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; }
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { state = 'line'; i += 1; continue; }
    if (ch === '/' && next === '*') { state = 'block'; i += 1; continue; }
    out += ch;
  }
  return out;
}

const clientSources = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'node_modules') continue;
      walk(resolve(dir, entry.name));
    } else if (entry.name.endsWith('.js')) {
      const path = resolve(dir, entry.name);
      const raw = readFileSync(path, 'utf8');
      clientSources.push({ path, relative: `client/${path.slice(clientDir.length + 1)}`, text: raw, code: stripComments(raw) });
    }
  }
})(clientDir);

test('every ?url asset import resolves to a file that exists', () => {
  let checked = 0;
  for (const { path, relative, code } of clientSources) {
    for (const match of code.matchAll(/from\s+['"]([^'"]+\?url)['"]/g)) {
      const specifier = match[1].replace(/\?url$/, '');
      const target = resolve(dirname(path), specifier);
      assert.ok(existsSync(target), `${relative} imports '${match[1]}' but ${target} does not exist`);
      checked += 1;
    }
  }
  // If this ever drops to 0, the guard has been disarmed rather than satisfied.
  assert.ok(checked >= 8, `expected the 7 weapon GLBs plus the character GLB to be imported, saw ${checked}`);
});

test('no client module hand-writes a runtime /assets/... URL', () => {
  // Vite only serves files under publicDir, and this project has none, so a
  // literal web path is guaranteed to 404. Bundler imports are the only correct
  // way to reference an asset here.
  const offenders = [];
  for (const { relative, code } of clientSources) {
    for (const match of code.matchAll(/['"`](\/assets\/[^'"`]+)['"`]/g)) {
      offenders.push(`${relative} -> ${match[1]}`);
    }
    for (const match of code.matchAll(/['"`]\/assets\/\$\{([^}]*)\}/g)) {
      offenders.push(`${relative} -> interpolated /assets/ path (${match[1]})`);
    }
  }
  assert.deepEqual(offenders, [], `runtime asset paths will 404; import with ?url instead:\n${offenders.join('\n')}`);
});

test('the phantom asset filenames are gone for good', () => {
  // These names never existed. Reappearing means someone re-copied the old paths.
  const phantoms = ['arena_map.glb', 'animations.glb', 'rifle.glb'];
  const sources = [...clientSources.map(({ relative, code }) => ({ relative, code })), { relative: 'shared/bundles.js', code: stripComments(readFileSync(resolve(repoRoot, 'shared/bundles.js'), 'utf8')) }];
  for (const source of sources) {
    for (const phantom of phantoms) {
      assert.ok(!source.code.includes(phantom), `${source.relative} still references ${phantom}`);
    }
  }
});

test('every weapon the code can attach to the lobby exists as a GLB', () => {
  const weaponsJs = readFileSync(resolve(clientDir, 'weapons.js'), 'utf8');
  const lobbySource = readFileSync(resolve(clientDir, 'LobbyScene.js'), 'utf8');
  const lobbyDefault = lobbySource
    .match(/loadLobbyWeapon\(weaponId\s*=\s*'([A-Z_]+)'\)/)?.[1];
  assert.ok(lobbyDefault, 'LobbyScene must declare an explicit default lobby weapon id');

  const realWeaponIds = new Set(
    Object.values(BUNDLE_INFO).flatMap((bundle) => bundle.weapons.map((weapon) => weapon.id)),
  );
  assert.ok(realWeaponIds.has(lobbyDefault), `'${lobbyDefault}' is not a weapon id the server knows`);

  const modelFile = weaponsJs.match(new RegExp(`${lobbyDefault}:\\s*'([^']+\\.glb)'`))?.[1];
  assert.ok(modelFile, `weapons.js has no model mapping for ${lobbyDefault}`);
  assert.ok(existsSync(resolve(clientDir, 'assets/weapons', modelFile)), `assets/weapons/${modelFile} is missing`);
});

test('main.js gates the lobby on the asset API that actually exists', () => {
  // A flag flipped by a timer was how the lobby silently never appeared. Assert
  // the real contract is used and that it is still exported.
  const main = stripComments(readFileSync(resolve(clientDir, 'main.js'), 'utf8'));
  assert.match(main, /assetManager\.ready/, 'main.js must read the settled asset status');
  assert.match(main, /Promise\.allSettled\(\[assetBoot, weaponModels\.ready\]\)/, 'lobby must boot when both asset sources settle');
  assert.doesNotMatch(main, /setTimeout\(\s*\(\)\s*=>\s*\{\s*\n?\s*if \(assetsLoaded\)/, 'a fixed-delay timer must not gate the lobby');

  const assetManager = readFileSync(resolve(clientDir, 'AssetManager.js'), 'utf8');
  // The asset contract is a bundler import, not a string path, in every module.
  assert.match(assetManager, /from\s+['"]\./, 'AssetManager must import its assets');
  assert.doesNotMatch(stripComments(assetManager), /['"`]\/assets\//, 'no runtime asset path may return');
  // main.js reads `.ready`, and LobbyScene tolerates a missing clip, so both must stay.
  assert.match(assetManager, /get ready\(\)/, 'AssetManager must expose `ready`');
  assert.match(assetManager, /this\.status = \{/, 'AssetManager must record load outcomes instead of only nulling');
});

test('the comment scrubber respects string literals', () => {
  // Every guard above trusts stripComments, so a scrubber that ate quotes would
  // silently disable them all. Pin both halves of that behaviour.
  assert.equal(stripComments("const u = 'http://x/y'; // /assets/dead.glb"), "const u = 'http://x/y'; ");
  assert.equal(stripComments('a; /* /assets/dead.glb */ b;'), 'a;  b;');
  assert.equal(stripComments("// gone\nlet keep = 1;"), '\nlet keep = 1;');
  // An escaped quote inside a string must not start a phantom comment.
  assert.equal(stripComments("const s = 'a \\' // not a comment';"), "const s = 'a \\' // not a comment';");
});
