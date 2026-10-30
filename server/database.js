import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const MIN_SUPPORTED_NODE_VERSION = Object.freeze({
  major: 22,
  minor: 13,
  patch: 0,
  text: '22.13.0',
});

export function parseNodeVersion(versionString = process.versions.node) {
  const clean = String(versionString ?? '').trim().replace(/^v/i, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: clean,
  };
}

export function assertSupportedNodeRuntime(versionString = process.versions.node) {
  const parsed = parseNodeVersion(versionString);
  const supported = Boolean(
    parsed
    && (
      parsed.major > MIN_SUPPORTED_NODE_VERSION.major
      || (
        parsed.major === MIN_SUPPORTED_NODE_VERSION.major
        && parsed.minor >= MIN_SUPPORTED_NODE_VERSION.minor
      )
    ),
  );
  if (!supported) {
    const error = new Error(
      `[FPS GODS] Unsupported Node.js runtime v${String(versionString ?? 'unknown').replace(/^v/i, '')}: `
      + `server/database.js requires Node.js >= ${MIN_SUPPORTED_NODE_VERSION.text} for built-in unflagged node:sqlite (DatabaseSync). `
      + 'Ensure Railway/Render uses Node 22.22.3 (via .node-version / package.json engines / NODE_VERSION).',
    );
    error.code = 'ERR_UNSUPPORTED_NODE_RUNTIME';
    throw error;
  }
  return parsed;
}

assertSupportedNodeRuntime();
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_FILENAME = 'fps-gods.sqlite';
const DEFAULT_RELATIVE_DB_PATH = path.join('.data', DEFAULT_DB_FILENAME);

function normalizeSqliteFilePath(rawPath, cwd = process.cwd()) {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed || trimmed === ':memory:') return ':memory:';
  const endsWithSeparator = trimmed.endsWith('/') || trimmed.endsWith('\\') || trimmed.endsWith(path.sep);
  const resolved = path.resolve(cwd, trimmed);
  if (endsWithSeparator) {
    return path.join(resolved, DEFAULT_DB_FILENAME);
  }
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, DEFAULT_DB_FILENAME);
    }
  } catch {
    // Path may not exist yet or stat may fail before mkdir; treat as file path.
  }
  return resolved;
}

export function resolveDatabaseConfig(options = {}, env = process.env) {
  const cwd = options.cwd || process.cwd();
  if (typeof options.dbPath === 'string' && options.dbPath.trim()) {
    const explicitRaw = options.dbPath.trim();
    const dbPath = explicitRaw === ':memory:'
      ? ':memory:'
      : normalizeSqliteFilePath(explicitRaw, cwd);
    return {
      dbPath,
      mode: dbPath === ':memory:' ? 'memory' : 'explicit-path',
      durableConfigured: dbPath !== ':memory:',
      explicit: true,
    };
  }

  const envPath = (env.DATABASE_PATH || env.SQLITE_DB_PATH || '').trim();
  if (envPath) {
    const dbPath = envPath === ':memory:'
      ? ':memory:'
      : normalizeSqliteFilePath(envPath, cwd);
    return {
      dbPath,
      mode: dbPath === ':memory:' ? 'memory' : 'configured-volume',
      durableConfigured: dbPath !== ':memory:',
      explicit: false,
    };
  }

  const isTestRunner = options.isTestRunner ?? (process.execArgv.includes('--test') || env.NODE_ENV === 'test');
  if (isTestRunner) {
    return {
      dbPath: ':memory:',
      mode: 'memory',
      durableConfigured: false,
      explicit: false,
    };
  }

  const railwayMount = (env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  if (railwayMount) {
    return {
      dbPath: path.join(path.resolve(cwd, railwayMount), DEFAULT_DB_FILENAME),
      mode: 'railway-volume',
      durableConfigured: true,
      explicit: false,
    };
  }

  return {
    dbPath: path.resolve(cwd, DEFAULT_RELATIVE_DB_PATH),
    mode: 'local-sqlite',
    durableConfigured: false,
    explicit: false,
  };
}

export class GameDatabase {
  constructor(options = {}) {
    this.config = resolveDatabaseConfig(options, options.env);
    this.db = this.openDatabase(options);
    this.closed = false;
    this.inTransaction = false;
    this.initSchema();
  }

  openDatabase(options = {}) {
    if (this.config.dbPath === ':memory:') {
      return new DatabaseSync(':memory:');
    }
    try {
      fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
      return new DatabaseSync(this.config.dbPath);
    } catch (error) {
      if (this.config.explicit || options.allowMemoryFallback === false) {
        throw error;
      }
      const failedPath = this.config.dbPath;
      const reason = error?.code || error?.message || 'SQLITE_OPEN_FAILED';
      console.error(
        `[FPS GODS] Could not open SQLite database at "${failedPath}" (${reason}). `
        + 'Falling back to ephemeral in-memory SQLite so gameplay remains online. '
        + 'On Railway, attach a persistent volume (e.g. /data) and set RAILWAY_RUN_UID=0 if the volume is root-owned.',
      );
      this.config = {
        dbPath: ':memory:',
        requestedPath: failedPath,
        mode: 'memory-fallback',
        durableConfigured: false,
        fallbackReason: String(reason),
        explicit: false,
      };
      return new DatabaseSync(':memory:');
    }
  }

  initSchema() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.config.dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
      } catch {
        this.db.exec('PRAGMA journal_mode = DELETE;');
      }
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email_normalized TEXT NOT NULL UNIQUE,
        callsign TEXT NOT NULL,
        selected_bundle TEXT NOT NULL DEFAULT 'RUSHER',
        lifetime_kills INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_kills >= 0),
        gods_tier_unlocked INTEGER NOT NULL DEFAULT 0,
        matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
        matches_won INTEGER NOT NULL DEFAULT 0 CHECK (matches_won >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS wallets (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 1000000000),
        lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL CHECK (balance_after >= 0 AND balance_after <= 1000000000),
        reason TEXT NOT NULL,
        match_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wallet_ledger_account_time
        ON wallet_ledger(account_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS callsign_changes (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        changed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_callsign_nocase ON accounts(callsign COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS otp_challenges (
        id TEXT PRIMARY KEY,
        email_normalized TEXT NOT NULL,
        code_hash BLOB NOT NULL,
        salt BLOB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        invalidated_at INTEGER,
        request_ip TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_otp_challenges_email_time
        ON otp_challenges(email_normalized, created_at DESC);

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        user_agent TEXT,
        ip_address TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_account
        ON auth_sessions(account_id);
    `);
  }

  transaction(fn) {
    if (this.inTransaction) {
      return fn(this.db);
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT');
      this.inTransaction = false;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore secondary rollback error if SQLite already rolled back.
      }
      this.inTransaction = false;
      throw error;
    }
  }

  getPersistenceSummary() {
    return {
      mode: this.config.mode,
      durableConfigured: this.config.durableConfigured,
      ...(this.config.fallbackReason ? { fallbackReason: this.config.fallbackReason } : {}),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
