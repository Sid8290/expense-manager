'use strict';

// /api/categories: create, read, update and delete categories.
//
// The frontend identifies a category by (name, type); the database gives each
// one a numeric id so that transactions can reference it safely and so a
// category can be renamed. Names are unique per type, ignoring case.

const { getDb } = require('../db');
const { ApiError, ok } = require('./common');
const v = require('./validate');

const CATEGORY_TYPES = ['income', 'expense'];

function toCategory(row) {
  return { id: row.id, name: row.name, type: row.type };
}

function findCategory(id) {
  const row = getDb().prepare('SELECT id, name, type FROM categories WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No category with this id.');
  return toCategory(row);
}

function countTransactions(categoryId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(categoryId).n;
}

// Same idea as accounts.js: also compare with toLowerCase() to match the frontend.
function nameTaken(name, type, exceptId) {
  const wanted = name.toLowerCase();
  return getDb()
    .prepare('SELECT id, name FROM categories WHERE type = ?')
    .all(type)
    .some(row => row.id !== exceptId && row.name.toLowerCase() === wanted);
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

function list() {
  const rows = getDb().prepare('SELECT id, name, type FROM categories ORDER BY id').all();
  return ok(rows.map(toCategory));
}

function get({ params }) {
  return ok(findCategory(v.numericIdParam(params.id)));
}

function create({ body }) {
  const input = readBody(body);

  if (nameTaken(input.name, input.type)) {
    throw new ApiError(409, 'CONFLICT', `The ${input.type} category "${input.name}" already exists.`);
  }

  const result = getDb()
    .prepare('INSERT INTO categories (name, type) VALUES (?, ?)')
    .run(input.name, input.type);
  const id = Number(result.lastInsertRowid);

  return ok(findCategory(id), 201, { Location: `/api/categories/${id}` });
}

// PUT replaces name and type. Renaming is always allowed (transactions point
// at the id, so they follow the new name). Changing the TYPE is refused while
// transactions use the category, because their type must match it.
function update({ params, body }) {
  const id = v.numericIdParam(params.id);
  const current = findCategory(id);
  const input = readBody(body);

  if (nameTaken(input.name, input.type, id)) {
    throw new ApiError(409, 'CONFLICT', `The ${input.type} category "${input.name}" already exists.`);
  }

  const used = countTransactions(id);
  if (used > 0 && input.type !== current.type) {
    throw new ApiError(
      409,
      'IN_USE',
      `"${current.name}" is used by ${v.pluralize(used, 'transaction')}, so its type cannot be changed.`
    );
  }

  getDb().prepare('UPDATE categories SET name = ?, type = ? WHERE id = ?').run(input.name, input.type, id);
  return ok(findCategory(id));
}

function remove({ params }) {
  const id = v.numericIdParam(params.id);
  const category = findCategory(id);

  const used = countTransactions(id);
  if (used > 0) {
    throw new ApiError(
      409,
      'IN_USE',
      `"${category.name}" is used by ${v.pluralize(used, 'transaction')} and cannot be deleted.`
    );
  }

  getDb().prepare('DELETE FROM categories WHERE id = ?').run(id);
  return ok({ id });
}

const routes = {
  '/api/categories': { GET: list, POST: create },
  '/api/categories/:id': { GET: get, PUT: update, DELETE: remove }
};

module.exports = { routes, CATEGORY_TYPES };
