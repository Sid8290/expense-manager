'use strict';

// GET /api/export: a read-only snapshot of all financial data in the database,
// as one JSON document. The three lists are read in one go, so they are
// consistent with each other.
//
// The records are exactly what the normal list endpoints return:
//   accounts      { id, name, type, balance, currentBalance }  (currentBalance is calculated)
//   categories    { id, name, type }
//   transactions  { id, type, description, categoryId, category, accountId, amount, note, date, createdAt }
//
// This file is for backups, inspection and verification. It is NOT a format the
// importer accepts (the importer only reads backups of the previous, browser-only
// version), and nothing here claims otherwise.

const { ok } = require('./common');
const { allAccounts } = require('./accounts');
const { allCategories } = require('./categories');
const { allTransactions } = require('./transactions');

const EXPORT_FORMAT = 'expense-manager-database-export';
const EXPORT_VERSION = 1;

function exportData() {
  const data = {
    accounts: allAccounts(),
    categories: allCategories(),
    transactions: allTransactions()
  };

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
