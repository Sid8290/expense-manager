'use strict';

// /api/accounts: create, read, update and delete accounts.
//
// Mirrors the frontend rules: six account types, names unique ignoring case,
// `balance` is the INITIAL balance (>= 0), and an account that transactions
// use cannot be deleted.

const crypto = require('node:crypto');
const db = require('../db');
const { ApiError, ok, toMinor, fromMinor } = require('./common');
const v = require('./validate');

const ACCOUNT_TYPES = ['cash', 'bank', 'online', 'asset', 'receivable', 'payable'];
// Only these can hold transactions (same rule as the frontend's getMoneyAccounts()).
const MONEY_TYPES = ['cash', 'bank', 'online'];

// `current_minor` repeats the frontend's getAccountBalance():
// initial balance + income - expense for this account.
const SELECT_ACCOUNTS = `
  SELECT a.id, a.name, a.type, a.balance_minor,
         a.balance_minor + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount_minor ELSE -t.amount_minor END), 0)::bigint
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

async function findAccount(id) {
  const { rows } = await db.query(`${SELECT_ACCOUNTS} WHERE a.id = $1 GROUP BY a.id`, [id]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No account with this id.');
  return toAccount(row);
}

async function countTransactions(accountId) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM transactions WHERE account_id = $1', [accountId]);
  return rows[0].n;
}

// The database also enforces uniqueness (a unique index on lower(name)), whose
// idea of "lower case" depends on the database's locale. Comparing with
// toLowerCase() here matches what the frontend does for other alphabets and
// gives a friendly message; the index is the safety net. The table is tiny, so
// scanning it is fine.
async function nameTaken(name, exceptId) {
  const wanted = name.toLowerCase();
  const { rows } = await db.query('SELECT id, name FROM accounts');
  return rows.some(row => row.id !== exceptId && row.name.toLowerCase() === wanted);
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

async function allAccounts() {
  // seq is the insertion order (what SQLite's hidden rowid used to provide).
  const { rows } = await db.query(`${SELECT_ACCOUNTS} GROUP BY a.id ORDER BY a.seq`);
  return rows.map(toAccount);
}

async function list() {
  return ok(await allAccounts());
}

// Writes one account. The caller has already validated it (readBody) and
// checked that its id and name are free. `input.id` must be set.
async function insertAccount(input) {
  await db.query(
    'INSERT INTO accounts (id, name, type, balance_minor) VALUES ($1, $2, $3, $4)',
    [input.id, input.name, input.type, toMinor(input.balance)]
  );
}

async function get({ params }) {
  return ok(await findAccount(v.textIdParam(params.id)));
}

async function create({ body }) {
  const input = readBody(body, true);
  const id = input.id || `acc-${crypto.randomUUID()}`;

  // One transaction: the checks and the insert use the same connection.
  // (If two requests race past the checks, the database's unique constraints
  // reject the second one and server.js answers 409.)
  return db.runInTransaction(async () => {
    const existing = await db.query('SELECT 1 FROM accounts WHERE id = $1', [id]);
    if (existing.rowCount > 0) {
      throw new ApiError(409, 'CONFLICT', 'An account with this id already exists.');
    }
    if (await nameTaken(input.name)) {
      throw new ApiError(409, 'CONFLICT', `An account named "${input.name}" already exists.`);
    }

    await insertAccount({ ...input, id });

    return ok(await findAccount(id), 201, { Location: `/api/accounts/${id}` });
  });
}

// PUT replaces the account's editable fields (name, type, balance).
async function update({ params, body }) {
  const id = v.textIdParam(params.id);

  return db.runInTransaction(async () => {
    await findAccount(id); // 404 if missing
    const input = readBody(body, false);

    if (await nameTaken(input.name, id)) {
      throw new ApiError(409, 'CONFLICT', `An account named "${input.name}" already exists.`);
    }

    // Transactions may only use cash/bank/online accounts, so an account that has
    // transactions cannot be switched to a type that cannot hold them.
    const used = await countTransactions(id);
    if (used > 0 && !MONEY_TYPES.includes(input.type)) {
      throw new ApiError(
        409,
        'IN_USE',
        `"${input.name}" has ${v.pluralize(used, 'transaction')}, so its type must stay cash, bank or online.`
      );
    }

    await db.query(
      'UPDATE accounts SET name = $1, type = $2, balance_minor = $3 WHERE id = $4',
      [input.name, input.type, toMinor(input.balance), id]
    );

    return ok(await findAccount(id));
  });
}

async function remove({ params }) {
  const id = v.textIdParam(params.id);

  return db.runInTransaction(async () => {
    const account = await findAccount(id);

    // Never cascade-delete financial records (the frontend does not either).
    // The foreign key (ON DELETE RESTRICT) enforces the same rule in the database.
    const used = await countTransactions(id);
    if (used > 0) {
      throw new ApiError(
        409,
        'IN_USE',
        `"${account.name}" is used by ${v.pluralize(used, 'transaction')} and cannot be deleted.`
      );
    }

    await db.query('DELETE FROM accounts WHERE id = $1', [id]);
    return ok({ id });
  });
}

const routes = {
  '/api/accounts': { GET: list, POST: create },
  '/api/accounts/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, ACCOUNT_TYPES, MONEY_TYPES, readBody, nameTaken, insertAccount, allAccounts };
