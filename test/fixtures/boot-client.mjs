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
const report = { errors: [], unhandled: [], windowErrors: [] };
const checkInput = process.argv.includes('--check-input');
const checkQuit = process.argv.includes('--check-quit');

process.on('uncaughtException', (error) => report.unhandled.push(String(error?.message ?? error)));
process.on('unhandledRejection', (error) => report.unhandled.push(String(error?.message ?? error)));

// With an explicit origin the fixture joins a live game server; without one it
// boots against a refused local port, which gives a deterministic offline path
// without depending on external DNS or outbound access.
const dom = new JSDOM(readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8'), {
  url: serverUrl ? new URL('/', serverUrl).href : 'http://127.0.0.1:1/?room=ABC234',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
dom.window.addEventListener('error', (event) => report.windowErrors.push(String(event.error?.message ?? event.message)));
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
// Asset failures must be visible in the UI, not just the console.
report.assetWarning = {
  hidden: byId('asset-warning')?.hidden ?? null,
  title: byId('asset-warning-title')?.textContent ?? null,
  note: byId('asset-warning-note')?.textContent ?? null,
  items: [...(byId('asset-warning-list')?.children ?? [])].map((item) => item.textContent),
};
report.assetDiagnostics = globalThis.window?.__FPS_GODS_ASSETS__ ?? null;
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

  if (checkInput) {
    // jsdom has no pointer lock implementation; drive the real entry-point
    // handlers with an explicit lock and a live server instead of mocking fire.
    const canvas = byId('game-canvas');
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    // Stop scheduling frames; the input pump must continue without rendering.
    globalThis.requestAnimationFrame = () => 0;
    await wait(50);
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    await wait(120);
    document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    await wait(80);
    const ammoBefore = Number(byId('ammo-value').textContent);
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true }));
    document.dispatchEvent(new dom.window.MouseEvent('mouseup', { button: 0, bubbles: true }));
    await wait(500);
    const ammoAfter = Number(byId('ammo-value').textContent);
    // Losing focus while moving and holding an automatic trigger must send a
    // neutral state and stop repetition, even when no render frames run.
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true }));
    await wait(220);
    window.dispatchEvent(new dom.window.Event('blur'));
    await wait(250);
    const ammoAfterBlur = Number(byId('ammo-value').textContent);
    await wait(250);
    const ammoWhileBlurred = Number(byId('ammo-value').textContent);
    window.dispatchEvent(new dom.window.Event('focus'));
    await wait(250);
    const ammoAfterFocus = Number(byId('ammo-value').textContent);
    report.match.action = { ammoBefore, ammoAfter, ammoAfterBlur, ammoWhileBlurred, ammoAfterFocus };
  }

  if (checkQuit) {
    const canvas = byId('game-canvas');
    let locked = canvas;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => locked });
    document.exitPointerLock = () => { locked = null; document.dispatchEvent(new dom.window.Event('pointerlockchange')); };
    canvas.requestPointerLock = () => { locked = canvas; document.dispatchEvent(new dom.window.Event('pointerlockchange')); return Promise.resolve(); };
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await wait(50);
    const opened = !byId('pause-panel').hidden && locked === null;
    click('resume-button');
    await wait(50);
    const resumed = byId('pause-panel').hidden && locked === canvas;
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await wait(50);
    click('quit-match-button');
    const confirmation = !byId('quit-match-note').hidden && !byId('match-hud').hidden;
    click('quit-match-button');
    click('quit-match-button');
    await wait(350);
    const returned = byId('match-hud').hidden && !byId('menu-shell').hidden;
    const oldCode = report.match.roomCode;
    click('play-now-button');
    await wait(800);
    const newCode = byId('hud-room-code').textContent;
    report.quit = { opened, resumed, confirmation, returned, oldCode, newCode, reentered: !byId('match-hud').hidden && newCode !== oldCode };
  }

  // The server's own tick has to keep the HUD alive after the first snapshot.
  await wait(600);
  report.match.aliveCountAfter = byId('alive-count')?.textContent ?? null;
}

dom.window.close();
console.log(`BOOT_RESULT ${JSON.stringify(report)}`);
process.exit(0);
