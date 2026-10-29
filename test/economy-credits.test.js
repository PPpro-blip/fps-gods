import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as createClient } from 'socket.io-client';
import { GameDatabase } from '../server/database.js';
import { AuthService } from '../server/auth.js';
import { EconomyService } from '../server/economy.js';
import { createGameServer } from '../server/index.js';
import { CURRENCY_CONFIG } from '../shared/economy.js';
import { EVENTS } from '../shared/events.js';

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

test('EconomyService awards Credits idempotently, enforces anti-farming caps, and persists across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fps-gods-econ-'));
  const dbPath = join(dir, 'econ.sqlite');
  let nowMs = 1_700_000_000_000;
  const outbox = [];
  const provider = {
    name: 'mock',
    configured: true,
    async sendOtpEmail(msg) { outbox.push(msg); return { delivered: true }; },
  };

  let db = new GameDatabase({ dbPath });
  const auth = new AuthService(db, provider);
  await auth.requestOtp({ email: 'hunter@example.com', ip: '127.0.0.1', now: nowMs });
  const { account } = auth.verifyOtp({
    email: 'hunter@example.com',
    code: outbox[0].code,
    callsign: 'Hunter',
    now: nowMs + 100,
  });
  const economy = new EconomyService(db);
  const victimA = 'acct_victim_a';

  try {
    // 1. Validated headshot elimination awards multiplayer base + headshot bonus.
    const expectedHeadshot = CURRENCY_CONFIG.rewards.eliminationMultiplayer + CURRENCY_CONFIG.rewards.headshotBonus;
    const elim1 = economy.awardElimination({
      killerAccountId: account.accountId,
      victimIdentity: victimA,
      isSoloBots: false,
      headshot: true,
      matchId: 'match_1',
      killSeq: 1,
      now: nowMs,
    });
    assert.equal(elim1.awarded, true);
    assert.equal(elim1.amount, expectedHeadshot);
    assert.equal(elim1.balance, expectedHeadshot);

    // 2. Replaying the exact same killSeq is idempotent (0 duplicate Credits).
    const duplicate = economy.awardElimination({
      killerAccountId: account.accountId,
      victimIdentity: victimA,
      isSoloBots: false,
      headshot: true,
      matchId: 'match_1',
      killSeq: 1,
      now: nowMs,
    });
    assert.equal(duplicate.awarded, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.balance, expectedHeadshot);

    // 3. Repeated rapid kills on the same human victim within window hit repeat_victim_cap.
    let throttled = null;
    for (let seq = 2; seq <= CURRENCY_CONFIG.antiFarming.maxRewardedKillsPerVictimWindow + 2; seq += 1) {
      throttled = economy.awardElimination({
        killerAccountId: account.accountId,
        victimIdentity: victimA,
        isSoloBots: false,
        headshot: false,
        matchId: 'match_1',
        killSeq: seq,
        now: nowMs + seq * 1_000,
      });
    }
    assert.equal(throttled.awarded, false);
    assert.equal(throttled.throttled, true);
    assert.equal(throttled.reason, 'repeat_victim_cap');

    // 4. Solo bot farming cap throttles excess bot kills within botKillWindowMs.
    let botRes = null;
    const maxBotKills = Math.floor(
      CURRENCY_CONFIG.antiFarming.maxBotKillCreditsPerWindow / CURRENCY_CONFIG.rewards.eliminationSoloBots,
    ) + 2;
    for (let seq = 1; seq <= maxBotKills; seq += 1) {
      botRes = economy.awardElimination({
        killerAccountId: account.accountId,
        victimIdentity: `bot_${seq}`,
        isSoloBots: true,
        headshot: false,
        matchId: 'solo_match_1',
        killSeq: seq,
        now: nowMs + 5_000,
      });
      if (botRes?.throttled) break;
    }
    assert.equal(botRes.throttled, true);
    assert.equal(botRes.reason, 'bot_farming_cap');

    // 5. Instant-leave / inactive participant (< minMatchParticipationMs & 0 kills) earns 0.
    const inactiveSummary = economy.awardMatchSummary({
      matchId: 'short_match',
      winnerAccountId: account.accountId,
      participants: [{ accountId: account.accountId, connected: true, kills: 0, participationMs: 1_000 }],
      now: nowMs + 10_000,
    });
    assert.equal(inactiveSummary.length, 0);

    // 6. Active match completion + victory awards both idempotently.
    const activeSummary = economy.awardMatchSummary({
      matchId: 'full_match_1',
      winnerAccountId: account.accountId,
      participants: [{ accountId: account.accountId, connected: true, kills: 3, participationMs: 60_000 }],
      now: nowMs + 60_000,
    });
    assert.equal(activeSummary.length, 2);
    const totalAfterMatch = economy.getWallet(account.accountId).balance;

    // Replaying match summary produces 0 additional payouts.
    const replaySummary = economy.awardMatchSummary({
      matchId: 'full_match_1',
      winnerAccountId: account.accountId,
      participants: [{ accountId: account.accountId, connected: true, kills: 3, participationMs: 60_000 }],
      now: nowMs + 61_000,
    });
    assert.equal(replaySummary.length, 0);
    assert.equal(economy.getWallet(account.accountId).balance, totalAfterMatch);

    // 7. Reopening SQLite preserves durable balance and transaction audit trail.
    db.close();
    db = new GameDatabase({ dbPath });
    const reloadedEconomy = new EconomyService(db);
    const reloaded = reloadedEconomy.getWallet(account.accountId, { historyLimit: 10 });
    assert.equal(reloaded.balance, totalAfterMatch);
    assert.equal(reloaded.lifetimeEarned, totalAfterMatch);
    assert.ok(reloaded.recentTransactions.length >= 5);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Live server awards Credits only on authoritative server kills and ignores forged client currency events', async () => {
  const outbox = [];
  const server = createGameServer({
    dbPath: ':memory:',
    emailProvider: {
      name: 'mock',
      configured: true,
      async sendOtpEmail(msg) { outbox.push(msg); return { delivered: true }; },
    },
  });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let killerSocket = null;
  let victimSocket = null;

  try {
    const guestWalletRes = await fetch(`${baseUrl}/api/wallet`);
    assert.equal(guestWalletRes.status, 401);

    await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ace@example.com' }),
    });
    const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ace@example.com', code: outbox[0].code, callsign: 'Ace' }),
    }).then((r) => r.json());

    killerSocket = createClient(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      auth: { sessionToken: verifyRes.sessionToken },
    });
    victimSocket = createClient(baseUrl, { transports: ['websocket'], forceNew: true });
    await Promise.all([waitForEvent(killerSocket, 'connect'), waitForEvent(victimSocket, 'connect')]);

    // Forged client wallet/reward emissions must have zero effect on server balance.
    killerSocket.emit(EVENTS.WALLET_UPDATE, { balance: 999_999 });
    killerSocket.emit(EVENTS.REWARD_EARNED, { amount: 999_999 });
    const walletBefore = await fetch(`${baseUrl}/api/wallet`, {
      headers: { Authorization: `Bearer ${verifyRes.sessionToken}` },
    }).then((r) => r.json());
    assert.equal(walletBefore.wallet.balance, 0);

    // Start a real 2-player match with valid bundle IDs ('GHOST' & 'RUSHER').
    const createdPromise = waitForEvent(killerSocket, EVENTS.ROOM_STATE);
    killerSocket.emit(EVENTS.CREATE_ROOM, { name: 'Ace', bundleId: 'GHOST', mapId: 'DUST_DEVIL' });
    const createdRoom = await createdPromise;

    const joinedPromise = waitForEvent(victimSocket, EVENTS.ROOM_STATE);
    victimSocket.emit(EVENTS.JOIN_ROOM, { code: createdRoom.code, name: 'Target', bundleId: 'RUSHER' });
    await joinedPromise;

    const ready1 = waitForEvent(killerSocket, EVENTS.ROOM_STATE);
    victimSocket.emit(EVENTS.PLAYER_READY, { ready: true });
    await ready1;

    const ready2 = waitForEvent(killerSocket, EVENTS.ROOM_STATE);
    killerSocket.emit(EVENTS.PLAYER_READY, { ready: true });
    await ready2;

    const startPromise = waitForEvent(killerSocket, EVENTS.GAME_START);
    killerSocket.emit(EVENTS.START_GAME);
    await startPromise;

    const room = server.roomManager.rooms.get(createdRoom.code);
    room.game.cover = [];
    const killerPlayer = room.game.players.get(killerSocket.id);
    const victimPlayer = room.game.players.get(victimSocket.id);
    Object.assign(killerPlayer, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, spawnProtectionUntil: 0 });
    Object.assign(victimPlayer, { x: 0, y: 0, z: -4, yaw: 0, pitch: 0, health: 25, spawnProtectionUntil: 0 });

    const rewardPromise = waitForEvent(killerSocket, EVENTS.REWARD_EARNED);
    const walletPromise = waitForEvent(killerSocket, EVENTS.WALLET_UPDATE);
    killerSocket.emit(EVENTS.SHOOT, { shotId: 1 });
    const [reward, walletUpdate] = await Promise.all([rewardPromise, walletPromise]);

    assert.equal(reward.reason, 'elimination');
    assert.ok(reward.amount >= CURRENCY_CONFIG.rewards.eliminationMultiplayer);
    assert.equal(walletUpdate.balance, reward.amount);
  } finally {
    killerSocket?.disconnect();
    victimSocket?.disconnect();
    await server.close();
  }
});
