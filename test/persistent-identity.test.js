import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../server/index.js';
import { restoreAuthSession } from '../client/authSession.js';
import { GameNetwork } from '../client/network.js';

const origin = 'https://fps-gods.vercel.app';
test('cookie session survives restart, is authoritative, expires and revokes; repeat login preserves identity and progression', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fps-session-'));
  const dbPath = join(dir, 'db.sqlite');
  const outbox = [];
  const emailProvider = { configured: true, name: 'test', async sendOtpEmail(p) { outbox.push(p); } };
  let server;
  let base;
  async function start() {
    server = createGameServer({ dbPath, emailProvider, authOptions: { otpCooldownMs: 1 } });
    await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  async function request(path, { method = 'GET', body, cookie, reqOrigin = origin } = {}) {
    return fetch(base + path, { method, headers: { Origin: reqOrigin, 'X-Forwarded-Proto': 'https', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function login(email) {
    assert.equal((await request('/api/auth/otp/request', { method: 'POST', body: { email } })).status, 200);
    const response = await request('/api/auth/otp/verify', { method: 'POST', body: { email, code: outbox.at(-1).code, callsign: 'Pilot' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    const header = response.headers.get('set-cookie');
    for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=None/i, /Path=\//i, /Max-Age=2592000/i]) assert.match(header, attribute);
    assert.doesNotMatch(header, /Domain=/i);
    const body = await response.json();
    assert.equal(body.sessionToken, undefined);
    return { cookie: header.split(';')[0], account: body.account };
  }
  try {
    await start();
    const preflight = await request('/api/auth/otp/verify', { method: 'OPTIONS' });
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    const evil = await request('/api/auth/logout', { method: 'POST', reqOrigin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const first = await login('PILOT@example.com');
    const id = first.account.accountId;
    server.authService.recordAccountKill(id, 7);
    server.economyService.awardCredits({ accountId: id, idempotencyKey: 'test-credit', amount: 42, reason: 'test' });
    await server.close();
    await start();
    const me = await (await request('/api/auth/me', { cookie: first.cookie })).json();
    assert.equal(me.authenticated, true);
    assert.equal(me.account.accountId, id);
    assert.equal(me.account.lifetimeKills, 7);
    assert.equal(me.wallet.balance, 42);
    assert.equal((await (await request('/api/auth/me', { cookie: 'fps_gods_session=invalid-invalid-invalid-invalid' })).json()).authenticated, false);
    assert.equal((await request('/api/wallet')).status, 401);
    assert.equal((await (await request('/api/auth/me')).json()).authenticated, false);
    const logout = await request('/api/auth/logout', { method: 'POST', cookie: first.cookie });
    assert.match(logout.headers.get('set-cookie'), /SameSite=None/);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await (await request('/api/auth/me', { cookie: first.cookie })).json()).authenticated, false);
    const second = await login('pilot@example.com');
    assert.equal(second.account.accountId, id);
    const again = await (await request('/api/auth/me', { cookie: second.cookie })).json();
    assert.equal(again.wallet.balance, 42);
    assert.equal(again.account.lifetimeKills, 7);
    server.database.db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE account_id = ? AND revoked_at IS NULL').run(Date.now() - 1, id);
    assert.equal((await (await request('/api/auth/me', { cookie: second.cookie })).json()).authenticated, false);
  } finally {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup restores only a server-validated session and exposes pending state', async () => {
  let resolve;
  const calls = [];
  const ui = { playerName: 'guest', setAuthRestoring: v => calls.push(['loading', v]), setAuthStatus: v => calls.push(['status', v]), setProfile: v => calls.push(['profile', v]), setWallet: v => calls.push(['wallet', v]), resetToGuestProfile: v => calls.push(['guest', v]) };
  const net = { connected: true, apiRequest: path => { assert.equal(path, '/api/auth/me'); return new Promise(r => { resolve = r; }); }, requestProfile: (...args) => calls.push(['requestProfile', ...args]) };
  const restoring = restoreAuthSession(ui, net, 'guest-1');
  assert.deepEqual(calls, [['loading', true]]);
  resolve({ authenticated: true, account: { accountId: 'acct_1' }, wallet: { balance: 42 } });
  await restoring;
  assert.deepEqual(calls.map(c => c[0]), ['loading', 'profile', 'wallet', 'loading']);
  calls.length = 0;
  net.apiRequest = async () => ({ authenticated: false });
  await restoreAuthSession(ui, net, 'guest-1');
  assert.deepEqual(calls.map(c => c[0]), ['loading', 'guest', 'requestProfile', 'loading']);
  calls.length = 0;
  net.apiRequest = async () => { throw new Error('offline'); };
  await restoreAuthSession(ui, net, 'guest-1');
  assert.deepEqual(calls.map(c => c[0]), ['loading', 'guest', 'loading']);
});

test('auth API sends browser credentials even when the backend is cross-origin', async () => {
  const originalFetch = globalThis.fetch;
  let options;
  globalThis.fetch = async (_url, opts) => { options = opts; return { ok: true, status: 200, async text() { return '{}'; } }; };
  try {
    await GameNetwork.prototype.apiRequest.call({ target: { url: 'https://fps-gods-production.up.railway.app', source: 'configured' } }, '/api/auth/me');
    assert.equal(options.credentials, 'include');
  } finally { globalThis.fetch = originalFetch; }
});
