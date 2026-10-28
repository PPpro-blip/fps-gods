import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMemoryProfileStore } from '../server/profiles.js';
import { createGameServer } from '../server/index.js';
import { GameState } from '../server/gameState.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function startServer() {
  const server = createGameServer({ profileStore: createMemoryProfileStore() });
  const port = await new Promise((resolvePromise, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', () => resolvePromise(server.httpServer.address().port));
  });
  return { ...server, port, url: `http://127.0.0.1:${port}` };
}

function runBootFixture(url, { input = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(repoRoot, 'test/fixtures/boot-client.mjs'), url, ...(input ? ['--check-input'] : [])], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`client match fixture timed out. stderr: ${stderr.slice(-800)}`));
    }, 90_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entry) => entry.startsWith('BOOT_RESULT '));
      if (!line) {
        reject(new Error(`no BOOT_RESULT (exit ${code}). stderr: ${stderr.slice(-1500)}`));
        return;
      }
      resolvePromise(JSON.parse(line.slice('BOOT_RESULT '.length)));
    });
  });
}

// The whole loop the player sees: a real server, a real socket, a real room,
// real bot ticks, and the HUD rendered from the server's authoritative state.
// Rendering and pointer lock are the only things jsdom cannot exercise.
test('a real client joins a real solo match and the HUD follows server state', async () => {
  const server = await startServer();
  try {
    const report = await runBootFixture(server.url);

    assert.equal(report.imported, true, `main.js threw during import: ${report.errors.join('\n')}`);
    assert.deepEqual(report.unhandled, [], `unhandled errors: ${report.unhandled.join('; ')}`);
    assert.equal(report.connectionLabel, 'LIVE ARENA', 'the health probe must confirm the live server');

    const match = report.match;
    assert.ok(match, 'the fixture must report match state');
    assert.equal(match.hudVisible, true, 'the match HUD must take over the screen');
    assert.equal(match.menuHidden, true, 'the menu must step aside once the match starts');
    assert.match(match.roomCode, /^[A-Z2-9]{6}$/, `room code looked wrong: ${match.roomCode}`);
    assert.equal(match.scoreboardTarget, match.roomCode);

    // Values come from the server, not from a client guess.
    assert.equal(match.targetKills, '30');
    const health = Number(match.health);
    assert.ok(health >= 0 && health <= 100, `health out of range: ${match.health}`);
    assert.ok(Math.abs(parseFloat(match.healthBarWidth) - health) < 1, 'the precise bar must match the rounded health number');
    // The bots are live, so the operator may already be down: the panels have to
    // agree with whatever the server says.
    if (health === 0) {
      assert.equal(match.deathVisible, true, 'a downed operator must see the redeploy panel');
      assert.match(match.respawnCountdown ?? '', /^\d\.\d$/, 'the respawn countdown must be running');
    } else {
      assert.equal(match.deathVisible, false);
    }
    assert.ok(Number(match.ammo) > 0, `expected loaded ammo, got ${match.ammo}`);
    assert.equal(match.weapon, 'SMG');
    assert.ok(Number(match.aliveCount) >= 2, 'the player plus bots must be alive');
    assert.match(match.fps, /^\d+ FPS$/);

    // The scoreboard lists the room's operators, bots included.
    assert.equal(match.scoreboardVisible, true);
    assert.equal(match.scoreboardRows, 6, 'one player and five bots');
    assert.ok(match.scoreboardNames.includes('BootTester'), 'the local player is on the board');
    assert.equal(match.scoreboardNames.filter((name) => name.startsWith('GOD_BOT_')).length, 5);
    assert.equal(match.scoreboardHasBot, true, 'bots are labelled');
    assert.equal(match.scoreboardClosed, true, 'a second Tab closes the board');

    // The 20 Hz tick keeps arriving after the first snapshot.
    assert.ok(Number(match.aliveCountAfter) >= 1, 'the HUD must keep updating');
  } finally {
    await new Promise((resolvePromise) => server.httpServer.close(resolvePromise));
    server.close();
  }
});


test('the real client sends key edges and one shot, then handles its authoritative echo', async () => {
  const originalBots = GameState.prototype.updateBots;
  const originalSetInput = GameState.prototype.setInput;
  const inputs = [];
  GameState.prototype.updateBots = () => {}; // keep the local player alive for deterministic input checks
  GameState.prototype.setInput = function (id, payload, now) {
    if (payload && typeof payload === 'object') inputs.push(payload);
    return originalSetInput.call(this, id, payload, now);
  };
  const server = await startServer();
  try {
    const report = await runBootFixture(server.url, { input: true });
    assert.deepEqual(report.windowErrors, [], `client event handler error: ${report.windowErrors.join('; ')}`);
    assert.deepEqual(report.unhandled, []);
    assert.ok(inputs.filter((entry) => entry.forward === 1).length >= 2, 'keydown and held heartbeat reach the server without render frames');
    assert.equal(inputs.at(-1)?.forward, 0, 'keyup reached the server');
    assert.equal(report.match.action.ammoAfter, report.match.action.ammoBefore - 1, 'one accepted shot consumes one round');
    assert.equal(report.match.action.ammoWhileBlurred, report.match.action.ammoAfterBlur, 'blur stops a held automatic trigger');
    assert.equal(report.match.action.ammoAfterFocus, report.match.action.ammoAfterBlur, 'focus does not restart a stale trigger');
  } finally {
    GameState.prototype.updateBots = originalBots;
    GameState.prototype.setInput = originalSetInput;
    await server.close();
  }
});
