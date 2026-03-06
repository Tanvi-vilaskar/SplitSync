// src/db/migrate.js — Full schema including v2 features

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/snapbudget.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = `
  -- ─── Core Tables ─────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT NOT NULL,
    last_name   TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS groups (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL,
    type          TEXT NOT NULL,
    default_currency TEXT DEFAULT 'INR',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id  INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    user_id   INTEGER REFERENCES users(id)  ON DELETE CASCADE,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id               TEXT PRIMARY KEY,
    group_id         INTEGER REFERENCES groups(id),
    payer_id         INTEGER REFERENCES users(id),
    trip_id          INTEGER REFERENCES trips(id),
    merchant         TEXT,
    total_amount     REAL NOT NULL,
    currency         TEXT DEFAULT 'INR',
    amount_inr       REAL,
    category         TEXT DEFAULT 'Other',
    ocr_raw          TEXT,
    image_file_id    TEXT,
    split_message_id INTEGER,
    status           TEXT DEFAULT 'pending',
    created_at       TEXT DEFAULT (datetime('now')),
    settled_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS receipt_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id  TEXT REFERENCES receipts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    amount      REAL NOT NULL,
    is_tax      INTEGER DEFAULT 0,
    is_discount INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS item_assignments (
    item_id  INTEGER REFERENCES receipt_items(id) ON DELETE CASCADE,
    user_id  INTEGER REFERENCES users(id),
    PRIMARY KEY (item_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS splits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id        TEXT REFERENCES receipts(id) ON DELETE CASCADE,
    debtor_id         INTEGER REFERENCES users(id),
    creditor_id       INTEGER REFERENCES users(id),
    amount            REAL NOT NULL,
    currency          TEXT DEFAULT 'INR',
    status            TEXT DEFAULT 'pending',
    paid_at           TEXT,
    payment_charge_id TEXT,
    nudge_count       INTEGER DEFAULT 0,
    last_nudged_at    TEXT,
    UNIQUE(receipt_id, debtor_id, creditor_id)
  );

  -- ─── Trip Mode ───────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS trips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id),
    status      TEXT DEFAULT 'active',
    currency    TEXT DEFAULT 'INR',
    started_at  TEXT DEFAULT (datetime('now')),
    ended_at    TEXT
  );

  -- ─── Recurring Splits ─────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS recurring_splits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    created_by  INTEGER REFERENCES users(id),
    name        TEXT NOT NULL,
    amount      REAL NOT NULL,
    currency    TEXT DEFAULT 'INR',
    frequency   TEXT NOT NULL,
    next_run    TEXT NOT NULL,
    member_ids  TEXT NOT NULL,
    payer_id    INTEGER REFERENCES users(id),
    active      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- ─── Nudge Schedule ──────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS nudge_schedule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    split_id    INTEGER REFERENCES splits(id) ON DELETE CASCADE,
    group_id    INTEGER REFERENCES groups(id),
    debtor_id   INTEGER REFERENCES users(id),
    creditor_id INTEGER REFERENCES users(id),
    amount      REAL NOT NULL,
    send_at     TEXT NOT NULL,
    sent        INTEGER DEFAULT 0,
    sent_at     TEXT
  );

  -- ─── Currency Cache ───────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS exchange_rates (
    base        TEXT NOT NULL,
    target      TEXT NOT NULL,
    rate        REAL NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (base, target)
  );

  -- ─── Budget Tracker ─────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS budgets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    category      TEXT NOT NULL,
    limit_amount  REAL NOT NULL,
    month         TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, category, month)
  );

  -- Add upi_id to users if not exists
  ALTER TABLE users ADD COLUMN upi_id TEXT;

  -- ─── Money Memory ───────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS relationship_stats (
    user_a              INTEGER REFERENCES users(id),
    user_b              INTEGER REFERENCES users(id),
    total_transactions  INTEGER DEFAULT 0,
    total_amount_ab     REAL    DEFAULT 0,
    total_settled       INTEGER DEFAULT 0,
    settlements_count   INTEGER DEFAULT 0,
    avg_days_to_settle  REAL,
    last_transaction    TEXT    DEFAULT (datetime('now')),
    last_settled_at     TEXT,
    PRIMARY KEY (user_a, user_b)
  );

  -- ─── Expense Oracle ───────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS oracle_predictions (
    user_id         INTEGER REFERENCES users(id),
    month           TEXT    NOT NULL,
    prediction_text TEXT    NOT NULL,
    created_at      TEXT    DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, month)
  );

  -- ─── Indexes ─────────────────────────────────────────────────────────────────

  CREATE INDEX IF NOT EXISTS idx_receipts_group    ON receipts(group_id);
  CREATE INDEX IF NOT EXISTS idx_receipts_trip     ON receipts(trip_id);
  CREATE INDEX IF NOT EXISTS idx_splits_debtor     ON splits(debtor_id);
  CREATE INDEX IF NOT EXISTS idx_splits_status     ON splits(status);
  CREATE INDEX IF NOT EXISTS idx_nudge_send_at     ON nudge_schedule(send_at, sent);
  CREATE INDEX IF NOT EXISTS idx_recurring_next    ON recurring_splits(next_run, active);
  CREATE INDEX IF NOT EXISTS idx_trips_group       ON trips(group_id, status);
`;

db.transaction(() => { db.exec(schema); })();
console.log('✅ Database migrated successfully (v2)');
db.close();
