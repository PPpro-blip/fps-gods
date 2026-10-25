import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Boots client/main.js for real inside jsdom (see the fixture) and checks the
// wiring end to end: module-level setup, the asset promises failing gracefully,
// the socket reporting the arena as offline, onboarding, settings persistence
// and the "deploy while disconnected" error path.
function runBootFixture() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(repoRoot, 'test/fixtures/boot-client.mjs')], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`client boot fixture timed out. stderr: ${stderr.slice(-800)}`));
    }, 60_000);

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
        reject(new Error(`no BOOT_RESULT from the client (exit ${code}). stderr: ${stderr.slice(-1200)}`));
        return;
      }
      resolvePromise({ code, report: JSON.parse(line.slice('BOOT_RESULT '.length)) });
    });
  });
}

test('the client boots, degrades cleanly without WebGL, and reports an offline arena', async () => {
  const { code, report } = await runBootFixture();
  assert.equal(code, 0);
  assert.equal(report.imported, true, `main.js threw during import: ${report.errors.join('\n')}`);
  assert.deepEqual(report.unhandled, [], `unhandled errors at runtime: ${report.unhandled.join('; ')}`);
  assert.deepEqual(report.errors, []);

  // Missing assets and a dead server are survivable, not fatal.
  assert.equal(report.loadingHidden, true, 'the loading overlay must always be dismissed');
  assert.equal(report.webglWarningShown, true, 'a missing WebGL context must be announced');
  assert.equal(report.connectionLabel, 'SERVER OFFLINE');
  assert.match(report.serverLine, /arena\.test \(same origin\)/, 'the deployment badge names the socket target');

  // Onboarding drives the real handlers, including the server-side name check.
  assert.equal(report.loadoutStepVisible, true);
  assert.equal(report.onboardingAfterContinue, true);
  assert.equal(report.loadoutLine, 'RUSHER — SMG · SHOTGUN · KNIFE');
  assert.equal(report.playError, 'Still connecting to the game server. Try again in a moment.');

  // Settings round-trip through localStorage.
  assert.equal(report.storedSensitivity, 2);

  // The room browser works with no server, and says why it is empty.
  assert.equal(report.roomsScreenVisible, true);
  assert.match(report.roomListText, /Room list unavailable/);
  assert.match(report.roomListText, /Not connected/);
});
