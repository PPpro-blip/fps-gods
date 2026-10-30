import test from 'node:test';
import assert from 'node:assert/strict';
import { GameDatabase } from '../server/database.js';
import { AuthService } from '../server/auth.js';
import { EconomyService } from '../server/economy.js';

test('account callsigns are allocated uniquely and changes debit atomically with cooldown', async () => {
  const db = new GameDatabase({ dbPath: ':memory:' });
  const outbox = [];
  const auth = new AuthService(db, { name: 'test', configured: true, async sendOtpEmail(m) { outbox.push(m); } }, { callsignFee: 75, callsignCooldownMs: 60000 });
  const economy = new EconomyService(db);
  async function create(email, callsign, now) {
    await auth.requestOtp({ email, ip: email, now });
    return auth.verifyOtp({ email, code: outbox.at(-1).code, callsign, ip: email, now: now + 1 }).account;
  }
  try {
    const a = await create('a@example.com', 'Pilot', 100000);
    const b = await create('b@example.com', 'PILOT', 100000);
    assert.notEqual(a.callsign.toLowerCase(), b.callsign.toLowerCase());
    assert.equal(auth.getStatus().callsignChangeFee, 75);
    assert.throws(() => auth.updateAccountProfile(a.accountId, { callsign: 'NewPilot' }, 200000), e => e.code === 'INSUFFICIENT_FUNDS');
    assert.equal(auth.getAccountById(a.accountId).callsign, 'Pilot');
    economy.awardCredits({ accountId: a.accountId, idempotencyKey: 'initial-funds', amount: 200, reason: 'test' });
    assert.throws(() => auth.updateAccountProfile(a.accountId, { callsign: b.callsign.toLowerCase() }, 200001), e => e.code === 'CALLSIGN_TAKEN');
    assert.equal(economy.getWallet(a.accountId).balance, 200);
    assert.equal(auth.updateAccountProfile(a.accountId, { callsign: 'NewPilot' }, 200002).callsign, 'NewPilot');
    const wallet = economy.getWallet(a.accountId);
    assert.equal(wallet.balance, 125);
    assert.equal(wallet.lifetimeEarned, 200);
    assert.equal(wallet.recentTransactions[0].amount, -75);
    assert.equal(wallet.recentTransactions[0].reason, 'callsign_change');
    assert.throws(() => auth.updateAccountProfile(a.accountId, { callsign: 'Another' }, 200003), e => e.code === 'CALLSIGN_COOLDOWN');
    assert.equal(economy.getWallet(a.accountId).balance, 125);
    assert.equal(auth.updateAccountProfile(a.accountId, { callsign: 'Another' }, 260002).callsign, 'Another');
    assert.equal(economy.getWallet(a.accountId).balance, 50);
  } finally { db.close(); }
});

test('legacy duplicate names are preserved and do not block database startup', () => {
  const db = new GameDatabase({ dbPath: ':memory:' });
  try {
    const insert = db.db.prepare(`INSERT INTO accounts (id, email_normalized, callsign, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`);
    insert.run('acct_a', 'a@example.com', 'Legacy');
    insert.run('acct_b', 'b@example.com', 'LEGACY');
    const auth = new AuthService(db, { name: 'test', configured: true, async sendOtpEmail() {} });
    assert.equal(auth.getAccountById('acct_a').callsign, 'Legacy');
    assert.equal(auth.getAccountById('acct_b').callsign, 'LEGACY');
    assert.notEqual(auth.availableInitialCallsign('legacy').toLowerCase(), 'legacy');
  } finally { db.close(); }
});

test('profile API requires a verified cookie and reports fee failures without changing balance', async () => {
  const { createGameServer } = await import('../server/index.js');
  const outbox = [];
  const server = createGameServer({ dbPath: ':memory:', emailProvider: { name: 'test', configured: true, async sendOtpEmail(p) { outbox.push(p); } }, authOptions: { callsignFee: 50 } });
  await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/auth/profile', { callsign: 'Spoof' })).status, 401);
    await post('/api/auth/otp/request', { email: 'profile@example.com' });
    const verification = await post('/api/auth/otp/verify', { email: 'profile@example.com', code: outbox[0].code, callsign: 'Original' });
    const cookie = verification.headers.get('set-cookie').split(';')[0];
    const account = (await verification.json()).account;
    let response = await post('/api/auth/profile', { callsign: 'NewName' }, cookie);
    assert.equal(response.status, 402);
    assert.equal((await response.json()).code, 'INSUFFICIENT_FUNDS');
    server.economyService.awardCredits({ accountId: account.accountId, idempotencyKey: 'profile-funds', amount: 80, reason: 'test' });
    response = await post('/api/auth/profile', { callsign: 'NewName' }, cookie);
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.account.callsign, 'NewName');
    assert.equal(updated.wallet.balance, 30);
    assert.equal(updated.wallet.recentTransactions[0].amount, -50);
    assert.equal((await (await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).account.callsign, 'NewName');
  } finally { await server.close(); }
});
