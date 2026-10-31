'use strict';

// GET /api/summary: financial totals for the transactions that match the same
// filters as GET /api/transactions (type, categoryId, category, accountId,
// from, to, search; limit and offset are not allowed here).
//
//   {
//     filters:    the filters that were applied,
//     totals:     { count, income, expense, balance }       balance = income - expense
//     byCategory: [{ categoryId, category, type, total, count }]   biggest total first
//     byMonth:    [{ month: "2026-10", income, expense, balance, count }]   oldest first
//   }
//
// The calculation is done by PostgreSQL on whole minor units (paise), so sums
// are exact. All three parts are read in one read-only REPEATABLE READ
// transaction, so they describe the same snapshot and always agree with each
// other.

const db = require('../db');
const { ok, fromMinor } = require('./common');
const { readFilters, buildWhere, FROM_FILTERED } = require('./transaction-filters');

const INCOME_SUM = `COALESCE(SUM(t.amount_minor) FILTER (WHERE t.type = 'income'), 0)::bigint`;
const EXPENSE_SUM = `COALESCE(SUM(t.amount_minor) FILTER (WHERE t.type = 'expense'), 0)::bigint`;

async function summary({ req }) {
  const filters = readFilters(req.query);
  const { where, params } = buildWhere(filters);

  const result = await db.runInTransaction(async () => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const totals = await db.query(
      `SELECT COUNT(*) AS count, ${INCOME_SUM} AS income, ${EXPENSE_SUM} AS expense ${FROM_FILTERED} ${where}`,
      params
    );
    const categories = await db.query(
      `SELECT c.id, c.name, t.type, SUM(t.amount_minor)::bigint AS total, COUNT(*) AS count
       ${FROM_FILTERED} ${where}
       GROUP BY c.id, c.name, t.type
       ORDER BY total DESC, c.name ASC, c.id ASC`,
      params
    );
    const months = await db.query(
      `SELECT substr(t.date, 1, 7) AS month, ${INCOME_SUM} AS income, ${EXPENSE_SUM} AS expense, COUNT(*) AS count
       ${FROM_FILTERED} ${where}
       GROUP BY substr(t.date, 1, 7)
       ORDER BY month ASC`,
      params
    );
    return { totals: totals.rows[0], categories: categories.rows, months: months.rows };
  });

  const { totals } = result;
  return ok({
    filters,
    totals: {
      count: totals.count,
      income: fromMinor(totals.income),
      expense: fromMinor(totals.expense),
      balance: fromMinor(totals.income - totals.expense)
    },
    byCategory: result.categories.map(row => ({
      categoryId: row.id,
      category: row.name,
      type: row.type,
      total: fromMinor(row.total),
      count: row.count
    })),
    byMonth: result.months.map(row => ({
      month: row.month,
      income: fromMinor(row.income),
      expense: fromMinor(row.expense),
      balance: fromMinor(row.income - row.expense),
      count: row.count
    }))
  });
}

const routes = {
  '/api/summary': { GET: summary }
};

module.exports = { routes };
