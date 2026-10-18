'use strict';

// SQLite connection management for the Expense Manager backend.
//
// This module owns the single database connection. Other modules call
// getDb() to use it, and server.js calls initDatabase() once at startup and
// closeDatabase() at shutdown.
//
// We use Node's built-in `node:sqlite` module, so there is nothing to install.
// It is synchronous, which keeps the code simple for a small local app.

const fs = require('node:fs');
const path = require('node:path');

// Runtime data lives in backend/data/ (ignored by Git). EXPENSE_DB_PATH lets
// tests (or you) point at a different file.
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'expense-manager.db');

// Schema changes are a list of numbered steps. The database remembers the
// last step it ran in SQLite's built-in `user_version` field, so each step runs
// exactly once. Later stages add the real tables by appending to this list.
// Never edit or reorder a step that has already shipped; add a new one instead.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO app_meta (key, value)
        VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
    `
  },
  {
    // Stage 2: the financial tables. They start EMPTY (nothing is seeded).
    //
    // Money is stored as whole minor units (paise/cents) in INTEGER columns,
    // e.g. 12.34 is stored as 1234. Floating point cannot represent most
    // decimals exactly, so sums of REAL columns can drift. The API converts
    // to and from the decimal numbers the frontend uses.
    //
    // The CHECK constraints repeat the API's validation rules on purpose: the
    // API gives friendly messages, the database guarantees that bad data can
    // never be stored even if a bug lets it through.
    version: 2,
    sql: `
      CREATE TABLE accounts (
        id            TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        name          TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 40),
        type          TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'online', 'asset', 'receivable', 'payable')),
        balance_minor INTEGER NOT NULL CHECK (balance_minor BETWEEN 0 AND 100000000000)
      );

      CREATE TABLE categories (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 30),
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        UNIQUE (type, name),
        -- Needed so transactions can point at (id, type) together (see below).
        UNIQUE (id, type)
      );

      CREATE TABLE transactions (
        id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        description  TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 100),
        category_id  INTEGER NOT NULL,
        account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000000),
        note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
        date         TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        created_at   INTEGER NOT NULL CHECK (created_at >= 0),
        -- The reference includes the type, so the database itself guarantees an
        -- income transaction can only use an income category (and vice versa),
        -- and that a category cannot change type while transactions use it.
        FOREIGN KEY (category_id, type) REFERENCES categories (id, type) ON DELETE RESTRICT
      );

      CREATE INDEX idx_transactions_account  ON transactions (account_id);
      CREATE INDEX idx_transactions_category ON transactions (category_id);
      CREATE INDEX idx_transactions_date     ON transactions (date DESC, created_at DESC);
    `
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

let db = null;

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (error) {
    throw new Error(
      'The built-in node:sqlite module is not available. Use Node.js 22.13 or newer ' +
        `(you are running ${process.version}).`
    );
  }
}

function readPragma(connection, name) {
  const row = connection.prepare(`PRAGMA ${name}`).get();
  return row[name];
}

function applyMigrations(connection) {
  const current = readPragma(connection, 'user_version');

  if (current > LATEST_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this app understands (${LATEST_VERSION}).`
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    // A transaction makes each step all-or-nothing: if the SQL fails halfway,
    // nothing is kept and the version number does not move.
    connection.exec('BEGIN');
    try {
      connection.exec(migration.sql);
      connection.exec(`PRAGMA user_version = ${migration.version}`);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
}

// Opens (creating if needed) the database and brings the schema up to date.
// Throws if anything goes wrong, so the server never starts with a broken DB.
function initDatabase(dbPath = process.env.EXPENSE_DB_PATH || DEFAULT_DB_PATH) {
  if (db) return db;

  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const connection = new DatabaseSync(dbPath);

  try {
    // SQLite does NOT enforce foreign keys unless this is switched on for each
    // connection. We read it back to be sure it took effect.
    connection.exec('PRAGMA foreign_keys = ON');
    if (readPragma(connection, 'foreign_keys') !== 1) {
      throw new Error('Could not enable SQLite foreign key enforcement.');
    }

    applyMigrations(connection);
  } catch (error) {
    connection.close();
    throw error;
  }

  db = connection;
  return db;
}

// Later stages use this to run queries.
function getDb() {
  if (!db) {
    throw new Error('Database is not initialized. Call initDatabase() first.');
  }
  return db;
}

// Reports the real, current state by actually querying the database,
// rather than trusting a flag that was set at startup.
function getStatus() {
  const status = { ready: false, engine: 'node:sqlite' };
  if (!db) return status;

  try {
    db.prepare('SELECT 1').get();
    status.schemaVersion = readPragma(db, 'user_version');
    status.foreignKeys = readPragma(db, 'foreign_keys') === 1;
    status.ready = true;
  } catch (error) {
    status.ready = false;
  }
  return status;
}

// Safe to call more than once.
function closeDatabase() {
  if (!db) return;
  const connection = db;
  db = null;
  connection.close();
}

module.exports = { initDatabase, getDb, getStatus, closeDatabase, DEFAULT_DB_PATH, LATEST_VERSION };
