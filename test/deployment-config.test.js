import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DEV_PROXY_TARGET,
  DEFAULT_GAME_SERVER_HOST,
  DEFAULT_GAME_SERVER_PORT,
} from '../shared/deployment.js';
import {
  GameDatabase,
  assertSupportedNodeRuntime,
  parseNodeVersion,
  resolveDatabaseConfig,
} from '../server/database.js';
import { resolveProfileStorePath } from '../server/profiles.js';

// The server binds DEFAULT_GAME_SERVER_PORT when PORT is unset while Vite proxies
// /socket.io to its own notion of where the server lives. If those two ever
// disagree, `npm run dev` shows the project's signature CONNECTION LOST screen for
// a reason no deploy log would explain. These assertions make that drift a test
// failure instead of a debugging session, so keep them honest rather than deleting
// them when a port legitimately changes - change shared/deployment.js once instead.

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the shared default port is the documented local standard', () => {
  assert.equal(DEFAULT_GAME_SERVER_PORT, 3000);
  assert.equal(DEFAULT_DEV_PROXY_TARGET, `http://127.0.0.1:${DEFAULT_GAME_SERVER_PORT}`);
  assert.equal(DEFAULT_GAME_SERVER_HOST, '0.0.0.0');
});

test('the server derives its fallback port from the shared constant', () => {
  const source = read('../server/index.js');
  assert.match(source, /DEFAULT_GAME_SERVER_PORT/, 'server/index.js must use the shared constant');
  // `|| 3000` style literals would silently win over, or drift from, the constant.
  assert.doesNotMatch(source, /process\.env\.PORT\)\s*\|\|\s*\d/, 'no numeric PORT fallback allowed');
  assert.doesNotMatch(source, /process\.env\.HOST\)\s*\|\|\s*['"]/, 'no string HOST literal allowed');
  // Number() must survive: hosts inject PORT as a string and listen() would treat
  // a bare string as a named pipe.
  assert.match(source, /Number\(process\.env\.PORT\)/);
});

test('the Vite dev proxy derives its target from the shared constant', () => {
  const source = read('../vite.config.js');
  assert.match(source, /DEFAULT_DEV_PROXY_TARGET/, 'vite.config.js must use the shared constant');
  assert.doesNotMatch(source, /127\.0\.0\.1:\d/, 'no hardcoded loopback port in the proxy target');
});

test('.env.example advertises the same port the code defaults to', () => {
  const example = read('../.env.example');
  const port = example.match(/^PORT=(.+)$/m)?.[1];
  const proxyTarget = example.match(/^GAME_SERVER_URL=(.+)$/m)?.[1];
  assert.equal(port, String(DEFAULT_GAME_SERVER_PORT), '.env.example PORT drifted from the shared default');
  assert.equal(proxyTarget, DEFAULT_DEV_PROXY_TARGET, '.env.example GAME_SERVER_URL drifted');
});

