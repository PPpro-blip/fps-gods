import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { DEFAULT_MAP_ID, MAP_IDS, MAP_LIST, getMap } from '../shared/maps.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repoRoot, 'client/index.html'), 'utf8');
const css = readFileSync(resolve(repoRoot, 'client/style.css'), 'utf8');
const uiSource = readFileSync(resolve(repoRoot, 'client/ui.js'), 'utf8');

// These are DOM/structure regressions, not rendering evidence: jsdom has no
// layout engine, so nothing here can prove the HUD looks right. What it can
// prove is that the room code is its own field inside the match HUD (not inline
// with the FPS GODS branding), that the copy control fires exactly once, and
// that every class the map/lobby markup relies on actually exists in style.css.
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

async function createUi() {
  const dom = bootDom();
  globalThis.localStorage.clear();
  const { GameUI } = await import('../client/ui.js');
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  const ui = new GameUI({ profileId: 'profile-hud', onChange: (patch) => ({ ...ui.settings, ...patch }) });
  ui.setHandlers({
    onPlayNow: record('onPlayNow'),
    onCreate: record('onCreate'),
    onSelectMap: record('onSelectMap'),
    onJoin: record('onJoin'),
    onReady: record('onReady'),
    onStart: record('onStart'),
    onLeaveRoom: record('onLeaveRoom'),
    onUiSound: record('onUiSound'),
  });
  const clipboard = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text) => { clipboard.push(text); } },
    configurable: true,
  });
  return { ui, dom, calls, clipboard };
}

const $ = (id) => document.getElementById(id);

test('the room code lives in its own match-HUD field, not in the branding bar', () => {
  bootDom();
  const room = $('hud-room');
  assert.ok(room, 'the HUD has a dedicated room element');
  assert.ok($('hud-room-code'), 'the code itself is a separate field');
  assert.equal(room.querySelector('#hud-room-code')?.id, 'hud-room-code');
  assert.equal($('hud-room-code').textContent.trim(), '------', 'placeholder is not a fake code');
  assert.ok($('hud-room-copy'), 'the copy control still exists');
  assert.equal($('hud-room-copy').tagName, 'BUTTON');

  // The branding must be a different subtree, so no absolute positioning can
  // ever put the code on top of it.
  const brand = $('brand-home');
  assert.ok(brand);
  assert.equal(brand.contains(room), false, 'the room badge is not inside the brand');
  assert.equal(room.contains(brand), false);

  // The HUD top bar is a separate layer from the branding bar.
  const hudTop = document.querySelector('.match-hud .hud-top');
  assert.ok(hudTop, 'the match HUD owns a .hud-top row');
  assert.equal(hudTop.contains(room), true, 'the room badge sits in the HUD top row');
  assert.equal(hudTop.contains(brand), false);
});

test('the room badge is presented in the lobby, the HUD, and the scoreboard', async () => {
  const { ui } = await createUi();
  ui.showLobby({
    code: 'ABC234',
    state: 'LOBBY',
    mode: 'MULTIPLAYER',
    mapId: MAP_IDS.SKYBRIDGE,
    hostId: 'me',
    players: [{ id: 'me', name: 'Me', ready: false, connected: true }],
  }, 'me');
  ui.showMatch({ code: 'ABC234', mode: 'MULTIPLAYER', mapId: MAP_IDS.SKYBRIDGE, targetKills: 30 });
  assert.equal($('hud-room-code').textContent, 'ABC234');
  assert.equal($('hud-arena-name').textContent, getMap(MAP_IDS.SKYBRIDGE).name);
  assert.equal($('lobby-map-name').textContent, getMap(MAP_IDS.SKYBRIDGE).name);
  assert.equal($('scoreboard-room').textContent, 'ABC234');
});

test('clicking the room copy control copies exactly once, even after re-renders', async () => {
  const { ui, dom, clipboard } = await createUi();
  const room = {
    code: 'XYZ789',
    state: 'LOBBY',
    mode: 'MULTIPLAYER',
    mapId: DEFAULT_MAP_ID,
    hostId: 'me',
    players: [{ id: 'me', name: 'Me', ready: false, connected: true }],
  };
  // Re-render repeatedly: a listener bound per render would now fire many times.
  for (let pass = 0; pass < 3; pass += 1) ui.showLobby(room, 'me');
  ui.renderMapPicker($('map-grid'), { selected: MAP_IDS.SKYBRIDGE });
  ui.syncMapSelection();

  $('hud-room-copy').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((done) => setTimeout(done, 0));

  assert.equal(clipboard.length, 1, 'one click writes the clipboard once');
  assert.match(clipboard[0], /XYZ789$/, 'the copied link carries the room code');
});

test('the map picker renders one selectable card per registered arena', async () => {
  const { ui, dom, calls } = await createUi();
  const grid = $('map-grid');
  ui.renderMapPicker(grid, { selected: DEFAULT_MAP_ID });

  const cards = [...grid.querySelectorAll('.map-card')];
  assert.equal(cards.length, MAP_LIST.length);
  assert.deepEqual(cards.map((card) => card.dataset.map), MAP_LIST.map((map) => map.id));
  assert.equal(grid.querySelector('.map-card.is-selected').dataset.map, DEFAULT_MAP_ID);
  assert.equal(grid.querySelectorAll('[role="radio"]').length, MAP_LIST.length);

  const target = grid.querySelector(`.map-card[data-map="${MAP_IDS.DUSTLINE}"]`);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(calls.filter((call) => call.name === 'onSelectMap').length, 1);
  assert.equal(calls.find((call) => call.name === 'onSelectMap').args[0], MAP_IDS.DUSTLINE);
  assert.equal(grid.querySelector('.map-card.is-selected').dataset.map, MAP_IDS.DUSTLINE);
  assert.equal(grid.querySelector(`.map-card[data-map="${MAP_IDS.DUSTLINE}"]`).getAttribute('aria-checked'), 'true');
});

