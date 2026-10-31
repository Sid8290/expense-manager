'use strict';

// Builds a legacy SQLite database (the schema of the old version of this app,
// "user_version 2") for the SQLite-to-PostgreSQL migration tests. The SQL is a
// copy of the old backend/db.js migrations; the tool under test never creates
// or changes SQLite files, so the tests need their own way to make one.
// node:sqlite is a built-in module (Node.js 22.13+); nothing is installed.

const { DatabaseSync } = require('node:sqlite');

const LEGACY_SCHEMA = `
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    FOREIGN KEY (category_id, type) REFERENCES categories (id, type) ON DELETE RESTRICT
  );
  CREATE INDEX idx_transactions_account  ON transactions (account_id);
  CREATE INDEX idx_transactions_category ON transactions (category_id);
  CREATE INDEX idx_transactions_date     ON transactions (date DESC, created_at DESC);
`;

// accounts: { id, name, type, balance_minor }, categories: { id, name, type },
// transactions: { id, type, description, category_id, account_id, amount_minor, note, date, created_at }
function createLegacyDb(filePath, { accounts = [], categories = [], transactions = [], userVersion = 2, foreignKeys = true } = {}) {
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  sqlite.exec(LEGACY_SCHEMA);

  const insertAccount = sqlite.prepare('INSERT INTO accounts (id, name, type, balance_minor) VALUES (?, ?, ?, ?)');
  const insertCategory = sqlite.prepare('INSERT INTO categories (id, name, type) VALUES (?, ?, ?)');
  const insertTransaction = sqlite.prepare(
    'INSERT INTO transactions (id, type, description, category_id, account_id, amount_minor, note, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  accounts.forEach(a => insertAccount.run(a.id, a.name, a.type, a.balance_minor));
  categories.forEach(c => insertCategory.run(c.id, c.name, c.type));
  transactions.forEach(t => insertTransaction.run(
    t.id, t.type, t.description, t.category_id, t.account_id, t.amount_minor, t.note ?? '', t.date, t.created_at
  ));

  sqlite.exec(`PRAGMA user_version = ${userVersion}`);
  sqlite.close();
  return filePath;
}

module.exports = { createLegacyDb };