test('the README documents the current default rather than a stale port', () => {
  const readme = read('../README.md');
  assert.ok(!/\|\s*`PORT`\s*\|\s*`\d+`\s*\|/.test(readme) || readme.includes(`\`PORT\` | \`${DEFAULT_GAME_SERVER_PORT}\``));
  assert.match(readme, new RegExp(`Vite proxies Socket\\.IO traffic to port ${DEFAULT_GAME_SERVER_PORT}`));
  // The distinction that has caused real outages: the fallback is local-only.
  assert.match(readme, /inject`? ?`?PORT`?/, 'README must state that hosts inject PORT');
});

test('public assets directory contains all required GLB models for web root delivery', async () => {
  const requiredAssets = [
    '../public/assets/map/arena_map.glb',
    '../public/assets/characters/character.glb',
    '../public/assets/animations/animations.glb',
    '../public/assets/weapons/Military knife.glb',
    '../public/assets/weapons/LowPolyShieldPack.glb',
    '../public/assets/weapons/lmg.glb',
    '../public/assets/weapons/pistol.glb',
    '../public/assets/weapons/rifle.glb',
    '../public/assets/weapons/rocket_launcher_low.gltf',
    '../public/assets/weapons/shotgun.glb',
    '../public/assets/weapons/smg.glb',
    '../public/assets/weapons/sniper.glb',
  ];
  for (const asset of requiredAssets) {
    const assetUrl = new URL(asset, import.meta.url);
    assert.equal(existsSync(assetUrl), true, `Asset ${asset} must exist in public/`);
  }
});

test('Node runtime pins and Railway/Render configs enforce >=22.13.0 for built-in node:sqlite', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.engines?.node, '>=22.13.0', 'package.json engines.node must reject Node 20 (<22.13.0)');

  const nodeVersionFile = read('../.node-version').trim();
  const nvmrcFile = read('../.nvmrc').trim();
  const renderNodeVersion = read('../render.yaml').match(/NODE_VERSION\s*\n\s*value:\s*([^\s#]+)/)?.[1]?.trim();

  assert.equal(nodeVersionFile, nvmrcFile, '.node-version and .nvmrc must agree');
  assert.equal(nodeVersionFile, renderNodeVersion, '.node-version and render.yaml NODE_VERSION must agree');
  const pinned = parseNodeVersion(nodeVersionFile);
  assert.ok(pinned, 'pinned Node version must parse as major.minor.patch');
  assert.ok(
    pinned.major > 22 || (pinned.major === 22 && pinned.minor >= 13),
    `pinned Node version ${nodeVersionFile} must be >= 22.13.0`,
  );

  const railway = JSON.parse(read('../railway.json'));
  assert.equal(railway.build?.builder, 'RAILPACK');
  assert.equal(railway.deploy?.startCommand, 'node server/index.js');
  assert.equal(railway.deploy?.healthcheckPath, '/health');

  // Verify the exact Railway crash runtime (Node 20.20.2) and flagged Node 22.12.0 are rejected clearly.
  assert.throws(
    () => assertSupportedNodeRuntime('20.20.2'),
    (err) => err.code === 'ERR_UNSUPPORTED_NODE_RUNTIME' && /22\.13\.0/.test(err.message),
  );
  assert.throws(
    () => assertSupportedNodeRuntime('22.12.0'),
    (err) => err.code === 'ERR_UNSUPPORTED_NODE_RUNTIME',
  );
  assert.deepEqual(assertSupportedNodeRuntime('22.13.0'), {
    major: 22,
    minor: 13,
    patch: 0,
    raw: '22.13.0',
  });
  assert.ok(assertSupportedNodeRuntime(process.versions.node));
});

test('Railway persistent volume paths, directory env overrides, and unwritable volume fallbacks work safely', () => {
  const tmpVolume = mkdtempSync(join(tmpdir(), 'fps-gods-railway-vol-'));
  try {
    // 1. Automatic RAILWAY_VOLUME_MOUNT_PATH detection when SQLITE_DB_PATH is unset.
    const autoVol = resolveDatabaseConfig(
      { isTestRunner: false },
      { RAILWAY_VOLUME_MOUNT_PATH: tmpVolume },
    );
    assert.equal(autoVol.mode, 'railway-volume');
    assert.equal(autoVol.durableConfigured, true);
    assert.equal(autoVol.dbPath, join(tmpVolume, 'fps-gods.sqlite'));

    const autoProfile = resolveProfileStorePath({ RAILWAY_VOLUME_MOUNT_PATH: tmpVolume });
    assert.equal(autoProfile, join(tmpVolume, 'profiles.json'));

    // 2. Directory-valued SQLITE_DB_PATH (e.g. SQLITE_DB_PATH=/data) appends fps-gods.sqlite instead of crashing.
    const dirOverride = resolveDatabaseConfig(
      { isTestRunner: false },
      { SQLITE_DB_PATH: tmpVolume },
    );
    assert.equal(dirOverride.mode, 'configured-volume');
    assert.equal(dirOverride.dbPath, join(tmpVolume, 'fps-gods.sqlite'));

    // 3. Unwritable non-explicit volume path degrades to in-memory SQLite instead of crash-looping the container.
    const blockerFile = join(tmpVolume, 'not-a-directory');
    const blockingDb = new GameDatabase({ dbPath: blockerFile });
    blockingDb.close();
    // Passing a path nested under an existing regular file causes mkdirSync to fail with ENOTDIR/EEXIST.
    const fallbackDb = new GameDatabase({
      isTestRunner: false,
      env: { SQLITE_DB_PATH: join(blockerFile, 'sub', 'fps-gods.sqlite') },
    });
    try {
      const summary = fallbackDb.getPersistenceSummary();
      assert.equal(summary.mode, 'memory-fallback');
      assert.equal(summary.durableConfigured, false);
      assert.ok(summary.fallbackReason);
    } finally {
      fallbackDb.close();
    }
  } finally {
    rmSync(tmpVolume, { recursive: true, force: true });
  }
});
