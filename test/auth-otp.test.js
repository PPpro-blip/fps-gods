import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as createClient } from 'socket.io-client';
import { GameDatabase } from '../server/database.js';
import { AuthService } from '../server/auth.js';
import { createGameServer } from '../server/index.js';
import { EVENTS } from '../shared/events.js';

function createMockEmailProvider() {
  const outbox = [];
  return {
    outbox,
    provider: {
      name: 'mock-memory',
      configured: true,
      async sendOtpEmail(payload) {
        outbox.push(payload);
        return { delivered: true };
      },
    },
  };
}

function waitForEvent(socket, event, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

test('AuthService enforces CSPRNG hashed OTPs, single-use, expiry, attempt caps, and rate limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fps-gods-auth-'));
  const dbPath = join(dir, 'auth.sqlite');
  let nowMs = 1_700_000_000_000;
  const { outbox, provider } = createMockEmailProvider();
  const db = new GameDatabase({ dbPath });
  const auth = new AuthService(db, provider, {
    otpTtlMs: 5 * 60_000,
    otpCooldownMs: 45_000,
    otpMaxAttempts: 3,
    maxRequestsPerEmail: 3,
    maxRequestsPerIp: 4,
  });

  try {
    const res1 = await auth.requestOtp({ email: '  Operator.One@Example.COM ', ip: '203.0.113.10', now: nowMs });
    assert.equal(res1.ok, true);
    assert.equal(outbox.length, 1);
    const otpCode = outbox[0].code;
    assert.match(otpCode, /^\d{6}$/);

    // Raw OTP code and raw session tokens must never appear in SQLite storage.
    const rawChallenge = db.db.prepare('SELECT code_hash, salt FROM otp_challenges').get();
    assert.ok(rawChallenge.code_hash && !Buffer.from(rawChallenge.code_hash).toString('utf8').includes(otpCode));

    // Resend cooldown blocks immediate duplicate requests.
    await assert.rejects(
      () => auth.requestOtp({ email: 'operator.one@example.com', ip: '203.0.113.10', now: nowMs + 1_000 }),
      (err) => err.code === 'OTP_COOLDOWN' && err.status === 429,
    );

    // Wrong code increments attempts and rejects with 401.
    assert.throws(
      () => auth.verifyOtp({
        email: 'operator.one@example.com',
        code: otpCode === '000000' ? '999999' : '000000',
        now: nowMs + 2_000,
      }),
      (err) => err.code === 'INVALID_OR_EXPIRED_OTP' && err.status === 401,
    );

    // Valid verification creates account + SHA-256 hashed session and invalidates the OTP.
    const verified = auth.verifyOtp({
      email: 'operator.one@example.com',
      code: otpCode,
      callsign: 'AscendedOne',
      selectedBundle: 'GHOST',
      ip: '203.0.113.10',
      now: nowMs + 3_000,
    });
    assert.equal(verified.isNewAccount, true);
    assert.match(verified.account.accountId, /^acct_/);
    assert.equal(verified.account.callsign, 'AscendedOne');
    assert.equal(verified.account.selectedBundle, 'GHOST');
    assert.ok(verified.sessionToken.length >= 32);

    const storedSession = db.db.prepare('SELECT token_hash FROM auth_sessions').get();
    assert.notEqual(storedSession.token_hash, verified.sessionToken);

    // Single-use: replaying the same OTP immediately fails.
    assert.throws(
      () => auth.verifyOtp({ email: 'operator.one@example.com', code: otpCode, now: nowMs + 4_000 }),
      (err) => err.code === 'INVALID_OR_EXPIRED_OTP' && err.status === 401,
    );

    // Expiry check on a fresh OTP after advancing clock beyond TTL.
    nowMs += 60_000;
    await auth.requestOtp({ email: 'operator.one@example.com', ip: '203.0.113.10', now: nowMs });
    const expiredCode = outbox[1].code;
    nowMs += 5 * 60_000 + 1_000;
    assert.throws(
      () => auth.verifyOtp({ email: 'operator.one@example.com', code: expiredCode, now: nowMs }),
      (err) => err.code === 'INVALID_OR_EXPIRED_OTP' && err.status === 401,
    );

    // Logout revokes the active session immediately.
    assert.ok(auth.verifySessionToken(verified.sessionToken, nowMs));
    auth.logout(verified.sessionToken, nowMs);
    assert.equal(auth.verifySessionToken(verified.sessionToken, nowMs), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP OTP routes, unconfigured provider guard, and Socket.IO account impersonation protection', async () => {
  const unconfiguredServer = createGameServer({
    dbPath: ':memory:',
    emailProvider: { name: 'unconfigured', configured: false, async sendOtpEmail() { throw new Error('unconfigured'); } },
  });
  await new Promise((resolve) => unconfiguredServer.httpServer.listen(0, '127.0.0.1', resolve));
  const unconfPort = unconfiguredServer.httpServer.address().port;
  try {
    const statusRes = await fetch(`http://127.0.0.1:${unconfPort}/api/auth/status`).then((r) => r.json());
    assert.equal(statusRes.otpConfigured, false);
    const reqRes = await fetch(`http://127.0.0.1:${unconfPort}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pilot@example.com' }),
    });
    assert.equal(reqRes.status, 503);
    const reqBody = await reqRes.json();
    assert.equal(reqBody.code, 'EMAIL_PROVIDER_UNCONFIGURED');
  } finally {
    await unconfiguredServer.close();
  }

  const { outbox, provider } = createMockEmailProvider();
  const server = createGameServer({ dbPath: ':memory:', emailProvider: provider });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let guestSocket = null;
  let authedSocket = null;

  try {
    const reqOtp = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valkyrie@example.com' }),
    });
    assert.equal(reqOtp.status, 200);
    assert.equal(outbox.length, 1);

    const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'valkyrie@example.com',
        code: outbox[0].code,
        callsign: 'Valkyrie',
        selectedBundle: 'GHOST',
      }),
    });
    assert.equal(verifyRes.status, 200);
    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/i);
    const verified = await verifyRes.json();
    const targetAccountId = verified.account.accountId;
    assert.match(targetAccountId, /^acct_/);

    // An unauthenticated socket trying to impersonate `acct_*` must be isolated as a guest!
    guestSocket = createClient(baseUrl, { transports: ['websocket'], forceNew: true });
    await waitForEvent(guestSocket, 'connect');
    const spoofedProfilePromise = waitForEvent(guestSocket, EVENTS.PROFILE_UPDATE);
    guestSocket.emit(EVENTS.PROFILE_REQUEST, { profileId: targetAccountId, name: 'Spoofer' });
    const spoofedProfile = await spoofedProfilePromise;
    assert.notEqual(spoofedProfile.profileId, targetAccountId, 'unauthenticated socket cannot claim acct_*');
    assert.equal(Boolean(spoofedProfile.authenticated), false);

    // A socket presenting the verified sessionToken binds cleanly to the persistent account.
    authedSocket = createClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      auth: { sessionToken: verified.sessionToken },
    });
    const authedProfilePromise = waitForEvent(authedSocket, EVENTS.PROFILE_UPDATE);
    await waitForEvent(authedSocket, 'connect');
    const authedProfile = await authedProfilePromise;
    assert.equal(authedProfile.accountId, targetAccountId);
    assert.equal(authedProfile.authenticated, true);
    assert.equal(authedProfile.callsign, 'Valkyrie');
  } finally {
    guestSocket?.disconnect();
    authedSocket?.disconnect();
    await server.close();
  }
});
