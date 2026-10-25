// Boots the real client entry point inside jsdom and reports what happened.
//
// WebGL is unavailable here (jsdom has no canvas backend), so this is not a
// rendering test. It is a wiring test: it runs every module-level statement in
// client/main.js, the asset boot promises, the socket, the input listeners and
// the animation loop.
//
//   node test/fixtures/boot-client.mjs                 -> offline behaviour
//   node test/fixtures/boot-client.mjs http://host:port -> joins a live server
//
// Run through test/client-boot.test.js and test/client-match.test.js.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverUrl = process.argv[2] ?? null;
const report = { errors: [], unhandled: [] };

process.on('uncaughtException', (error) => report.unhandled.push(String(error?.message ?? error)));
process.on('unhandledRejection', (error) => report.unhandled.push(String(error?.message ?? error)));

// With an explicit origin the fixture joins a live game server; without one it
// boots against a host that cannot be reached, which is the offline path.
const dom = new JSDOM(readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8'), {
  url: serverUrl ? new URL('/', serverUrl).href : 'https://arena.test/?room=ABC234',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);

// No Web Audio here, exactly like a browser that blocks it.
delete dom.window.AudioContext;
delete dom.window.webkitAudioContext;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const byId = (id) => document.getElementById(id);
const click = (id) => byId(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const nav = (screen) => document
  .querySelector(`[data-nav="${screen}"]`)
  .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

try {
  await import('../../client/main.js');
  report.imported = true;
} catch (error) {
  report.imported = false;
  report.errors.push(String(error?.stack ?? error));
}

// Let the asset promises settle, the health probe answer, and frames render.
await wait(2_500);

report.buildStamp = byId('build-stamp')?.textContent ?? null;
report.loadingHidden = byId('loading-overlay')?.hidden ?? null;
report.webglWarningShown = byId('webgl-warning')?.hidden === false;
report.onboardingVisible = byId('onboarding')?.hidden === false;
report.menuVisible = byId('menu-shell')?.hidden === false;
report.connectionLabel = byId('connection-label')?.textContent ?? null;
report.serverLine = byId('play-server-line')?.textContent ?? null;

// Finish onboarding the way a player would.
byId('player-name').value = 'BootTester';
byId('player-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
click('callsign-continue-button');
await wait(20);
report.loadoutStepVisible = byId('onboarding-loadout')?.hidden === false;
click('bundle-continue-button');
await wait(40);
report.onboardingAfterContinue = byId('onboarding')?.hidden === true;
report.loadoutLine = byId('play-loadout-line')?.textContent ?? null;

if (!serverUrl) {
  // Deploying while the socket is down must explain itself, not fail silently.
  click('play-now-button');
  await wait(50);
  report.playError = byId('play-error')?.hidden === false ? byId('play-error').textContent : null;
}

// A settings change has to reach the store and localStorage.
const sensitivity = byId('setting-sensitivity');
sensitivity.value = '2';
sensitivity.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await wait(20);
report.storedSensitivity = JSON.parse(localStorage.getItem('fps-gods-settings') ?? '{}').sensitivity ?? null;

// Navigation and keyboard shortcuts must not throw with no match running.
nav('rooms');
click('refresh-rooms-button');
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
await wait(120);
report.roomsScreenVisible = byId('screen-rooms')?.hidden === false;
report.roomListText = (byId('room-list')?.textContent ?? '').trim().slice(0, 160);

if (serverUrl) {
  nav('play');
  await wait(60);
  const before = performance.now();
  click('play-now-button');
  await wait(2_200);

  report.match = {
    hudVisible: byId('match-hud')?.hidden === false,
    menuHidden: byId('menu-shell')?.hidden === true,
    roomCode: byId('hud-room-code')?.textContent ?? null,
    health: byId('health-value')?.textContent ?? null,
    healthBarWidth: byId('health-fill')?.style.width ?? null,
    ammo: byId('ammo-value')?.textContent ?? null,
    weapon: byId('weapon-name')?.textContent ?? null,
    aliveCount: byId('alive-count')?.textContent ?? null,
    fps: byId('fps-value')?.textContent ?? null,
    targetKills: byId('target-kills')?.textContent ?? null,
    pauseHidden: byId('pause-panel')?.hidden === true,
    deathVisible: byId('death-panel')?.hidden === false,
    respawnCountdown: byId('respawn-countdown')?.textContent ?? null,
    elapsed: Math.round(performance.now() - before),
  };

  // Tab toggles the authoritative scoreboard (ui.js owns the shortcut).
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
  await wait(80);
  const rows = [...document.querySelectorAll('#scoreboard-body .scoreboard-row')];
  report.match.scoreboardVisible = byId('scoreboard-panel')?.hidden === false;
  report.match.scoreboardRows = rows.length;
  report.match.scoreboardNames = rows.map((row) => row.querySelector('.scoreboard-player-name')?.textContent ?? '');
  report.match.scoreboardHasBot = rows.some((row) => row.querySelector('.scoreboard-bot-tag'));
  report.match.scoreboardTarget = byId('scoreboard-room')?.textContent ?? null;
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
  await wait(40);
  report.match.scoreboardClosed = byId('scoreboard-panel')?.hidden === true;

  // The server's own tick has to keep the HUD alive after the first snapshot.
  await wait(600);
  report.match.aliveCountAfter = byId('alive-count')?.textContent ?? null;
}

dom.window.close();
console.log(`BOOT_RESULT ${JSON.stringify(report)}`);
process.exit(0);
