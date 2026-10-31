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
const db = require('../db');
const { ApiError, ok, toMinor, fromMinor } = require('./common');
const v = require('./validate');
const { MONEY_TYPES } = require('./accounts');
const { CATEGORY_TYPES, MAX_CATEGORY_ID } = require('./categories');
const { readFilters, buildWhere, FROM_FILTERED } = require('./transaction-filters');

// Same order the frontend shows: newest date first, then newest created.
// seq (an identity column) keeps ties in the order they were inserted.
const SELECT_TRANSACTIONS = `
  SELECT t.id, t.type, t.description, t.category_id, c.name AS category_name,
         t.account_id, t.amount_minor, t.note, t.date, t.created_at
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
`;
// The same columns, read through the joins the filters need (see FROM_FILTERED).
const SELECT_TRANSACTIONS_FILTERED = `
  SELECT t.id, t.type, t.description, t.category_id, c.name AS category_name,
         t.account_id, t.amount_minor, t.note, t.date, t.created_at
  ${FROM_FILTERED}
`;
const ORDER_NEWEST = 'ORDER BY t.date DESC, t.created_at DESC, t.seq ASC';

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

async function findTransaction(id) {
  const { rows } = await db.query(`${SELECT_TRANSACTIONS} WHERE t.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No transaction with this id.');
  return toTransaction(row);
}

// Validates the body. Reference checks (does the account/category exist, do
// the types fit) only run for fields that passed the basic checks, and add
// their problems to the same `errors` list.
async function readBody(body, isCreate) {
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

  if (clean.categoryId !== undefined) {
    // Ids beyond the 32-bit column cannot exist (and PostgreSQL would raise a range error).
    const { rows } = clean.categoryId > MAX_CATEGORY_ID
      ? { rows: [] }
      : await db.query('SELECT type FROM categories WHERE id = $1', [clean.categoryId]);
    const category = rows[0];
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
    const { rows } = await db.query('SELECT type FROM accounts WHERE id = $1', [clean.accountId]);
    const account = rows[0];
    if (!account) {
      errors.push({ field: 'accountId', message: 'No account with this id.' });
    } else if (!MONEY_TYPES.includes(account.type)) {
      errors.push({ field: 'accountId', message: 'Transactions can only use cash, bank or online accounts.' });
    }
  }

  v.throwIfInvalid(errors);
  return clean;
}

async function allTransactions() {
  const { rows } = await db.query(`${SELECT_TRANSACTIONS} ${ORDER_NEWEST}`);
  return rows.map(toTransaction);
}

// GET /api/transactions. Without a query string this is the full list, as
// before. The optional filters and paging are described in
// transaction-filters.js; the result keeps the same order either way.
async function list({ req }) {
  const filters = readFilters(req.query, { paging: true });
  const { where, params } = buildWhere(filters);

  let sql = `${SELECT_TRANSACTIONS_FILTERED} ${where} ${ORDER_NEWEST}`;
  if (filters.limit !== undefined) {
    params.push(filters.limit);
    sql += ` LIMIT $${params.length}`;
  }
  if (filters.offset !== undefined) {
    params.push(filters.offset);
    sql += ` OFFSET $${params.length}`;
  }

  const { rows } = await db.query(sql, params);
  return ok(rows.map(toTransaction));
}

// Writes one transaction. The caller has already validated it (readBody,
// which also checks the account and category) and checked that the id is
// free. `input.id` must be set.
async function insertTransaction(input) {
  await db.query(
    `INSERT INTO transactions
       (id, type, description, category_id, account_id, amount_minor, note, date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.type,
      input.description,
      input.categoryId,
      input.accountId,
      toMinor(input.amount),
      input.note,
      input.date,
      input.createdAt ?? Date.now()
    ]
  );
}

async function get({ params }) {
  return ok(await findTransaction(v.textIdParam(params.id)));
}

// The body is checked, the id is checked and the row is written on ONE
// connection inside ONE transaction, so the account and category that were
// validated are the ones the row is saved against. (The foreign keys still
// protect the data if one of them is deleted at the same moment.)
async function create({ body }) {
  return db.runInTransaction(async () => {
    const input = await readBody(body, true);
    const id = input.id || `txn-${crypto.randomUUID()}`;

    const existing = await db.query('SELECT 1 FROM transactions WHERE id = $1', [id]);
    if (existing.rowCount > 0) {
      throw new ApiError(409, 'CONFLICT', 'A transaction with this id already exists.');
    }

    await insertTransaction({ ...input, id });

    return ok(await findTransaction(id), 201, { Location: `/api/transactions/${id}` });
  });
}

// PUT replaces every editable field. The id and createdAt never change.
async function update({ params, body }) {
  const id = v.textIdParam(params.id);

  return db.runInTransaction(async () => {
    await findTransaction(id); // 404 if missing
    const input = await readBody(body, false);

    await db.query(
      `UPDATE transactions
          SET type = $1, description = $2, category_id = $3, account_id = $4,
              amount_minor = $5, note = $6, date = $7
        WHERE id = $8`,
      [
        input.type,
        input.description,
        input.categoryId,
        input.accountId,
        toMinor(input.amount),
        input.note,
        input.date,
        id
      ]
    );

    return ok(await findTransaction(id));
  });
}

async function remove({ params }) {
  const id = v.textIdParam(params.id);

  return db.runInTransaction(async () => {
    await findTransaction(id); // 404 if missing
    await db.query('DELETE FROM transactions WHERE id = $1', [id]);
    return ok({ id });
  });
}

const routes = {
  '/api/transactions': { GET: list, POST: create },
  '/api/transactions/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, readBody, insertTransaction, findTransaction, allTransactions };