test('a locked picker cannot move the arena away from the server choice', async () => {
  const { ui, dom, calls } = await createUi();
  const grid = $('lobby-map-grid');
  ui.renderMapPicker(grid, { selected: MAP_IDS.FOUNDRY, locked: true, compact: true });

  const cards = [...grid.querySelectorAll('.map-card')];
  assert.equal(cards.length, MAP_LIST.length);
  for (const card of cards) {
    assert.equal(card.disabled, true, 'joiners cannot pick a different arena');
    assert.equal(card.classList.contains('is-compact'), true);
    card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  }
  assert.equal(calls.some((call) => call.name === 'onSelectMap'), false);
});

test('the lobby arena block reflects the authoritative map and who chose it', async () => {
  const { ui } = await createUi();
  const room = {
    code: 'ABC234',
    state: 'LOBBY',
    mode: 'MULTIPLAYER',
    mapId: MAP_IDS.DUSTLINE,
    hostId: 'host',
    players: [
      { id: 'host', name: 'Host', ready: true, connected: true },
      { id: 'me', name: 'Me', ready: false, connected: true },
    ],
  };
  ui.showLobby(room, 'me');
  assert.equal($('lobby-map-name').textContent, getMap(MAP_IDS.DUSTLINE).name);
  assert.equal($('lobby-map-note').hidden === true ? 'hidden' : 'shown', 'shown');
  assert.equal($('lobby-map-note').textContent.trim().length > 0, true);
  // The joiner sees a locked list; the host sees selectable cards.
  const guestCards = [...$('lobby-map-grid').querySelectorAll('.map-card')];
  assert.equal(guestCards.every((card) => card.disabled), true, 'a guest cannot pick');

  ui.showLobby(room, 'host');
  const hostCards = [...$('lobby-map-grid').querySelectorAll('.map-card')];
  assert.equal(hostCards.some((card) => !card.disabled), true, 'the host can pick');
});

test('every map/lobby/HUD class used by the page and the UI has styles', () => {
  const required = [
    'map-picker', 'map-grid', 'map-card', 'map-picker-note',
    'is-selected', 'is-compact',
    'lobby-arena', 'lobby-arena-head', 'lobby-arena-note',
    'hud-top', 'hud-room', 'hud-room-label', 'hud-room-code', 'hud-room-copy', 'hud-arena',
  ];
  for (const name of required) {
    assert.ok(css.includes(`.${name}`), `.${name} must be defined in client/style.css`);
  }
  // And the markup that depends on them is actually present.
  for (const name of ['map-picker', 'map-grid', 'hud-room', 'lobby-arena', 'lobby-arena-head', 'lobby-arena-note']) {
    assert.ok(html.includes(name), `index.html must use ${name}`);
  }
  assert.ok(uiSource.includes('map-card'), 'ui.js renders the styled card class');
});

test('the map picker is wired to the solo and create-room actions', () => {
  assert.match(uiSource, /onPlayNow\?\.\([^)]*this\.selectedMapId\)/);
  assert.match(uiSource, /onCreate\?\.\([^)]*this\.selectedMapId\)/);
});

test('every element the UI reads through el[...] is registered at boot', () => {
  const listStart = uiSource.indexOf('for (const id of [');
  const listEnd = uiSource.indexOf(']) {', listStart);
  assert.ok(listStart > 0 && listEnd > listStart, 'the id registration list is present');
  const registered = new Set(
    [...uiSource.slice(listStart, listEnd).matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]),
  );

  const referenced = new Set(
    [...uiSource.matchAll(/this\.el\['([a-z0-9-]+)'\]/g)].map((match) => match[1]),
  );
  assert.ok(referenced.size > 40, 'the UI reads a lot of elements through el[...]');

  // A referenced id that is not registered resolves to undefined and every
  // renderer that touches it silently does nothing. That is exactly how the map
  // picker shipped empty, so it is now a failing test.
  const unregistered = [...referenced].filter((id) => !registered.has(id) && !document.querySelector(`#${id}`));
  assert.deepEqual(unregistered, [], `not registered: ${unregistered.join(', ')}`);
});

test('the topbar and the HUD top row are offset by the same variable', () => {
  const topbar = css.slice(css.indexOf('.topbar {'), css.indexOf('.topbar {') + 700);
  assert.match(topbar, /height:\s*var\(--topbar-height\)/, '.topbar must use the shared height variable');
  assert.match(css, /\.hud-top\s*\{[^}]*top:\s*calc\(var\(--topbar-height\)/, '.hud-top must sit below the topbar');
  // Any breakpoint that shortens the topbar only has to change one variable.
  const overrides = [...css.matchAll(/--topbar-height:\s*(\d+)px/g)].map((match) => Number(match[1]));
  assert.ok(overrides.length >= 2, 'the responsive topbar height is declared');
  assert.equal(overrides[0], 72, 'the desktop topbar is 72 px, matching .topbar');
  assert.ok(overrides.every((height) => height % 2 === 0 && height >= 56 && height <= 96));
});
