import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_DEV_PROXY_TARGET,
  DEFAULT_GAME_SERVER_HOST,
  DEFAULT_GAME_SERVER_PORT,
} from '../shared/deployment.js';

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
  const { existsSync } = await import('node:fs');
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
