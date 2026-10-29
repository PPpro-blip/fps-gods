import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_RELATIVE_DB_PATH = path.join('.data', 'fps-gods.sqlite');

export function resolveDatabaseConfig(options = {}) {
  if (typeof options.dbPath === 'string' && options.dbPath.trim()) {
    const explicit = options.dbPath.trim();
    return {
      dbPath: explicit,
      mode: explicit === ':memory:' ? 'memory' : 'explicit-path',
      durableConfigured: explicit !== ':memory:',
    };
  }
  const envPath = (process.env.DATABASE_PATH || process.env.SQLITE_DB_PATH || '').trim();
  if (envPath) {
    return {
      dbPath: envPath,
      mode: envPath === ':memory:' ? 'memory' : 'configured-volume',
      durableConfigured: envPath !== ':memory:',
    };
  }
  const isTestRunner = process.execArgv.includes('--test') || process.env.NODE_ENV === 'test';
  if (isTestRunner) {
    return {
      dbPath: ':memory:',
      mode: 'memory',
      durableConfigured: false,
    };
  }
  return {
    dbPath: path.resolve(process.cwd(), DEFAULT_RELATIVE_DB_PATH),
    mode: 'local-sqlite',
    durableConfigured: false,
  };
}

export class GameDatabase {
  constructor(options = {}) {
    this.config = resolveDatabaseConfig(options);
    if (this.config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.config.dbPath);
    this.closed = false;
    this.inTransaction = false;
    this.initSchema();
  }

  initSchema() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.config.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
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
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
