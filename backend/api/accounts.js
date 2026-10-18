'use strict';

// /api/accounts: create, read, update and delete accounts.
//
// Mirrors the frontend rules: six account types, names unique ignoring case,
// `balance` is the INITIAL balance (>= 0), and an account that transactions
// use cannot be deleted.

const crypto = require('node:crypto');
const { getDb } = require('../db');
const { ApiError, ok, toMinor, fromMinor } = require('./common');
const v = require('./validate');

const ACCOUNT_TYPES = ['cash', 'bank', 'online', 'asset', 'receivable', 'payable'];
// Only these can hold transactions (same rule as the frontend's getMoneyAccounts()).
const MONEY_TYPES = ['cash', 'bank', 'online'];

// `current_minor` repeats the frontend's getAccountBalance():
// initial balance + income - expense for this account.
const SELECT_ACCOUNTS = `
  SELECT a.id, a.name, a.type, a.balance_minor,
         a.balance_minor + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount_minor ELSE -t.amount_minor END), 0)
           AS current_minor
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
`;

function toAccount(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    balance: fromMinor(row.balance_minor), // the initial balance, as stored by the frontend
    currentBalance: fromMinor(row.current_minor) // read-only, calculated on every read
  };
}

function findAccount(id) {
  const row = getDb().prepare(`${SELECT_ACCOUNTS} WHERE a.id = ? GROUP BY a.id`).get(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No account with this id.');
  return toAccount(row);
}

function countTransactions(accountId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(accountId).n;
}

// The database already enforces uniqueness with NOCASE, which only knows
// English letters. Comparing with toLowerCase() as well matches what the
// frontend does for other alphabets. The table is tiny, so scanning it is fine.
function nameTaken(name, exceptId) {
  const wanted = name.toLowerCase();
  return getDb()
    .prepare('SELECT id, name FROM accounts')
    .all()
    .some(row => row.id !== exceptId && row.name.toLowerCase() === wanted);
}

// Checks the body and returns clean values. `isCreate` also allows an optional id.
function readBody(body, isCreate) {
  const errors = [];
  v.rejectUnknownFields(body, isCreate ? ['id', 'name', 'type', 'balance'] : ['name', 'type', 'balance'], errors);

  const clean = {
    id: isCreate ? v.optionalId(body, 'id', errors) : undefined,
    name: v.text(body, 'name', errors, { max: 40 }),
    type: v.oneOf(body, 'type', errors, ACCOUNT_TYPES),
    balance: v.money(body, 'balance', errors, { allowZero: true })
  };
  v.throwIfInvalid(errors);
  return clean;
}

function list() {
  const rows = getDb().prepare(`${SELECT_ACCOUNTS} GROUP BY a.id ORDER BY a.rowid`).all();
  return ok(rows.map(toAccount));
}

function get({ params }) {
  return ok(findAccount(v.textIdParam(params.id)));
}

function create({ body }) {
  const input = readBody(body, true);
  const id = input.id || `acc-${crypto.randomUUID()}`;

  if (getDb().prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) {
    throw new ApiError(409, 'CONFLICT', 'An account with this id already exists.');
  }
  if (nameTaken(input.name)) {
    throw new ApiError(409, 'CONFLICT', `An account named "${input.name}" already exists.`);
  }

  getDb()
    .prepare('INSERT INTO accounts (id, name, type, balance_minor) VALUES (?, ?, ?, ?)')
    .run(id, input.name, input.type, toMinor(input.balance));

  return ok(findAccount(id), 201, { Location: `/api/accounts/${id}` });
}

// PUT replaces the account's editable fields (name, type, balance).
function update({ params, body }) {
  const id = v.textIdParam(params.id);
  findAccount(id); // 404 if missing
  const input = readBody(body, false);

  if (nameTaken(input.name, id)) {
    throw new ApiError(409, 'CONFLICT', `An account named "${input.name}" already exists.`);
  }

  // Transactions may only use cash/bank/online accounts, so an account that has
  // transactions cannot be switched to a type that cannot hold them.
  const used = countTransactions(id);
  if (used > 0 && !MONEY_TYPES.includes(input.type)) {
    throw new ApiError(
      409,
      'IN_USE',
      `"${input.name}" has ${v.pluralize(used, 'transaction')}, so its type must stay cash, bank or online.`
    );
  }

  getDb()
    .prepare('UPDATE accounts SET name = ?, type = ?, balance_minor = ? WHERE id = ?')
    .run(input.name, input.type, toMinor(input.balance), id);

  return ok(findAccount(id));
}

function remove({ params }) {
  const id = v.textIdParam(params.id);
  const account = findAccount(id);

  // Never cascade-delete financial records (the frontend does not either).
  const used = countTransactions(id);
  if (used > 0) {
    throw new ApiError(
      409,
      'IN_USE',
      `"${account.name}" is used by ${v.pluralize(used, 'transaction')} and cannot be deleted.`
    );
  }

  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return ok({ id });
}

const routes = {
  '/api/accounts': { GET: list, POST: create },
  '/api/accounts/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, ACCOUNT_TYPES, MONEY_TYPES };
