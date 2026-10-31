'use strict';

// /api/categories: create, read, update and delete categories.
//
// The frontend identifies a category by (name, type); the database gives each
// one a numeric id so that transactions can reference it safely and so a
// category can be renamed. Names are unique per type, ignoring case.

const db = require('../db');
const { ApiError, ok } = require('./common');
const v = require('./validate');

const CATEGORY_TYPES = ['income', 'expense'];

// Category ids are a 32-bit integer column. The URL validator accepts longer
// numbers, and PostgreSQL would answer a lookup for one with a "value out of
// range" error, so such ids are treated as "no such category" before querying.
const MAX_CATEGORY_ID = 2147483647;

function toCategory(row) {
  return { id: row.id, name: row.name, type: row.type };
}

async function findCategory(id) {
  const { rows } = id > MAX_CATEGORY_ID ? { rows: [] } : await db.query('SELECT id, name, type FROM categories WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No category with this id.');
  return toCategory(row);
}

async function countTransactions(categoryId) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM transactions WHERE category_id = $1', [categoryId]);
  return rows[0].n;
}

// Same idea as accounts.js: also compare with toLowerCase() to match the frontend.
async function nameTaken(name, type, exceptId) {
  const wanted = name.toLowerCase();
  const { rows } = await db.query('SELECT id, name FROM categories WHERE type = $1', [type]);
  return rows.some(row => row.id !== exceptId && row.name.toLowerCase() === wanted);
}

function readBody(body) {
  const errors = [];
  v.rejectUnknownFields(body, ['name', 'type'], errors);

  const clean = {
    name: v.text(body, 'name', errors, { max: 30 }),
    type: v.oneOf(body, 'type', errors, CATEGORY_TYPES)
  };
  v.throwIfInvalid(errors);
  return clean;
}

async function allCategories() {
  const { rows } = await db.query('SELECT id, name, type FROM categories ORDER BY id');
  return rows.map(toCategory);
}

async function list() {
  return ok(await allCategories());
}

// Writes one category and returns its new numeric id (INSERT ... RETURNING).
// The caller has already validated it (readBody) and checked that the name is free.
async function insertCategory(input) {
  const { rows } = await db.query(
    'INSERT INTO categories (name, type) VALUES ($1, $2) RETURNING id',
    [input.name, input.type]
  );
  return rows[0].id;
}

async function get({ params }) {
  return ok(await findCategory(v.numericIdParam(params.id)));
}

async function create({ body }) {
  const input = readBody(body);

  return db.runInTransaction(async () => {
    if (await nameTaken(input.name, input.type)) {
      throw new ApiError(409, 'CONFLICT', `The ${input.type} category "${input.name}" already exists.`);
    }

    const id = await insertCategory(input);

    return ok(await findCategory(id), 201, { Location: `/api/categories/${id}` });
  });
}

// PUT replaces name and type. Renaming is always allowed (transactions point
// at the id, so they follow the new name). Changing the TYPE is refused while
// transactions use the category, because their type must match it.
async function update({ params, body }) {
  const id = v.numericIdParam(params.id);

  return db.runInTransaction(async () => {
    const current = await findCategory(id);
    const input = readBody(body);

    if (await nameTaken(input.name, input.type, id)) {
      throw new ApiError(409, 'CONFLICT', `The ${input.type} category "${input.name}" already exists.`);
    }

    const used = await countTransactions(id);
    if (used > 0 && input.type !== current.type) {
      throw new ApiError(
        409,
        'IN_USE',
        `"${current.name}" is used by ${v.pluralize(used, 'transaction')}, so its type cannot be changed.`
      );
    }

    await db.query('UPDATE categories SET name = $1, type = $2 WHERE id = $3', [input.name, input.type, id]);
    return ok(await findCategory(id));
  });
}

async function remove({ params }) {
  const id = v.numericIdParam(params.id);

  return db.runInTransaction(async () => {
    const category = await findCategory(id);

    const used = await countTransactions(id);
    if (used > 0) {
      throw new ApiError(
        409,
        'IN_USE',
        `"${category.name}" is used by ${v.pluralize(used, 'transaction')} and cannot be deleted.`
      );
    }

    await db.query('DELETE FROM categories WHERE id = $1', [id]);
    return ok({ id });
  });
}

const routes = {
  '/api/categories': { GET: list, POST: create },
  '/api/categories/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, CATEGORY_TYPES, MAX_CATEGORY_ID, readBody, nameTaken, insertCategory, allCategories };
