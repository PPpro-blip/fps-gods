import { CURRENCY_CONFIG, REWARD_REASONS } from '../shared/economy.js';

export class EconomyService {
  constructor(database) {
    this.database = database;
    this.db = database.db;
    this.victimKillWindows = new Map();
    this.botCreditWindows = new Map();

    this.stmtGetAccount = this.db.prepare('SELECT id FROM accounts WHERE id = ?');
    this.stmtEnsureWallet = this.db.prepare(`
      INSERT INTO wallets (account_id, balance, lifetime_earned, updated_at)
      VALUES (?, 0, 0, ?)
      ON CONFLICT(account_id) DO NOTHING
    `);
    this.stmtGetWallet = this.db.prepare(`
      SELECT account_id, balance, lifetime_earned, updated_at
      FROM wallets
      WHERE account_id = ?
    `);
    this.stmtGetLedgerByKey = this.db.prepare(`
      SELECT id, account_id, amount, balance_after, reason, match_id, created_at
      FROM wallet_ledger
      WHERE idempotency_key = ?
    `);
    this.stmtUpdateWallet = this.db.prepare(`
      UPDATE wallets
      SET balance = ?, lifetime_earned = ?, updated_at = ?
      WHERE account_id = ?
    `);
    this.stmtInsertLedger = this.db.prepare(`
      INSERT INTO wallet_ledger (
        idempotency_key, account_id, amount, balance_after, reason, match_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtRecentLedger = this.db.prepare(`
      SELECT id, amount, balance_after, reason, match_id, metadata_json, created_at
      FROM wallet_ledger
      WHERE account_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this.stmtRecordMatchStats = this.db.prepare(`
      UPDATE accounts
      SET matches_played = matches_played + ?,
          matches_won = matches_won + ?,
          updated_at = ?
      WHERE id = ?
    `);
  }

  getWallet(accountId, { historyLimit = 12, now = Date.now() } = {}) {
    if (typeof accountId !== 'string' || !accountId.startsWith('acct_')) return null;
    const account = this.stmtGetAccount.get(accountId);
    if (!account) return null;

    this.stmtEnsureWallet.run(accountId, now);
    const row = this.stmtGetWallet.get(accountId);
    const limit = Math.max(0, Math.min(50, Math.floor(Number(historyLimit) || 0)));
    const history = limit > 0
      ? this.stmtRecentLedger.all(accountId, limit).map((item) => ({
        id: item.id,
        amount: item.amount,
        balanceAfter: item.balance_after,
        reason: item.reason,
        matchId: item.match_id || null,
        createdAt: item.created_at,
      }))
      : [];

    return {
      accountId,
      currency: CURRENCY_CONFIG.name,
      shortCode: CURRENCY_CONFIG.shortCode,
      symbol: CURRENCY_CONFIG.symbol,
      balance: row?.balance ?? 0,
      lifetimeEarned: row?.lifetime_earned ?? 0,
      updatedAt: row?.updated_at ?? now,
      recentTransactions: history,
    };
  }

  awardCredits({
    accountId,
    idempotencyKey,
    amount,
    reason,
    matchId = null,
    metadata = null,
    now = Date.now(),
  }) {
    if (typeof accountId !== 'string' || !accountId.startsWith('acct_')) {
      return { awarded: false, reason: 'unauthenticated' };
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 4) {
      throw new Error('idempotencyKey is required for every currency award');
    }
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > CURRENCY_CONFIG.maxSingleAward) {
      throw new Error(`Invalid credit award amount: ${amount}`);
    }
    if (typeof reason !== 'string' || !reason) {
      throw new Error('Award reason is required');
    }

    const key = idempotencyKey.trim();
    return this.database.transaction(() => {
      const account = this.stmtGetAccount.get(accountId);
      if (!account) {
        return { awarded: false, reason: 'unknown_account' };
      }

      const existing = this.stmtGetLedgerByKey.get(key);
      if (existing) {
        return {
          awarded: false,
          duplicate: true,
          amount: 0,
          balance: existing.balance_after,
          reason: existing.reason,
          idempotencyKey: key,
        };
      }

      this.stmtEnsureWallet.run(accountId, now);
      const wallet = this.stmtGetWallet.get(accountId);
      const currentBalance = wallet?.balance ?? 0;
      const currentLifetime = wallet?.lifetime_earned ?? 0;
      const clampedAdd = Math.min(amount, CURRENCY_CONFIG.maxBalance - currentBalance);
      if (clampedAdd <= 0) {
        return {
          awarded: false,
          capped: true,
          amount: 0,
          balance: currentBalance,
          reason,
          idempotencyKey: key,
        };
      }

      const nextBalance = currentBalance + clampedAdd;
      const nextLifetime = currentLifetime + clampedAdd;
      const metaJson = metadata ? JSON.stringify(metadata) : null;

      this.stmtUpdateWallet.run(nextBalance, nextLifetime, now, accountId);
      this.stmtInsertLedger.run(
        key,
        accountId,
        clampedAdd,
        nextBalance,
        reason,
        matchId,
        metaJson,
        now,
      );

      return {
        awarded: true,
        duplicate: false,
        amount: clampedAdd,
        balance: nextBalance,
        lifetimeEarned: nextLifetime,
        reason,
        matchId,
        idempotencyKey: key,
        createdAt: now,
      };
    });
  }

