import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUNDLE_INFO } from '../shared/bundles.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = resolve(repoRoot, 'client');
const publicDir = resolve(repoRoot, 'public');

/**
 * Remove comments while respecting string literals.
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

test('public asset directory contains all required GLB models', () => {
  const required = [
    'assets/map/arena_map.glb',
    'assets/characters/character.glb',
    'assets/animations/animations.glb',
    'assets/weapons/knife.glb',
    'assets/weapons/lmg.glb',
    'assets/weapons/pistol.glb',
    'assets/weapons/rifle.glb',
    'assets/weapons/rocket.glb',
    'assets/weapons/shotgun.glb',
    'assets/weapons/smg.glb',
    'assets/weapons/sniper.glb',
  ];
  for (const file of required) {
    const target = resolve(publicDir, file);
    assert.ok(existsSync(target), `public/${file} is missing`);
  }
});

test('every weapon model referenced by weapons.js exists', () => {
  const weaponsJs = readFileSync(resolve(clientDir, 'weapons.js'), 'utf8');
  for (const match of weaponsJs.matchAll(/from\s+['"]([^'"]+\?url)['"]/g)) {
    const specifier = match[1].replace(/\?url$/, '');
    const target = resolve(clientDir, specifier);
    assert.ok(existsSync(target), `weapons.js imports '${match[1]}' but ${target} does not exist`);
  }
});

test('every bundle weapon resolves to a GLB that ships with the client', () => {
  // The lobby stage was replaced by MenuStage, which also uses this table, so the
  // table itself is now the single thing worth pinning.
  const modelSource = readFileSync(resolve(repoRoot, 'shared', 'weaponModels.js'), 'utf8');
  const realWeaponIds = new Set(
    Object.values(BUNDLE_INFO).flatMap((bundle) => bundle.weapons.map((weapon) => weapon.id)),
  );

  for (const weaponId of realWeaponIds) {
    const modelFile = modelSource.match(new RegExp(`${weaponId}:\\s*'([^']+\\.glb)'`))?.[1];
    assert.ok(modelFile, `shared/weaponModels.js has no model mapping for ${weaponId}`);
    assert.ok(
      existsSync(resolve(clientDir, 'assets/weapons', modelFile)),
      `client/assets/weapons/${modelFile} is missing for ${weaponId}`,
    );
    assert.ok(
      modelSource.includes(`'${modelFile}':`),
      `${modelFile} has no measured length in shared/weaponModels.js`,
    );
  }
});

test('main.js gates the lobby on the asset API that actually exists', () => {
  const main = stripComments(readFileSync(resolve(clientDir, 'main.js'), 'utf8'));
  assert.match(main, /assetManager\.ready/, 'main.js must read the settled asset status');
  assert.match(main, /Promise\.allSettled\(\[assetBoot, weaponModels\.ready\]\)/, 'lobby must boot when both asset sources settle');
  assert.doesNotMatch(main, /setTimeout\(\s*\(\)\s*=>\s*\{\s*\n?\s*if \(assetsLoaded\)/, 'a fixed-delay timer must not gate the lobby');

  const assetManager = readFileSync(resolve(clientDir, 'AssetManager.js'), 'utf8');
  assert.match(assetManager, /get ready\(\)/, 'AssetManager must expose `ready`');
  assert.match(assetManager, /this\.status = \{/, 'AssetManager must record load outcomes');
});

test('the comment scrubber respects string literals', () => {
  assert.equal(stripComments("const u = 'http://x/y'; // /assets/dead.glb"), "const u = 'http://x/y'; ");
  assert.equal(stripComments('a; /* /assets/dead.glb */ b;'), 'a;  b;');
  assert.equal(stripComments("// gone\nlet keep = 1;"), '\nlet keep = 1;');
  assert.equal(stripComments("const s = 'a \\' // not a comment';"), "const s = 'a \\' // not a comment';");
});
