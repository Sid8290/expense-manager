'use strict';

// GET /api/export: a read-only snapshot of all financial data in the database,
// as one JSON document. The three lists are read inside ONE read-only
// REPEATABLE READ transaction, so they all come from the same snapshot of the
// database: a transaction saved while the export runs is in all three lists or
// in none (it can never appear without its category or account).
//
// The records are exactly what the normal list endpoints return:
//   accounts      { id, name, type, balance, currentBalance }  (currentBalance is calculated)
//   categories    { id, name, type }
//   transactions  { id, type, description, categoryId, category, accountId, amount, note, date, createdAt }
//
// This file is for backups, inspection and verification. It is NOT a format the
// importer accepts (the importer only reads backups of the previous, browser-only
// version), and nothing here claims otherwise.

const db = require('../db');
const { ok } = require('./common');
const { allAccounts } = require('./accounts');
const { allCategories } = require('./categories');
const { allTransactions } = require('./transactions');

const EXPORT_FORMAT = 'expense-manager-database-export';
const EXPORT_VERSION = 1;

async function exportData() {
  // SET TRANSACTION must be the first statement after BEGIN.
  const data = await db.runInTransaction(async () => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return {
      accounts: await allAccounts(),
      categories: await allCategories(),
      transactions: await allTransactions()
    };
  });

  return ok({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      accounts: data.accounts.length,
      categories: data.categories.length,
      transactions: data.transactions.length
    },
    data
  });
}

const routes = {
  '/api/export': { GET: exportData }
};

module.exports = { routes, EXPORT_FORMAT, EXPORT_VERSION };
