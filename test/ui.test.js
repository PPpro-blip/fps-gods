import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8');
const uiSource = readFileSync(resolve(repoRoot, 'client/ui.js'), 'utf8');

// The UI is a DOM controller, so it is exercised against the real
// client/index.html in jsdom. This catches the class of bug a bundle build
// cannot: a renamed id, an unbound control, or a button that silently does
// nothing. jsdom is a dev-only dependency; nothing here ships to the browser.
function bootDom() {
  const dom = new JSDOM(html, { url: 'https://arena.test/?room=ABC234', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator, configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage, configurable: true, writable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  return dom;
}

async function createUi(options = {}) {
  const dom = bootDom();
  globalThis.localStorage.clear();
  if (options.onboarded) {
    globalThis.localStorage.setItem('fps-gods-callsign', 'TestOperator');
    globalThis.localStorage.setItem('fps-gods-onboarded', '1');
  }
  const { GameUI } = await import('../client/ui.js');
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  const ui = new GameUI({
    profileId: 'profile-test',
    settings: options.settings,
    onChange: (patch) => ({ ...ui.settings, ...patch }),
  });
  ui.setHandlers({
    onCallsignContinue: record('onCallsignContinue'),
    onBundleSelected: record('onBundleSelected'),
    onBundleChange: record('onBundleChange'),
    onPlayNow: record('onPlayNow'),
    onCreate: record('onCreate'),
    onJoin: record('onJoin'),
    onListRooms: record('onListRooms'),
    onLeaveRoom: record('onLeaveRoom'),
    onReady: record('onReady'),
    onStart: record('onStart'),
    onProfileCallsign: record('onProfileCallsign'),
    onResume: record('onResume'),
    onPlayAgain: record('onPlayAgain'),
    onUiSound: record('onUiSound'),
  });
  return { ui, dom, calls };
}

const $ = (id) => document.getElementById(id);
const click = (id) => $(id).dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
const fire = (id, type = 'input') => $(id).dispatchEvent(new document.defaultView.Event(type, { bubbles: true }));

test('every element id the UI code asks for exists in index.html', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = new Set([...uiSource.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]));
  const listed = uiSource.slice(uiSource.indexOf('for (const id of ['), uiSource.indexOf(']) {', uiSource.indexOf('for (const id of [')));
  for (const match of listed.matchAll(/'([a-z0-9-]+)'/g)) referenced.add(match[1]);

  const missing = [...referenced].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `index.html is missing: ${missing.join(', ')}`);

  // No duplicate ids: a duplicate would make getElementById unpredictable.
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = all.filter((id, index) => all.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], 'duplicate element ids');
});

