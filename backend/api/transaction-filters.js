'use strict';

// Reads and validates the transaction filters in a URL query string, and turns
// them into a parameterized SQL WHERE clause. Shared by
//   GET /api/transactions  (the filtered list)  and
//   GET /api/summary       (totals for the same filters).
//
// Filters (all optional, combined with AND; an empty value counts as absent):
//   type        income | expense
//   categoryId  a category id
//   category    a category name (exact match; the frontend's dropdown uses names)
//   accountId   an account id
//   from, to    YYYY-MM-DD, both inclusive
//   search      text, matched ignoring case anywhere in the description,
//               category name, note, account name or amount (the same fields
//               the frontend's search box has always looked at)
//   limit, offset  paging (only where the endpoint allows them)
//
// Every value reaches the database as a $n parameter. Nothing from the URL is
// ever pasted into the SQL text; the only SQL strings built here are constant
// fragments.

const { ApiError } = require('./common');
const { MAX_CATEGORY_ID } = require('./categories');

const FILTER_FIELDS = ['type', 'categoryId', 'category', 'accountId', 'from', 'to', 'search'];
const PAGING_FIELDS = ['limit', 'offset'];
const MAX_LIMIT = 500;
const MAX_TEXT = 100;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date (2025-02-30 is rejected). Unlike a transaction's own
// date, a filter date may be in the future.
function isRealDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900
    && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

// `query` is req.query. Returns the clean values (only the filters that were
// given). Throws 400 VALIDATION_ERROR listing every problem.
function readFilters(query, { paging = false } = {}) {
  const errors = [];
  const allowed = paging ? [...FILTER_FIELDS, ...PAGING_FIELDS] : FILTER_FIELDS;
  const clean = {};

  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) {
      errors.push({ field: key, message: 'Unknown parameter.' });
    }
  }

  // Returns the value as a string, or undefined when absent/empty.
  const given = field => {
    const value = query[field];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') {
      errors.push({ field, message: 'Must be given only once, as plain text.' });
      return undefined;
    }
    return value;
  };

  const type = given('type');
  if (type !== undefined) {
    if (type === 'income' || type === 'expense') clean.type = type;
    else errors.push({ field: 'type', message: 'Must be one of: income, expense.' });
  }

  const categoryId = given('categoryId');
  if (categoryId !== undefined) {
    if (/^[1-9]\d{0,9}$/.test(categoryId) && Number(categoryId) <= MAX_CATEGORY_ID) clean.categoryId = Number(categoryId);
    else errors.push({ field: 'categoryId', message: 'Must be a positive whole number.' });
  }

  const category = given('category');
  if (category !== undefined) {
    if (category.length <= MAX_TEXT) clean.category = category;
    else errors.push({ field: 'category', message: `Must be at most ${MAX_TEXT} characters.` });
  }

  const accountId = given('accountId');
  if (accountId !== undefined) {
    if (ID_PATTERN.test(accountId)) clean.accountId = accountId;
    else errors.push({ field: 'accountId', message: 'Must be a valid account id.' });
  }

  for (const field of ['from', 'to']) {
    const value = given(field);
    if (value === undefined) continue;
    if (isRealDate(value)) clean[field] = value;
    else errors.push({ field, message: 'Must be a real calendar date in YYYY-MM-DD format.' });
  }
  if (clean.from && clean.to && clean.from > clean.to) {
    errors.push({ field: 'to', message: 'Must not be before "from".' });
  }

  const search = given('search');
  if (search !== undefined && search.trim() !== '') {
    if (search.trim().length <= MAX_TEXT) clean.search = search.trim();
    else errors.push({ field: 'search', message: `Must be at most ${MAX_TEXT} characters.` });
  }

  if (paging) {
    const limit = given('limit');
    if (limit !== undefined) {
      if (/^[1-9]\d{0,3}$/.test(limit) && Number(limit) <= MAX_LIMIT) clean.limit = Number(limit);
      else errors.push({ field: 'limit', message: `Must be a whole number from 1 to ${MAX_LIMIT}.` });
    }
    const offset = given('offset');
    if (offset !== undefined) {
      if (/^(0|[1-9]\d{0,8})$/.test(offset)) clean.offset = Number(offset);
      else errors.push({ field: 'offset', message: 'Must be a whole number, 0 or more.' });
    }
  }

  if (errors.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains invalid data.', errors);
  }
  return clean;
}

// The tables every filtered query reads. Each transaction has exactly one
// category and one account (foreign keys), so the joins never drop rows.
const FROM_FILTERED = `
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  JOIN accounts a ON a.id = t.account_id
`;

// Builds { where, params } for the clean filters. `where` is '' or
// 'WHERE ... AND ...'; its $1, $2, ... match `params`.
function buildWhere(filters) {
  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (filters.type !== undefined) add('t.type = ?', filters.type);
  if (filters.categoryId !== undefined) add('t.category_id = ?', filters.categoryId);
  if (filters.category !== undefined) add('c.name = ?', filters.category);
  if (filters.accountId !== undefined) add('t.account_id = ?', filters.accountId);
  if (filters.from !== undefined) add('t.date >= ?', filters.from);
  if (filters.to !== undefined) add('t.date <= ?', filters.to);
  if (filters.search !== undefined) {
    // position() is a plain substring test, so % and _ in the search text are
    // ordinary characters. The amount is written the way JavaScript's String()
    // writes it (12.5, not 12.50).
    add(
      `position(lower(?) in lower(concat_ws(' ', t.description, c.name, t.note, a.name, ` +
        `trim_scale(t.amount_minor::numeric / 100)::text))) > 0`,
      filters.search
    );
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

module.exports = { readFilters, buildWhere, FROM_FILTERED, MAX_LIMIT };
