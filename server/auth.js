import crypto from 'node:crypto';
import { BUNDLE_BY_ID, BUNDLE_UNLOCK_KILLS, DEFAULT_BUNDLE_ID } from '../shared/bundles.js';

export const SESSION_COOKIE_NAME = 'fps_gods_session';

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const OTP_CODE_PATTERN = /^\d{6}$/;

const DEFAULT_OTP_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_OTP_COOLDOWN_MS = 60 * 1_000;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RATE_WINDOW_MS = 15 * 60 * 1_000;

class SlidingRateLimiter {
  constructor(maxEvents, windowMs = RATE_WINDOW_MS) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  checkAndRecord(key, now = Date.now()) {
    if (!key) return { allowed: true, retryAfterSeconds: 0 };
    const cutoff = now - this.windowMs;
    const entries = (this.buckets.get(key) || []).filter((ts) => ts > cutoff);
    if (entries.length >= this.maxEvents) {
      this.buckets.set(key, entries);
      const retryMs = Math.max(1_000, entries[0] + this.windowMs - now);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryMs / 1_000) };
    }
    entries.push(now);
    this.buckets.set(key, entries);
    if (this.buckets.size > 4_096) {
      const oldestKey = this.buckets.keys().next().value;
      this.buckets.delete(oldestKey);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed.length > 254) return null;
  if (/[\r\n\0\s]/.test(trimmed)) return null;
  if (!EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function maskEmail(emailNormalized) {
  if (typeof emailNormalized !== 'string' || !emailNormalized.includes('@')) return '';
  const [local, domain] = emailNormalized.split('@');
  if (local.length <= 2) {
    return `${local[0] || '*'}*@${domain}`;
  }
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(5, local.length - 2))}@${domain}`;
}

export function sanitizeAccountCallsign(value, fallback = 'Operator') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^\w -]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 16)
    .trim();
  return cleaned || fallback;
}

function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest();
}

function hashOtpCode(code, saltBuffer, pepperBuffer) {
  return crypto.scryptSync(
    Buffer.from(String(code), 'utf8'),
    Buffer.concat([saltBuffer, pepperBuffer]),
    32,
  );
}

export function parseCookieHeader(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

export function extractRequestSessionToken(req) {
  const authHeader = req?.headers?.authorization;
  if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer.length >= 20 && bearer.length <= 256) return bearer;
  }
  const cookies = parseCookieHeader(req?.headers?.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length >= 20 && cookieToken.length <= 256) {
    return cookieToken;
  }
  return null;
}

export function extractSocketSessionToken(socket) {
  const handshakeAuthToken = socket?.handshake?.auth?.sessionToken;
  if (typeof handshakeAuthToken === 'string' && handshakeAuthToken.trim().length >= 20) {
    return handshakeAuthToken.trim();
  }
  const cookies = parseCookieHeader(socket?.handshake?.headers?.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length >= 20 && cookieToken.length <= 256) {
    return cookieToken;
  }
  return null;
}

export function buildSessionCookie(rawToken, { maxAgeSeconds, secure }) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie({ secure }) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export class AuthService {
  constructor(database, emailProvider, options = {}) {
    this.database = database;
    this.db = database.db;
    this.emailProvider = emailProvider;
    const fee = Number(options.callsignFee ?? process.env.CALLSIGN_CHANGE_FEE ?? 100);
    const cooldown = Number(options.callsignCooldownMs ?? process.env.CALLSIGN_CHANGE_COOLDOWN_MS ?? 604800000);
    this.callsignFee = Number.isSafeInteger(fee) && fee > 0 && fee <= 1000000 ? fee : 100;
    this.callsignCooldownMs = Number.isSafeInteger(cooldown) && cooldown >= 60000 ? cooldown : 604800000;

    this.otpTtlMs = options.otpTtlMs ?? (Number(process.env.AUTH_OTP_TTL_MS) || DEFAULT_OTP_TTL_MS);
    this.otpCooldownMs = options.otpCooldownMs ?? (Number(process.env.AUTH_OTP_COOLDOWN_MS) || DEFAULT_OTP_COOLDOWN_MS);
    this.otpMaxAttempts = options.otpMaxAttempts ?? DEFAULT_OTP_MAX_ATTEMPTS;
    this.sessionTtlMs = options.sessionTtlMs ?? (Number(process.env.AUTH_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS);

    const configuredPepper = (process.env.AUTH_OTP_PEPPER || process.env.AUTH_SECRET || '').trim();
    this.pepper = configuredPepper
      ? crypto.createHash('sha256').update(configuredPepper, 'utf8').digest()
      : crypto.randomBytes(32);

    this.requestIpLimiter = new SlidingRateLimiter(options.maxRequestsPerIp ?? 6, RATE_WINDOW_MS);
    this.requestEmailLimiter = new SlidingRateLimiter(options.maxRequestsPerEmail ?? 4, RATE_WINDOW_MS);
    this.verifyIpLimiter = new SlidingRateLimiter(options.maxVerifyPerIp ?? 12, RATE_WINDOW_MS);
    this.verifyEmailLimiter = new SlidingRateLimiter(options.maxVerifyPerEmail ?? 8, RATE_WINDOW_MS);

    this.stmtLatestChallenge = this.db.prepare(`
      SELECT id, created_at
      FROM otp_challenges
      WHERE email_normalized = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    this.stmtInvalidatePriorChallenges = this.db.prepare(`
      UPDATE otp_challenges
      SET invalidated_at = ?
      WHERE email_normalized = ? AND consumed_at IS NULL AND invalidated_at IS NULL
    `);
    this.stmtInsertChallenge = this.db.prepare(`
      INSERT INTO otp_challenges (
        id, email_normalized, code_hash, salt, attempts, max_attempts, expires_at, request_ip, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `);
    this.stmtInvalidateChallengeById = this.db.prepare(`
      UPDATE otp_challenges SET invalidated_at = ? WHERE id = ?
    `);
    this.stmtActiveChallenge = this.db.prepare(`
      SELECT id, email_normalized, code_hash, salt, attempts, max_attempts, expires_at, consumed_at, invalidated_at
      FROM otp_challenges
      WHERE email_normalized = ?
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);
    this.stmtIncrementChallengeAttempts = this.db.prepare(`
      UPDATE otp_challenges
      SET attempts = attempts + 1,
          invalidated_at = CASE WHEN attempts + 1 >= max_attempts THEN ? ELSE invalidated_at END
      WHERE id = ?
    `);
    this.stmtConsumeChallenge = this.db.prepare(`
      UPDATE otp_challenges
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
    `);

    this.stmtFindAccountByEmail = this.db.prepare(`
      SELECT * FROM accounts WHERE email_normalized = ?
    `);
    this.stmtFindAccountById = this.db.prepare(`
      SELECT * FROM accounts WHERE id = ?
    `);
    this.stmtInsertAccount = this.db.prepare(`
      INSERT INTO accounts (
        id, email_normalized, callsign, selected_bundle, lifetime_kills, gods_tier_unlocked,
        matches_played, matches_won, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)
    `);
    this.stmtTouchAccountLogin = this.db.prepare(`
      UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?
    `);
    this.stmtUpdateAccountProfile = this.db.prepare(`
      UPDATE accounts
      SET callsign = ?, selected_bundle = ?, updated_at = ?
      WHERE id = ?
    `);
    this.stmtRecordAccountKills = this.db.prepare(`
      UPDATE accounts
      SET lifetime_kills = ?, gods_tier_unlocked = ?, updated_at = ?
      WHERE id = ?
    `);
    this.stmtEnsureWallet = this.db.prepare(`
      INSERT INTO wallets (account_id, balance, lifetime_earned, updated_at)
      VALUES (?, 0, 0, ?)
      ON CONFLICT(account_id) DO NOTHING
    `);

    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO auth_sessions (
        id, account_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindSessionByHash = this.db.prepare(`
      SELECT s.id AS session_id, s.account_id, s.expires_at, s.last_seen_at, s.revoked_at,
             a.email_normalized, a.callsign, a.selected_bundle, a.lifetime_kills,
             a.gods_tier_unlocked, a.matches_played, a.matches_won, a.created_at
      FROM auth_sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?
    `);
    this.stmtTouchSession = this.db.prepare(`
      UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?
    `);
    this.stmtRevokeSessionByHash = this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `);
  }

  getStatus() {
    return {
      otpConfigured: Boolean(this.emailProvider?.configured),
      emailProvider: this.emailProvider?.name || 'unconfigured',
      otpExpiresInSeconds: Math.round(this.otpTtlMs / 1_000),
      resendCooldownSeconds: Math.round(this.otpCooldownMs / 1_000),
      persistence: this.database.getPersistenceSummary(),
      callsignChangeFee: this.callsignFee,
      callsignCooldownSeconds: Math.ceil(this.callsignCooldownMs / 1000),
    };
  }

  formatPublicAccount(row) {
    if (!row) return null;
    const lifetimeKills = row.lifetime_kills ?? 0;
    const godsTierUnlocked = Boolean(row.gods_tier_unlocked) || lifetimeKills >= BUNDLE_UNLOCK_KILLS;
    const selectedBundle = BUNDLE_BY_ID[row.selected_bundle] && (row.selected_bundle !== 'GODS_TIER' || godsTierUnlocked)
      ? row.selected_bundle
      : DEFAULT_BUNDLE_ID;
    return {
      accountId: row.id ?? row.account_id,
      emailMasked: maskEmail(row.email_normalized),
      callsign: row.callsign,
      selectedBundle,
      lifetimeKills,
      godsTierUnlocked,
      killsToUnlockGodsTier: Math.max(0, BUNDLE_UNLOCK_KILLS - lifetimeKills),
      matchesPlayed: row.matches_played ?? 0,
      matchesWon: row.matches_won ?? 0,
      authenticated: true,
    };
  }

  getAccountById(accountId) {
    if (typeof accountId !== 'string' || !accountId.startsWith('acct_')) return null;
    const row = this.stmtFindAccountById.get(accountId);
    return this.formatPublicAccount(row);
  }

  callsignTaken(callsign, exceptId = '') {
    return Boolean(this.db.prepare('SELECT id FROM accounts WHERE callsign = ? COLLATE NOCASE AND id != ? LIMIT 1').get(callsign, exceptId));
  }

  availableInitialCallsign(preferred) {
    if (!this.callsignTaken(preferred)) return preferred;
    // Keep existing identities untouched, even if legacy accounts share a name.
    for (let i = 0; i < 100; i++) {
      const suffix = crypto.randomBytes(4).toString('hex');
      const candidate = `${preferred.slice(0, 7)}-${suffix}`;
      if (!this.callsignTaken(candidate)) return candidate;
    }
    throw new Error('Could not allocate a unique callsign.');
  }

  updateAccountProfile(accountId, { callsign, selectedBundle } = {}, now = Date.now()) {
    return this.database.transaction(() => {
      const existing = this.stmtFindAccountById.get(accountId);
      if (!existing) return null;
      const nextCallsign = callsign !== undefined ? sanitizeAccountCallsign(callsign, existing.callsign) : existing.callsign;
      if (nextCallsign !== existing.callsign) {
        const fail = (code, message, status = 400) => { const e = new Error(message); e.code = code; e.status = status; throw e; };
        if (this.callsignTaken(nextCallsign, accountId)) fail('CALLSIGN_TAKEN', 'That callsign is already in use.', 409);
        const last = this.db.prepare('SELECT changed_at FROM callsign_changes WHERE account_id = ?').get(accountId);
        if (last && now - last.changed_at < this.callsignCooldownMs) fail('CALLSIGN_COOLDOWN', 'Callsign change cooldown is still active.', 429);
        this.stmtEnsureWallet.run(accountId, now);
        const wallet = this.db.prepare('SELECT balance FROM wallets WHERE account_id = ?').get(accountId);
        if (wallet.balance < this.callsignFee) fail('INSUFFICIENT_FUNDS', `Changing callsign costs ${this.callsignFee} SHARZS.`, 402);
        const balance = wallet.balance - this.callsignFee;
        this.db.prepare('UPDATE wallets SET balance = ?, updated_at = ? WHERE account_id = ?').run(balance, now, accountId);
        this.db.prepare('INSERT INTO wallet_ledger (idempotency_key, account_id, amount, balance_after, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`callsign:${crypto.randomUUID()}`, accountId, -this.callsignFee, balance, 'callsign_change', now);
        this.db.prepare('INSERT INTO callsign_changes (account_id, changed_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at').run(accountId, now);
      }
      const unlocked = Boolean(existing.gods_tier_unlocked) || existing.lifetime_kills >= BUNDLE_UNLOCK_KILLS;
      let nextBundle = existing.selected_bundle;
      if (typeof selectedBundle === 'string' && BUNDLE_BY_ID[selectedBundle] && (selectedBundle !== 'GODS_TIER' || unlocked)) nextBundle = selectedBundle;
      this.stmtUpdateAccountProfile.run(nextCallsign, nextBundle, now, accountId);
      return this.getAccountById(accountId);
    });
  }

  recordAccountKill(accountId, amount = 1, now = Date.now()) {
    if (typeof accountId !== 'string' || !accountId.startsWith('acct_')) return null;
    const increment = Math.max(0, Math.floor(Number(amount) || 0));
    if (increment <= 0) return this.getAccountById(accountId);

    return this.database.transaction(() => {
      const existing = this.stmtFindAccountById.get(accountId);
      if (!existing) return null;
      const nextKills = existing.lifetime_kills + increment;
      const unlocked = existing.gods_tier_unlocked || nextKills >= BUNDLE_UNLOCK_KILLS ? 1 : 0;
      this.stmtRecordAccountKills.run(nextKills, unlocked, now, accountId);
      return this.getAccountById(accountId);
    });
  }

  async requestOtp({ email, ip = 'unknown', now = Date.now() }) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      const err = new Error('Enter a valid email address.');
      err.code = 'INVALID_EMAIL';
      err.status = 400;
      throw err;
    }

    if (!this.emailProvider?.configured) {
      const err = new Error(
        'Email OTP delivery is not configured on this server. Configure RESEND_API_KEY and AUTH_EMAIL_FROM on the backend.',
      );
      err.code = 'EMAIL_PROVIDER_UNCONFIGURED';
      err.status = 503;
      throw err;
    }

    const ipCheck = this.requestIpLimiter.checkAndRecord(ip, now);
    if (!ipCheck.allowed) {
      const err = new Error(`Too many verification requests. Try again in ${ipCheck.retryAfterSeconds}s.`);
      err.code = 'RATE_LIMITED';
      err.status = 429;
      err.retryAfterSeconds = ipCheck.retryAfterSeconds;
      throw err;
    }

    const latest = this.stmtLatestChallenge.get(normalized);
    if (latest && now - latest.created_at < this.otpCooldownMs) {
      const waitSeconds = Math.max(1, Math.ceil((this.otpCooldownMs - (now - latest.created_at)) / 1_000));
      const err = new Error(`Please wait ${waitSeconds}s before requesting another code.`);
      err.code = 'OTP_COOLDOWN';
      err.status = 429;
      err.retryAfterSeconds = waitSeconds;
      throw err;
    }

    const emailCheck = this.requestEmailLimiter.checkAndRecord(normalized, now);
    if (!emailCheck.allowed) {
      const err = new Error(`Too many codes sent recently. Try again in ${emailCheck.retryAfterSeconds}s.`);
      err.code = 'RATE_LIMITED';
      err.status = 429;
      err.retryAfterSeconds = emailCheck.retryAfterSeconds;
      throw err;
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = crypto.randomBytes(16);
    const codeHash = hashOtpCode(code, salt, this.pepper);
    const challengeId = `otp_${crypto.randomUUID()}`;
    const expiresAt = now + this.otpTtlMs;

    this.database.transaction(() => {
      this.stmtInvalidatePriorChallenges.run(now, normalized);
      this.stmtInsertChallenge.run(
        challengeId,
        normalized,
        codeHash,
        salt,
        this.otpMaxAttempts,
        expiresAt,
        String(ip || '').slice(0, 64),
        now,
      );
    });

    try {
      await this.emailProvider.sendOtpEmail({
        to: normalized,
        code,
        expiresInMinutes: Math.max(1, Math.round(this.otpTtlMs / 60_000)),
      });
    } catch (deliveryError) {
      this.stmtInvalidateChallengeById.run(now, challengeId);
      const err = new Error(deliveryError?.message || 'Unable to deliver verification email right now.');
      err.code = deliveryError?.code || 'EMAIL_DELIVERY_FAILED';
      err.status = deliveryError?.status || 502;
      throw err;
    }

    // Enumeration-safe uniform response regardless of whether an account exists.
    return {
      ok: true,
      expiresInSeconds: Math.round(this.otpTtlMs / 1_000),
      cooldownSeconds: Math.round(this.otpCooldownMs / 1_000),
      message: 'If that address can receive mail, a 6-digit verification code has been sent.',
    };
  }

  verifyOtp({
    email,
    code,
    callsign,
    selectedBundle,
    ip = 'unknown',
    userAgent = '',
    now = Date.now(),
  }) {
    const normalized = normalizeEmail(email);
    const cleanCode = String(code ?? '').trim();
    if (!normalized || !OTP_CODE_PATTERN.test(cleanCode)) {
      const err = new Error('Enter your email and the 6-digit verification code.');
      err.code = 'INVALID_OTP_INPUT';
      err.status = 400;
      throw err;
    }

    const ipCheck = this.verifyIpLimiter.checkAndRecord(ip, now);
    const emailCheck = this.verifyEmailLimiter.checkAndRecord(normalized, now);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryAfterSeconds = Math.max(ipCheck.retryAfterSeconds, emailCheck.retryAfterSeconds, 1);
      const err = new Error(`Too many verification attempts. Try again in ${retryAfterSeconds}s.`);
      err.code = 'RATE_LIMITED';
      err.status = 429;
      err.retryAfterSeconds = retryAfterSeconds;
      throw err;
    }

    return this.database.transaction(() => {
      const challenge = this.stmtActiveChallenge.get(normalized);
      if (!challenge || challenge.expires_at <= now || challenge.attempts >= challenge.max_attempts) {
        if (challenge && challenge.expires_at <= now) {
          this.stmtInvalidateChallengeById.run(now, challenge.id);
        }
        const err = new Error('Invalid or expired verification code.');
        err.code = 'INVALID_OR_EXPIRED_OTP';
        err.status = 401;
        throw err;
      }

      const candidateHash = hashOtpCode(cleanCode, Buffer.from(challenge.salt), this.pepper);
      const expectedHash = Buffer.from(challenge.code_hash);
      const matches = expectedHash.length === candidateHash.length
        && crypto.timingSafeEqual(expectedHash, candidateHash);

      if (!matches) {
        this.stmtIncrementChallengeAttempts.run(now, challenge.id);
        const err = new Error('Invalid or expired verification code.');
        err.code = 'INVALID_OR_EXPIRED_OTP';
        err.status = 401;
        throw err;
      }

      const consumeResult = this.stmtConsumeChallenge.run(now, challenge.id);
      if (!consumeResult || consumeResult.changes !== 1) {
        const err = new Error('Invalid or expired verification code.');
        err.code = 'INVALID_OR_EXPIRED_OTP';
        err.status = 401;
        throw err;
      }

      let accountRow = this.stmtFindAccountByEmail.get(normalized);
      let isNewAccount = false;
      if (!accountRow) {
        isNewAccount = true;
        const accountId = `acct_${crypto.randomUUID()}`;
        const defaultName = normalized.split('@')[0].slice(0, 12);
        const initialCallsign = this.availableInitialCallsign(sanitizeAccountCallsign(callsign, defaultName || 'Operator'));
        const initialBundle = typeof selectedBundle === 'string'
          && BUNDLE_BY_ID[selectedBundle]
          && selectedBundle !== 'GODS_TIER'
          ? selectedBundle
          : DEFAULT_BUNDLE_ID;
        this.stmtInsertAccount.run(
          accountId,
          normalized,
          initialCallsign,
          initialBundle,
          now,
          now,
          now,
        );
        this.stmtEnsureWallet.run(accountId, now);
        accountRow = this.stmtFindAccountById.get(accountId);
      } else {
        this.stmtTouchAccountLogin.run(now, now, accountRow.id);
        this.stmtEnsureWallet.run(accountRow.id, now);
        accountRow = this.stmtFindAccountById.get(accountRow.id);
      }

      const rawSessionToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashSessionToken(rawSessionToken);
      const sessionId = `sess_${crypto.randomUUID()}`;
      const sessionExpiresAt = now + this.sessionTtlMs;

      this.stmtInsertSession.run(
        sessionId,
        accountRow.id,
        tokenHash,
        now,
        sessionExpiresAt,
        now,
        String(userAgent || '').slice(0, 180),
        String(ip || '').slice(0, 64),
      );

      return {
        isNewAccount,
        sessionToken: rawSessionToken,
        sessionExpiresAt,
        maxAgeSeconds: Math.floor(this.sessionTtlMs / 1_000),
        account: this.formatPublicAccount(accountRow),
      };
    });
  }

  verifySessionToken(rawToken, now = Date.now()) {
    if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 256) {
      return null;
    }
    const tokenHash = hashSessionToken(rawToken);
    const row = this.stmtFindSessionByHash.get(tokenHash);
    if (!row) return null;
    if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
    if (row.expires_at <= now) return null;

    if (now - (row.last_seen_at || 0) > 60_000) {
      this.stmtTouchSession.run(now, row.session_id);
    }

    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      expiresAt: row.expires_at,
      account: this.formatPublicAccount(row),
    };
  }

  logout(rawToken, now = Date.now()) {
    if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 256) {
      return false;
    }
    const tokenHash = hashSessionToken(rawToken);
    const res = this.stmtRevokeSessionByHash.run(now, tokenHash);
    return Boolean(res && res.changes > 0);
  }
}