test('no button in the shell is decorative: each one has a bound listener', () => {
  const buttonIds = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(buttonIds.length > 10, 'the shell should have real controls');
  // A listener is registered by either `el['x']` or `getElementById('x')`.
  const unbound = buttonIds.filter((id) => !uiSource.includes(`'${id}'`));
  assert.deepEqual(unbound, [], `buttons with no listener: ${unbound.join(', ')}`);

  // Nav buttons must point at panels that exist.
  const navValues = [...html.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(navValues.length >= 6);
  for (const nav of navValues) {
    assert.ok(html.includes(`data-screen-panel="${nav}"`), `no panel for nav '${nav}'`);
  }
});

test('navigation, onboarding and the play screen drive real handlers', async () => {
  const { ui, dom, calls } = await createUi();
  try {
    // First run: the callsign gate is visible and refuses an empty answer.
    assert.equal($('onboarding').hidden, false);
    click('callsign-continue-button');
    assert.equal($('callsign-error').hidden, false);

    $('player-name').value = 'TestOperator';
    fire('player-name');
    click('callsign-continue-button');
    const continued = calls.filter((call) => call.name === 'onCallsignContinue');
    assert.equal(continued.length, 1);
    assert.equal(continued[0].args[0], 'TestOperator');
    assert.equal($('onboarding-identity').hidden, true);
    assert.equal($('onboarding-loadout').hidden, false);

    // Four real bundles, GODS TIER locked behind 30 lifetime eliminations.
    const cards = [...$('onboarding-bundles').querySelectorAll('.bundle-card')];
    assert.equal(cards.length, 4);
    const godsTier = cards.find((card) => card.dataset.bundleId === 'GODS_TIER');
    assert.equal(godsTier.disabled, true);
    assert.match(godsTier.textContent, /30 MORE LIFETIME ELIMS/);

    click('bundle-continue-button');
    assert.equal($('onboarding').hidden, true);
    assert.equal($('menu-shell').hidden, false);
    assert.equal(ui.selectedBundleId, 'RUSHER');
    assert.ok(calls.some((call) => call.name === 'onBundleSelected' && call.args[0] === 'RUSHER'));

    // Primary actions are wired.
    click('play-now-button');
    assert.equal(calls.filter((call) => call.name === 'onPlayNow').at(-1).args[1], 'RUSHER');
    click('create-room-button');
    assert.equal(calls.filter((call) => call.name === 'onCreate').at(-1).args[0], 'TestOperator');

    $('room-code-input').value = 'abc234';
    fire('room-code-input');
    assert.equal($('room-code-input').value, 'ABC234');
    $('join-room-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    assert.equal(calls.filter((call) => call.name === 'onJoin').at(-1).args[1], 'ABC234');

    // Every nav entry switches to an existing screen panel.
    const navButtons = [...$('nav-rail').querySelectorAll('[data-nav]')];
    assert.equal(navButtons.length, 6);
    for (const button of navButtons) {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      const screen = button.dataset.nav;
      assert.equal($(`screen-${screen}`).hidden, false, `${screen} screen did not open`);
      const visible = [...document.querySelectorAll('[data-screen-panel]')]
        .filter((panel) => !panel.hidden);
      assert.equal(visible.length, 1, `${screen} screen left ${visible.length} panels visible`);
    }
  } finally {
    ui.dispose();
    dom.window.close();
  }
});

test('the room browser renders authoritative data and cannot join a started match', async () => {
  const { ui, dom, calls } = await createUi({ onboarded: true });
  try {
    click('browse-rooms-button');
    assert.equal($('screen-rooms').hidden, false);
    assert.ok(calls.some((call) => call.name === 'onListRooms'), 'opening the browser asks the server');
    assert.ok($('room-list').querySelector('.room-skeleton'), 'a loading state is shown while waiting');

    ui.setRoomList({ rooms: [], now: Date.now() });
    assert.match($('room-list').textContent, /No open lobbies/);

    ui.setRoomList({
      now: Date.now(),
      rooms: [
        {
          code: 'ABC234', hostName: 'Vega', players: 2, maxPlayers: 16, targetKills: 30,
          state: 'LOBBY', mode: 'MULTIPLAYER', joinable: true, ageMs: 4_000,
        },
        {
          code: 'XYZ789', hostName: 'Nova', players: 4, maxPlayers: 16, targetKills: 30,
          state: 'PLAYING', mode: 'MULTIPLAYER', joinable: false, ageMs: 90_000,
        },
      ],
    });

    const rows = [...$('room-list').querySelectorAll('.room-row')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /ABC234/);
    assert.match(rows[0].textContent, /Vega/);
    assert.match(rows[0].textContent, /2\/16/);

    const joins = [...$('room-list').querySelectorAll('.room-join')];
    assert.equal(joins[1].disabled, true, 'a started match must not offer a join button');
    joins[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calls.filter((call) => call.name === 'onJoin').at(-1).args[1], 'ABC234');

    ui.setRoomListError('No answer from the game server.');
    assert.match($('room-list').textContent, /Room list unavailable/);
  } finally {
    ui.dispose();
    dom.window.close();
  }
});

test('loadout, profile, settings and the HUD all reflect server state', async () => {
  const { ui, dom, calls } = await createUi({ onboarded: true });
  try {
    ui.showScreen('inventory');
    const cards = [...$('bundle-grid').querySelectorAll('.bundle-card')];
    assert.equal(cards.length, 4);
    assert.match($('bundle-grid').textContent, /smg\.glb/, 'the loadout names the real asset');

    const heavy = cards.find((card) => card.dataset.bundleId === 'HEAVY');
    heavy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.selectedBundleId, 'HEAVY');
    assert.equal(localStorage.getItem('fps-gods-bundle'), 'HEAVY');
    assert.ok(calls.some((call) => call.name === 'onBundleChange' && call.args[0] === 'HEAVY'));
    assert.match($('play-loadout-line').textContent, /LMG/);

    // A locked bundle is refused with an explanation, not silence.
    assert.equal(ui.selectBundle('GODS_TIER'), false);
    assert.match($('toast').textContent, /30 lifetime eliminations/);

    // Server-verified progression drives the profile and the store meter.
    ui.setProfile({ profileId: 'profile-test', callsign: 'TestOperator', lifetimeKills: 15, godsTierUnlocked: false });
    assert.equal($('profile-stat-kills').textContent, '15');
    assert.equal($('profile-stat-unlock').textContent, 'LOCKED');
    assert.equal($('store-kills-value').textContent, '15 / 30');
    assert.equal($('store-kills-fill').style.width, '50%');

    ui.setProfile({ profileId: 'profile-test', callsign: 'TestOperator', lifetimeKills: 30, godsTierUnlocked: true });
    assert.equal($('profile-stat-unlock').textContent, 'UNLOCKED');
    assert.equal($('profile-progress-fill').style.width, '100%');
    const godsTier = [...$('bundle-grid').querySelectorAll('.bundle-card')]
      .find((card) => card.dataset.bundleId === 'GODS_TIER');
    assert.equal(godsTier.disabled, false, 'an unlocked bundle must become selectable');

    // Callsign rename goes through the network handler.
    ui.showScreen('profile');
    $('profile-callsign-input').value = 'Renamed';
    $('profile-callsign-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    assert.equal(calls.filter((call) => call.name === 'onProfileCallsign').at(-1).args[0], 'Renamed');

    // Settings reach the engine and are echoed back to the controls.
    ui.showScreen('settings');
    $('setting-sensitivity').value = '1.75';
    fire('setting-sensitivity');
    assert.equal(ui.settings.sensitivity, 1.75);
    assert.equal($('setting-sensitivity-value').textContent, '1.75×');
    $('setting-crosshair').value = 'dot';
    fire('setting-crosshair', 'change');
    assert.equal($('crosshair').dataset.crosshair, 'dot');
    $('setting-fps').checked = true;
    fire('setting-fps', 'change');
    ui.setFps(144.4);
    assert.match($('fps-value').textContent, /144 FPS/);

    // HUD: health, ammo, fire mode, alive count, then a downed operator.
    const room = {
      code: 'ABC234', state: 'PLAYING', mode: 'MULTIPLAYER', hostId: 'me',
      players: [{ id: 'me', name: 'Me', color: '#59d8ff', ready: true, kills: 3, deaths: 1, alive: true, connected: true, bundleId: 'RUSHER' }],
      minPlayers: 2, maxPlayers: 16, targetKills: 30,
    };
    ui.showMatch(room);
    assert.equal($('match-hud').hidden, false);
    assert.equal($('menu-shell').hidden, true);
    assert.equal($('hud-room-code').textContent, 'ABC234');

    const player = {
      id: 'me', alive: true, health: 74, maxHealth: 100, ammo: 18, reserveAmmo: 60,
      totalAmmo: 78, maxAmmo: 30, unlimitedAmmo: false, reloading: false, overheated: false,
      currentWeaponId: 'SMG', currentWeaponName: 'SMG', bundleId: 'RUSHER', auto: true,
      spawnProtected: false,
    };
    ui.updateHud(player, Date.now(), 4);
    assert.equal($('health-value').textContent, '74');
    assert.equal($('ammo-value').textContent, '18');
    assert.equal($('ammo-mode').textContent, 'AUTO');
    assert.equal($('alive-count').textContent, '4');

    ui.updateHud({ ...player, health: 20, ammo: 0, reloading: true }, Date.now(), 2);
    assert.equal($('health-state').textContent, 'CRITICAL');
    assert.equal($('ammo-status').textContent, 'RELOADING');

    const now = Date.now();
    ui.updateHud({ ...player, alive: false, health: 0, respawnAt: now + 1_500 }, now, 1);
    assert.equal($('death-panel').hidden, false);
    assert.match($('respawn-countdown').textContent, /^1\.[0-9]$/);

    // Hit markers, kill feed and the scoreboard.
    ui.showHitMarker({ hit: true, killed: true, headshot: true });
    assert.equal($('crosshair').classList.contains('is-kill'), true);
    ui.addKillFeed({ killerId: 'me', killerName: 'Me', victimId: 'bot', victimName: 'GOD_BOT_01', headshot: true }, 'me');
    assert.match($('kill-feed').textContent, /GOD_BOT_01/);

    ui.setScoreboard(true);
    ui.updateScoreboard([
      { id: 'bot', name: 'GOD_BOT_02', kills: 9, deaths: 2, alive: true, connected: true, isBot: true, color: '#ff657a' },
      { id: 'me', name: 'Me', kills: 3, deaths: 1, alive: false, connected: true, isBot: false, color: '#59d8ff' },
    ], 'me');
    const rows = [...$('scoreboard-body').querySelectorAll('.scoreboard-row')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /GOD_BOT_02/);
    assert.equal(rows[1].classList.contains('is-self'), true);
    assert.equal(rows[1].querySelector('.scoreboard-status').textContent, 'DOWN');

    ui.showGameEnd({
      winner: { id: 'me', name: 'Me', kills: 30 },
      scoreboard: [{ name: 'Me', kills: 30, deaths: 4, isBot: false }],
      mode: 'MULTIPLAYER',
    }, 'me');
    assert.equal($('end-panel').hidden, false);
    assert.equal($('winner-name').textContent, 'Me');
  } finally {
    ui.dispose();
    dom.window.close();
  }
});

test('the weapon wheel lists the equipped bundle and reports the picked slot', async () => {
  const { ui, dom } = await createUi({ onboarded: true });
  try {
    ui.openWeaponWheel('RUSHER', 'SMG');
    assert.equal($('weapon-wheel').hidden, false);
    const options = [...$('weapon-wheel-options').children];
    assert.deepEqual(options.map((option) => option.dataset.weaponId), ['SMG', 'SHOTGUN', 'KNIFE']);
    assert.equal(options[0].classList.contains('is-current'), true);

    ui.selectWeaponByDirection(0, 120);
    const selected = ui.closeWeaponWheel();
    assert.ok(['SHOTGUN', 'KNIFE'].includes(selected), `wheel selected ${selected}`);
    assert.equal($('weapon-wheel').hidden, true);
  } finally {
    ui.dispose();
    dom.window.close();
  }
});

test('room actions and connection state are visible to the player', async () => {
  const { ui, dom, calls } = await createUi({ onboarded: true });
  try {
    const room = {
      code: 'ABC234', state: 'LOBBY', mode: 'MULTIPLAYER', hostId: 'host', hostName: 'Vega',
      players: [
        { id: 'host', name: 'Vega', ready: true, kills: 0, deaths: 0, alive: true, connected: true, bundleId: 'RUSHER' },
        { id: 'me', name: 'Me', ready: false, kills: 0, deaths: 0, alive: true, connected: true, bundleId: 'HEAVY' },
      ],
      minPlayers: 2, maxPlayers: 16, targetKills: 30,
    };
    ui.updateRoom?.(room);
    ui.showLobby(room, 'me');
    assert.equal($('lobby-shell').hidden, false);
    assert.equal($('menu-shell').hidden, true);
    assert.equal($('lobby-room-code').textContent, 'ABC234');
    const roster = $('lobby-player-list').textContent;
    assert.match(roster, /Vega/);
    assert.match(roster, /Me/);

    assert.deepEqual(ui.missingElements, [], 'ui.js must only reference ids that exist in index.html');

    // A non-host never sees the start button.
    assert.equal($('start-button').hidden, true);
    click('ready-button');
    assert.equal(calls.filter((call) => call.name === 'onReady').at(-1).args[0], true);
    click('leave-room-button');
    assert.ok(calls.some((call) => call.name === 'onLeaveRoom'));

    // The host gets a start button, disabled until the room can start.
    ui.showLobby({ ...room, hostId: 'me' }, 'me');
    assert.equal($('start-button').hidden, false);

    ui.setConnectionState('offline', 'Connection interrupted. Reconnecting…');
    assert.equal($('connection-pill').classList.contains('is-offline'), true);
    assert.match($('connection-label').textContent, /CONNECTION LOST/);
    assert.match($('toast').textContent, /Reconnecting/);
    ui.setConnectionState('connected');
    assert.equal($('connection-pill').classList.contains('is-connected'), true);
    assert.match($('connection-label').textContent, /LIVE ARENA/);

    // Errors land on the visible surface (onboarding is already dismissed here,
    // so the onboarding error slots are not candidates).
    ui.showScreen('play');
    ui.showError('That room does not exist.');
    assert.equal($('play-error').hidden, false);
    assert.match($('play-error').textContent, /does not exist/);
    ui.showScreen('rooms');
    ui.showError('Room list is down.');
    assert.equal($('rooms-error').hidden, false);
    assert.equal($('play-error').hidden, true, 'errors must not linger on a hidden screen');
  } finally {
    ui.dispose();
    dom.window.close();
  }
});