  awardElimination({
    killerAccountId,
    victimIdentity,
    isSoloBots = false,
    headshot = false,
    matchId,
    killSeq,
    now = Date.now(),
  }) {
    if (!killerAccountId || !killerAccountId.startsWith('acct_')) return null;
    if (!matchId || !Number.isSafeInteger(killSeq)) return null;
    if (victimIdentity && victimIdentity === killerAccountId) return null;

    const rules = CURRENCY_CONFIG.antiFarming;
    const base = isSoloBots
      ? CURRENCY_CONFIG.rewards.eliminationSoloBots
      : CURRENCY_CONFIG.rewards.eliminationMultiplayer;
    const amount = base + (headshot ? CURRENCY_CONFIG.rewards.headshotBonus : 0);

    if (isSoloBots) {
      const history = (this.botCreditWindows.get(killerAccountId) || [])
        .filter((entry) => now - entry.at < rules.botKillWindowMs);
      const earnedInWindow = history.reduce((sum, entry) => sum + entry.amount, 0);
      if (earnedInWindow + amount > rules.maxBotKillCreditsPerWindow) {
        this.botCreditWindows.set(killerAccountId, history);
        return { awarded: false, throttled: true, reason: 'bot_farming_cap' };
      }
      const res = this.awardCredits({
        accountId: killerAccountId,
        idempotencyKey: `kill:${matchId}:${killSeq}:${killerAccountId}`,
        amount,
        reason: REWARD_REASONS.ELIMINATION,
        matchId,
        metadata: { mode: 'SOLO_VS_BOTS', headshot: Boolean(headshot) },
        now,
      });
      if (res.awarded) {
        history.push({ at: now, amount: res.amount });
        this.botCreditWindows.set(killerAccountId, history);
      }
      return res;
    }

    if (victimIdentity) {
      const pairKey = `${killerAccountId}->${victimIdentity}`;
      const timestamps = (this.victimKillWindows.get(pairKey) || [])
        .filter((at) => now - at < rules.sameVictimWindowMs);
      if (timestamps.length >= rules.maxRewardedKillsPerVictimWindow) {
        this.victimKillWindows.set(pairKey, timestamps);
        return { awarded: false, throttled: true, reason: 'repeat_victim_cap' };
      }
      const res = this.awardCredits({
        accountId: killerAccountId,
        idempotencyKey: `kill:${matchId}:${killSeq}:${killerAccountId}`,
        amount,
        reason: REWARD_REASONS.ELIMINATION,
        matchId,
        metadata: { mode: 'MULTIPLAYER', headshot: Boolean(headshot) },
        now,
      });
      if (res.awarded) {
        timestamps.push(now);
        this.victimKillWindows.set(pairKey, timestamps);
      }
      return res;
    }

    return this.awardCredits({
      accountId: killerAccountId,
      idempotencyKey: `kill:${matchId}:${killSeq}:${killerAccountId}`,
      amount,
      reason: REWARD_REASONS.ELIMINATION,
      matchId,
      metadata: { mode: 'MULTIPLAYER', headshot: Boolean(headshot) },
      now,
    });
  }

  awardAssist({
    assisterAccountId,
    killerAccountId,
    matchId,
    killSeq,
    now = Date.now(),
  }) {
    if (!assisterAccountId || !assisterAccountId.startsWith('acct_')) return null;
    if (assisterAccountId === killerAccountId) return null;
    if (!matchId || !Number.isSafeInteger(killSeq)) return null;

    return this.awardCredits({
      accountId: assisterAccountId,
      idempotencyKey: `assist:${matchId}:${killSeq}:${assisterAccountId}`,
      amount: CURRENCY_CONFIG.rewards.assist,
      reason: REWARD_REASONS.ASSIST,
      matchId,
      metadata: { killSeq },
      now,
    });
  }

  awardMatchSummary({
    matchId,
    winnerAccountId = null,
    participants = [],
    isSoloBots = false,
    now = Date.now(),
  }) {
    if (!matchId) return [];
    const results = [];
    const seenAccounts = new Set();

    for (const participant of participants) {
      const accountId = participant?.accountId;
      if (!accountId || !accountId.startsWith('acct_') || seenAccounts.has(accountId)) continue;
      seenAccounts.add(accountId);

      const activeEnough = Boolean(
        participant.connected
        && (
          (participant.kills ?? 0) > 0
          || (participant.participationMs ?? 0) >= CURRENCY_CONFIG.antiFarming.minMatchParticipationMs
        ),
      );
      if (!activeEnough) continue;

      const isWinner = winnerAccountId === accountId;
      const completionRes = this.database.transaction(() => {
        const creditRes = this.awardCredits({
          accountId,
          idempotencyKey: `complete:${matchId}:${accountId}`,
          amount: CURRENCY_CONFIG.rewards.matchCompletion,
          reason: REWARD_REASONS.MATCH_COMPLETION,
          matchId,
          metadata: { mode: isSoloBots ? 'SOLO_VS_BOTS' : 'MULTIPLAYER' },
          now,
        });
        if (creditRes.awarded) {
          this.stmtRecordMatchStats.run(1, isWinner ? 1 : 0, now, accountId);
        }
        return creditRes;
      });
      if (completionRes?.awarded) {
        results.push({ accountId, ...completionRes });
      }

      if (isWinner) {
        const victoryRes = this.awardCredits({
          accountId,
          idempotencyKey: `victory:${matchId}:${accountId}`,
          amount: CURRENCY_CONFIG.rewards.matchVictory,
          reason: REWARD_REASONS.MATCH_VICTORY,
          matchId,
          metadata: { mode: isSoloBots ? 'SOLO_VS_BOTS' : 'MULTIPLAYER' },
          now,
        });
        if (victoryRes?.awarded) {
          results.push({ accountId, ...victoryRes });
        }
      }
    }

    return results;
  }
}
