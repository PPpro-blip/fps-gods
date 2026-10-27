import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = resolve(repoRoot, 'client');
const buildDir = resolve(repoRoot, 'dist/test-client');

// Production asset resolution.
//
// The 404s this suite exists to prevent were invisible to every other test:
// they were real files in `public/`, the unit tests loaded them straight from
// disk, and only the deployed bundle asked the network for a URL that the host
// did not have. So these checks look at what the *build* emits and what the
// *loader* asks for, never at a mocked 200.

const GLB_MAGIC = 'glTF';

function md5(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function assertGlb(path, label) {
  assert.ok(existsSync(path), `${label} does not exist at ${path}`);
  const size = statSync(path).size;
  assert.ok(size > 1_000, `${label} is only ${size} bytes`);
  const head = readFileSync(path).subarray(0, 4).toString('latin1');
  assert.equal(head, GLB_MAGIC, `${label} is not a GLB (magic bytes: ${JSON.stringify(head)})`);
  return size;
}

test('the assets the client imports for production exist in the repository', () => {
  const source = readFileSync(resolve(clientDir, 'assetUrls.js'), 'utf8');
  const specifiers = [...source.matchAll(/from\s+'(\.\/assets\/[^']+\?url)'/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 2, 'assetUrls.js must import the character and the map kit');

  for (const specifier of specifiers) {
    const relative = specifier.replace(/\?url$/, '');
    const target = resolve(clientDir, relative);
    assertGlb(target, `${specifier} resolves to a missing or invalid file`);
  }

  // The two required assets specifically, not just "some GLBs".
  const required = ['characters/character.glb', 'map/arena_map.glb'];
  for (const relative of required) {
    assert.ok(
      specifiers.some((specifier) => specifier.includes(relative)),
      `assetUrls.js no longer imports ${relative} — the loader would fall back to an unhashed public URL`,
    );
    assertGlb(resolve(clientDir, 'assets', relative), `client/assets/${relative}`);
  }
});

test('the public/ mirror is byte-identical, so the fallback cannot point at a different model', () => {
  for (const relative of ['characters/character.glb', 'map/arena_map.glb']) {
    const bundled = resolve(clientDir, 'assets', relative);
    const mirrored = resolve(repoRoot, 'public/assets', relative);
    assert.ok(existsSync(mirrored), `public/assets/${relative} is missing`);
    assert.equal(md5(mirrored), md5(bundled), `public/assets/${relative} drifted from client/assets/${relative}`);
  }
});

test('the loader requests bundler-resolved URLs, not hardcoded public paths', () => {
  const loader = readFileSync(resolve(clientDir, 'AssetManager.js'), 'utf8');
  // The URL must come from the `?url` module...
  assert.match(loader, /import\('\.\/assetUrls\.js'\)/, 'AssetManager must resolve URLs through the bundler');
  assert.match(loader, /ASSET_URLS\.character/, 'the character URL must come from the bundled module');
  assert.match(loader, /ASSET_URLS\.map\b/, 'the map URL must come from the bundled module');
  // ...and never be requested inline, which is the shape the 404 took.
  assert.doesNotMatch(loader, /loadAsync\(\s*'\/assets\//, 'a hardcoded /assets/ URL must not reach the loader');
  // No silent second-chance download of a lookalike map file.
  assert.doesNotMatch(loader, /mapFallback/, 'a missing map must be reported, not swapped for another file');
  assert.match(loader, /recordFailure\('map'/, 'a map failure must be recorded');
  assert.match(loader, /recordFailure\('character'/, 'a character failure must be recorded');
  // Production must never fall back to the unhashed public paths.
  assert.match(loader, /resolveUrls\(\)/, 'loadAll must resolve bundled URLs');
  assert.doesNotMatch(loader, /resolveUrls\(\{[^}]*allowPublicFallback:\s*true/, 'production must not opt into the public fallback');
  assert.match(loader, /recordUnresolvedUrls\(/, 'a missing URL set must be reported, not guessed around');
});

test('a production build emits hashed, existing, valid GLB URLs for the character and the map', (t) => {
  const viteBin = resolve(repoRoot, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) {
    t.skip('vite is not installed');
    return;
  }

  rmSync(buildDir, { recursive: true, force: true });
  // `--outDir` is resolved against Vite's root (client/), so it must be absolute.
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', buildDir, '--logLevel', 'error'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  try {
    const bundledDir = resolve(buildDir, 'bundled');
    assert.ok(existsSync(bundledDir), 'the build must emit /bundled output');

    const files = readdirSync(bundledDir);
    const bundle = files.find((file) => /^index-.*\.js$/.test(file));
    assert.ok(bundle, 'the build must emit an index bundle');
    const bundleSource = readFileSync(resolve(bundledDir, bundle), 'utf8');

    // Vite's hashed URL for each required asset, straight out of the built JS.
    const characterUrl = bundleSource.match(/\/bundled\/character-[A-Za-z0-9_-]+\.glb/)?.[0]
      ?? files.filter((file) => file.startsWith('character-')).map((file) => `/bundled/${file}`)[0];
    const mapUrl = bundleSource.match(/\/bundled\/arena_map-[A-Za-z0-9_-]+\.glb/)?.[0]
      ?? files.filter((file) => file.startsWith('arena_map-')).map((file) => `/bundled/${file}`)[0];

    assert.ok(characterUrl, 'the built client must reference a hashed character GLB');
    assert.ok(mapUrl, 'the built client must reference a hashed map GLB');
    assert.match(characterUrl, /^\/bundled\/character-[A-Za-z0-9_-]+\.glb$/, 'the character URL must be content-hashed');
    assert.match(mapUrl, /^\/bundled\/arena_map-[A-Za-z0-9_-]+\.glb$/, 'the map URL must be content-hashed');

    // Every asset URL the bundle can request must be a file in the shipped build.
    const requested = new Set(
      [...bundleSource.matchAll(/["'`](\/bundled\/[A-Za-z0-9._/-]+\.(?:glb|js|css))["'`]/g)].map((m) => m[1]),
    );
    for (const name of files) {
      if (name.endsWith('.glb')) requested.add(`/bundled/${name}`);
    }
    assert.ok(requested.size >= 9, `expected the character, map and seven weapons, saw ${requested.size}`);

    for (const url of requested) {
      const path = resolve(buildDir, url.replace(/^\//, ''));
      assert.ok(existsSync(path), `the built client can request ${url} but ${path} is not in the build output`);
    }

    // The two required assets, verified as real GLBs of the same byte length as
    // their sources — not just "a file with the right name showed up".
    const characterOnDisk = resolve(buildDir, characterUrl.replace(/^\//, ''));
    const mapOnDisk = resolve(buildDir, mapUrl.replace(/^\//, ''));
    assert.equal(
      assertGlb(characterOnDisk, 'built character GLB'),
      statSync(resolve(clientDir, 'assets/characters/character.glb')).size,
      'the deployed character GLB does not match the source asset size',
    );
    assert.equal(
      assertGlb(mapOnDisk, 'built map GLB'),
      statSync(resolve(clientDir, 'assets/map/arena_map.glb')).size,
      'the deployed map GLB does not match the source asset size',
    );

    // index.html has to point at the hashed bundle, which is what makes the
    // deploy self-consistent.
    const html = readFileSync(resolve(buildDir, 'index.html'), 'utf8');
    assert.match(html, /\/bundled\/index-[A-Za-z0-9_-]+\.js/, 'index.html must load the hashed client bundle');

    // The hashed URLs must come from the bundler, i.e. they live in the
    // assetUrls chunk that the client imports — not inlined at the call site.
    const assetUrlsChunk = files.find((file) => /^assetUrls-.*\.js$/.test(file));
    assert.ok(assetUrlsChunk, 'the build must emit the assetUrls chunk');
    const assetUrlsSource = readFileSync(resolve(bundledDir, assetUrlsChunk), 'utf8');
    assert.ok(assetUrlsSource.includes(characterUrl), 'the assetUrls chunk must export the hashed character URL');
    assert.ok(assetUrlsSource.includes(mapUrl), 'the assetUrls chunk must export the hashed map URL');
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});

/* ─────────────────────────── failure diagnostics ─────────────────────────── */

async function createManagerWithFetch(fetchImpl) {
  const { AssetManager } = await import('../client/AssetManager.js');
  const manager = new AssetManager();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  manager.glbLoader = {
    loadAsync: async (url) => {
      throw new Error(`Failed to fetch ${url}: 404 Not Found`);
    },
  };
  return {
    manager,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

test('a missing operator asset is recorded with its URL and the host status', async () => {
  const { manager, restore } = await createManagerWithFetch(async () => ({
    ok: false,
    status: 404,
    headers: { get: () => 'text/plain' },
  }));

  try {
    await manager.loadCharacter('/bundled/character-deadbeef.glb');
    assert.equal(manager.ready, false);
    assert.equal(manager.hasFailures, true);

    const [failure] = manager.failures;
    assert.equal(failure.asset, 'character');
    assert.equal(failure.url, '/bundled/character-deadbeef.glb');
    assert.equal(failure.reason, 'http-404');
    assert.equal(failure.status, 404);
    assert.match(failure.advice, /not contain this file/);

    const lines = manager.describeFailures();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Operator model/);
    assert.match(lines[0], /\/bundled\/character-deadbeef\.glb/, 'the report must name the URL that was requested');

    const snapshot = manager.diagnostics();
    assert.equal(snapshot.sources.character, '/bundled/character-deadbeef.glb');
    assert.equal(snapshot.failed.includes('character'), true);
  } finally {
    restore();
  }
});

test('a 200 that is really the SPA HTML is diagnosed as such, not as a parse error', async () => {
  const html = new TextEncoder().encode('<!doctype html><html><body>app</body></html>');
  const { manager, restore } = await createManagerWithFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    arrayBuffer: async () => html.buffer,
  }));

  try {
    await manager.loadMap('/bundled/arena_map-deadbeef.glb');
    const [failure] = manager.failures;
    assert.equal(failure.asset, 'map');
    assert.equal(failure.reason, 'html-instead-of-glb');
    assert.match(failure.advice, /SPA HTML/);
    assert.equal(manager.mapReady, false, 'the manager must not claim the map loaded');
  } finally {
    restore();
  }
});

test('a real GLB body is not reported as a failure of the response', async () => {
  const bytes = new Uint8Array(16);
  bytes.set([0x67, 0x6c, 0x54, 0x46]); // "glTF"
  const { manager, restore } = await createManagerWithFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'model/gltf-binary' },
    arrayBuffer: async () => bytes.buffer,
  }));

  try {
    await manager.loadCharacter('/bundled/character-deadbeef.glb');
    // The body is valid, so the recorded reason must be about the parse, not
    // about the host — that distinction is what tells an operator where to look.
    assert.equal(manager.failures[0].reason, 'unreadable-glb');
  } finally {
    restore();
  }
});

test('without a bundler the public fallback is opt-in, and production never takes it', async () => {
  const { AssetManager, PUBLIC_ASSET_PATHS } = await import('../client/AssetManager.js');

  // Explicit opt-in (Node tooling, tests): the public paths, clearly labelled.
  const optIn = new AssetManager();
  const publicUrls = await optIn.resolveUrls({ allowPublicFallback: true });
  assert.equal(optIn.urlSource, 'public-fallback');
  assert.deepEqual(publicUrls, { ...PUBLIC_ASSET_PATHS });

  // Production path: no bundler means no URLs, and no requests to guess at.
  const production = new AssetManager();
  const requested = [];
  production.glbLoader = { loadAsync: async (url) => { requested.push(url); throw new Error('should not be called'); } };
  const result = await production.loadAll();

  assert.equal(result, false, 'the boot must report failure rather than pretend');
  assert.equal(production.urlSource, 'unavailable');
  assert.deepEqual(requested, [], 'no asset URL may be guessed when the bundler did not provide one');
  assert.equal(production.failures.length, 2);
  for (const failure of production.failures) {
    assert.equal(failure.reason, 'unresolved-urls');
    assert.match(failure.advice, /without the Vite bundler/);
  }
  assert.equal(production.ready, false);
  assert.equal(production.mapReady, false);
  assert.equal(production.describeFailures().length, 2);
});
