'use strict';

// /api/transactions: create, read, update and delete transactions.
//
// Rules copied from the frontend: amount > 0 (max 1,000,000,000, 2 decimals),
// date not in the future, the account must be cash/bank/online, and the
// category's type must equal the transaction's type.
//
// A transaction points at its category by id (`categoryId`). Responses also
// include the category's name in `category`, which is what the frontend uses.

const crypto = require('node:crypto');
const { getDb } = require('../db');
const { ApiError, ok, toMinor, fromMinor } = require('./common');
const v = require('./validate');
const { MONEY_TYPES } = require('./accounts');
const { CATEGORY_TYPES } = require('./categories');

// Same order the frontend shows: newest date first, then newest created.
// rowid keeps ties in the order they were inserted.
const SELECT_TRANSACTIONS = `
  SELECT t.id, t.type, t.description, t.category_id, c.name AS category_name,
         t.account_id, t.amount_minor, t.note, t.date, t.created_at
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
`;
const ORDER_NEWEST = 'ORDER BY t.date DESC, t.created_at DESC, t.rowid ASC';

function toTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    description: row.description,
    categoryId: row.category_id,
    category: row.category_name,
    accountId: row.account_id,
    amount: fromMinor(row.amount_minor),
    note: row.note,
    date: row.date,
    createdAt: row.created_at
  };
}

function findTransaction(id) {
  const row = getDb().prepare(`${SELECT_TRANSACTIONS} WHERE t.id = ?`).get(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No transaction with this id.');
  return toTransaction(row);
}

// Validates the body. Reference checks (does the account/category exist, do
// the types fit) only run for fields that passed the basic checks, and add
// their problems to the same `errors` list.
function readBody(body, isCreate) {
  const errors = [];
  const fields = ['type', 'description', 'categoryId', 'accountId', 'amount', 'note', 'date'];
  v.rejectUnknownFields(body, isCreate ? ['id', 'createdAt', ...fields] : fields, errors);

  const clean = {
    id: isCreate ? v.optionalId(body, 'id', errors) : undefined,
    createdAt: isCreate ? v.optionalTimestamp(body, 'createdAt', errors) : undefined,
    type: v.oneOf(body, 'type', errors, CATEGORY_TYPES),
    description: v.text(body, 'description', errors, { max: 100 }),
    categoryId: v.requiredInteger(body, 'categoryId', errors),
    accountId: v.requiredId(body, 'accountId', errors),
    amount: v.money(body, 'amount', errors, { allowZero: false }),
    note: v.text(body, 'note', errors, { max: 200, required: false, defaultValue: '' }),
    date: v.isoDate(body, 'date', errors)
  };

  const db = getDb();

  if (clean.categoryId !== undefined) {
    const category = db.prepare('SELECT type FROM categories WHERE id = ?').get(clean.categoryId);
    if (!category) {
      errors.push({ field: 'categoryId', message: 'No category with this id.' });
    } else if (clean.type !== undefined && category.type !== clean.type) {
      errors.push({
        field: 'categoryId',
        message: `This is an ${category.type} category, but the transaction type is ${clean.type}.`
      });
    }
  }

  if (clean.accountId !== undefined) {
    const account = db.prepare('SELECT type FROM accounts WHERE id = ?').get(clean.accountId);
    if (!account) {
      errors.push({ field: 'accountId', message: 'No account with this id.' });
    } else if (!MONEY_TYPES.includes(account.type)) {
      errors.push({ field: 'accountId', message: 'Transactions can only use cash, bank or online accounts.' });
    }
  }

  v.throwIfInvalid(errors);
  return clean;
}

function allTransactions() {
  return getDb().prepare(`${SELECT_TRANSACTIONS} ${ORDER_NEWEST}`).all().map(toTransaction);
}

function list() {
  return ok(allTransactions());
}

// Writes one transaction. The caller has already validated it (readBody,
// which also checks the account and category) and checked that the id is
// free. `input.id` must be set.
function insertTransaction(input) {
  getDb()
    .prepare(
      `INSERT INTO transactions
         (id, type, description, category_id, account_id, amount_minor, note, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.type,
      input.description,
      input.categoryId,
      input.accountId,
      toMinor(input.amount),
      input.note,
      input.date,
      input.createdAt ?? Date.now()
    );
}

function get({ params }) {
  return ok(findTransaction(v.textIdParam(params.id)));
}

function create({ body }) {
  const input = readBody(body, true);
  const id = input.id || `txn-${crypto.randomUUID()}`;

  if (getDb().prepare('SELECT 1 FROM transactions WHERE id = ?').get(id)) {
    throw new ApiError(409, 'CONFLICT', 'A transaction with this id already exists.');
  }

  insertTransaction({ ...input, id });

  return ok(findTransaction(id), 201, { Location: `/api/transactions/${id}` });
}

// PUT replaces every editable field. The id and createdAt never change.
function update({ params, body }) {
  const id = v.textIdParam(params.id);
  findTransaction(id); // 404 if missing
  const input = readBody(body, false);

  getDb()
    .prepare(
      `UPDATE transactions
          SET type = ?, description = ?, category_id = ?, account_id = ?,
              amount_minor = ?, note = ?, date = ?
        WHERE id = ?`
    )
    .run(
      input.type,
      input.description,
      input.categoryId,
      input.accountId,
      toMinor(input.amount),
      input.note,
      input.date,
      id
    );

  return ok(findTransaction(id));
}

function remove({ params }) {
  const id = v.textIdParam(params.id);
  findTransaction(id); // 404 if missing
  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return ok({ id });
}

const routes = {
  '/api/transactions': { GET: list, POST: create },
  '/api/transactions/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, readBody, insertTransaction, findTransaction, allTransactions };
