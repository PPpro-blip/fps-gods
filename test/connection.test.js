import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameNetwork, resolveSocketTarget } from '../client/network.js';

// Vercel serves the static client and a persistent Node host runs Socket.IO, so
// the URL the browser dials is decided by VITE_SOCKET_URL at build time. Most of
// these cases exist because an operator pastes that value out of a host dashboard.

const HTTPS_PAGE = 'https://fps-gods.vercel.app';

test('an unset VITE_SOCKET_URL falls back to the page origin', () => {
  for (const blank of [undefined, null, '', '   ']) {
    assert.deepEqual(resolveSocketTarget(blank, HTTPS_PAGE), { url: HTTPS_PAGE, source: 'same-origin' });
  }
});

test('a configured URL is used verbatim and a trailing slash is dropped', () => {
  const target = 'https://fps-gods.up.railway.app';
  assert.equal(resolveSocketTarget(target, HTTPS_PAGE).url, target);
  // A trailing slash would request `//socket.io/` and many hosts answer 404.
  assert.equal(resolveSocketTarget(`${target}///`, HTTPS_PAGE).url, target);
  assert.equal(resolveSocketTarget(`  ${target}/  `, HTTPS_PAGE).url, target);
});

test('a ws/wss scheme is normalized to the http form', () => {
  assert.equal(resolveSocketTarget('wss://arena.example', HTTPS_PAGE).url, 'https://arena.example');
  assert.equal(resolveSocketTarget('ws://arena.example', 'http://localhost:5173').url, 'http://arena.example');
});

test('a base path is preserved so a reverse-proxied server still works', () => {
  assert.equal(
    resolveSocketTarget('https://example.com/game/', HTTPS_PAGE).url,
    'https://example.com/game',
  );
  // Pasting the full engine.io endpoint is common; Socket.IO re-appends its own
  // /socket.io path, so leaving it in asks for /socket.io/socket.io.
  assert.equal(
    resolveSocketTarget('https://example.com/game/socket.io', HTTPS_PAGE).url,
    'https://example.com/game',
  );
  assert.equal(
    resolveSocketTarget('https://example.com/socket.io', HTTPS_PAGE).url,
    'https://example.com',
  );
  // A bare host with no scheme is a guessable paste, not garbage.
  assert.equal(resolveSocketTarget('arena.example', HTTPS_PAGE).url, 'https://arena.example');
  assert.equal(resolveSocketTarget('localhost:3000', 'http://localhost:5173').url, 'https://localhost:3000');
});

test('http is upgraded on an https page, which a browser would block outright', () => {
  // Mixed content fails the handshake exactly like a dead server, so silently
  // rewriting the obvious paste-mistake is the only thing that distinguishes them.
  const result = resolveSocketTarget('http://fps-gods.up.railway.app', HTTPS_PAGE);
  assert.equal(result.url, 'https://fps-gods.up.railway.app');
  assert.equal(result.source, 'override-upgraded');
  // Over plain http the insecure URL stays insecure.
  assert.equal(
    resolveSocketTarget('http://localhost:3000', 'http://localhost:5173').url,
    'http://localhost:3000',
  );
});

test('an unparseable or non-HTTP override degrades to same-origin instead of dying', () => {
  for (const junk of ['not a url', 'ftp://arena.example', 'mailto:x@y.z']) {
    const result = resolveSocketTarget(junk, HTTPS_PAGE);
    assert.equal(result.url, HTTPS_PAGE);
    assert.equal(result.source, junk === 'ftp://arena.example' ? 'invalid-override' : result.source);
    assert.ok(['same-origin', 'invalid-override'].includes(result.source));
  }
});

// The badge text a player sees is the whole product here, so the classifier is
// pinned directly against the two outcomes it must not confuse.
function networkLike(target) {
  const fake = Object.create(GameNetwork.prototype);
  fake.target = target;
  return fake;
}

test('a host that answers nothing is reported as an offline server', () => {
  const net = networkLike({ url: 'https://arena.example', source: 'override' });
  for (const probe of [
    { kind: 'server-unreachable', reason: 'network' },
    { kind: 'server-unreachable', reason: 'timeout' },
    { kind: 'unavailable' },
  ]) {
    const detail = net.classifyProbe(probe);
    assert.equal(detail.badge, 'unreachable');
    assert.ok(detail.message.length > 10);
  }
});

test('a host that answers but is not the arena is a client config fault', () => {
  const net = networkLike({ url: 'https://fps-gods.vercel.app', source: 'same-origin' });
  const detail = net.classifyProbe({ kind: 'not-game-server', status: 404 });
  // Waiting does not fix this, so it must not read like an outage.
  assert.equal(detail.badge, 'offline');
  assert.match(detail.message, /VITE_SOCKET_URL/);
  assert.match(detail.message, /build time/);

  const aimed = networkLike({ url: 'https://wrong.example', source: 'override' });
  const aimedDetail = aimed.classifyProbe({ kind: 'not-game-server', status: 404 });
  assert.equal(aimedDetail.badge, 'offline');
  assert.match(aimedDetail.message, /wrong\.example/);
});

test('a live server whose handshake is blocked is flagged as a proxy problem', () => {
  const net = networkLike({ url: 'https://arena.example', source: 'override' });
  const detail = net.classifyProbe({ kind: 'server-alive', status: 200, uptime: 12, rooms: 0, connections: 0 });
  assert.equal(detail.badge, 'offline');
  assert.match(detail.message, /socket\.io/i);
});

test('a refused connection before the grace window still classifies safely', () => {
  // This is the raw engine.io error the websocket transport gives for a down host.
  const refused = Object.assign(new Error('websocket error'), { description: {} });
  const down = networkLike({ url: 'https://arena.example', source: 'override' });
  assert.equal(down.classifyTransportError(refused).badge, 'unreachable');

  const sameOrigin = networkLike({ url: 'https://fps-gods.vercel.app', source: 'same-origin' });
  const ours = sameOrigin.classifyTransportError(refused);
  assert.equal(ours.badge, 'offline');
  assert.match(ours.message, /VITE_SOCKET_URL/);

  // The polling transport is the only one that reports an HTTP status at all.
  const badStatus = Object.assign(new Error('xhr poll error'), { description: 404 });
  assert.equal(down.classifyTransportError(badStatus).status, 404);
  const noAnswer = Object.assign(new Error('xhr poll error'), { description: 0 });
  assert.equal(down.classifyTransportError(noAnswer).badge, 'unreachable');
});

test('repeated identical failures are reported once', () => {
  const net = networkLike({ url: 'https://arena.example', source: 'override' });
  const seen = [];
  net.lastIssueSignature = null;
  net.handlers = { onConnectionError: (detail) => seen.push(detail.message) };
  const detail = { badge: 'unreachable', message: 'The arena server is offline.' };
  assert.equal(net.emitIssue(detail), true);
  assert.equal(net.emitIssue(detail), false);
  assert.equal(net.emitIssue(detail), false);
  // A changed verdict (probe refined it, or the host came back and died again) is.
  assert.equal(net.emitIssue({ badge: 'offline', message: 'Wrong host.' }), true);
  assert.equal(seen.length, 2);
});
