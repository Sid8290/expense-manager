'use strict';

// /api/import/preview and /api/import: move the financial records of the
// previous (browser-only) version into the database.
//
// Input is a "legacy backup" object (see docs/API.md): the contents of the old
// localStorage keys em_accounts, em_categories and em_transactions.
//
// How it stays safe
// -----------------
// * ONE SQLite transaction. Every record is processed inside it. If anything
//   unexpected goes wrong, everything is rolled back and nothing is saved.
// * The preview runs exactly the same code and then rolls back. It can
//   therefore never promise something the real import would not do.
// * The real import plans again against the database as it is NOW. A preview
//   made earlier is never trusted.
// * Records are validated with the SAME validators the normal API uses
//   (readBody in accounts.js, categories.js, transactions.js), so the API's
//   rules are the final authority.
// * Nothing existing is ever overwritten. A record whose id already exists is
//   a duplicate (skipped) only if its data is identical; otherwise it is a
//   conflict (rejected). Records are never matched by content alone, so two
//   genuine transactions that look the same but have different ids are both
//   imported.
// * Every record that was written is read back and compared before the
//   transaction is committed.

const { runInTransaction, getDb } = require('../db');
const { ApiError, ok, toMinor } = require('./common');
const accounts = require('./accounts');
const categories = require('./categories');
const transactions = require('./transactions');

const FORMAT = 'expense-manager-legacy-backup';
const DATABASE_EXPORT_FORMAT = 'expense-manager-database-export';
const SUPPORTED_VERSION = 1;
const ENTITIES = ['accounts', 'categories', 'transactions'];

const MAX_RECORDS = { accounts: 500, categories: 500, transactions: 20000 };
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LISTED_ITEMS = 200; // transaction items returned in a report (counts are always complete)

// What the previous version wrote into localStorage the first time it ran
// (copied from DEFAULT_ACCOUNTS and DEFAULT_CATEGORIES in frontend/js/script.js;
// a test keeps the two in step). They are not user data, so unused ones are
// not imported.
const OLD_DEFAULT_ACCOUNTS = [
  { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
  { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 }
];
const OLD_DEFAULT_CATEGORIES = [
  { name: 'Groceries', type: 'expense' },
  { name: 'Bills', type: 'expense' },
  { name: 'Transport', type: 'expense' },
  { name: 'Entertainment', type: 'expense' },
  { name: 'Shopping', type: 'expense' },
  { name: 'Others', type: 'expense' },
  { name: 'Salary', type: 'income' },
  { name: 'Freelance', type: 'income' },
  { name: 'Other Income', type: 'income' }
];

// Possible outcomes for each record.
const IMPORTED = 'imported';
const DUPLICATE_DATABASE = 'duplicate-in-database'; // same id and identical data already stored
const DUPLICATE_FILE = 'duplicate-in-file'; // repeated, identical record inside the import itself
const OLD_DEFAULT = 'old-default-unused';
const REJECTED = 'rejected'; // invalid, or in conflict with something that exists
const UNRESOLVED = 'unresolved-reference'; // refers to an account/category that was not imported

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function categoryKey(type, name) {
  return `${type}\u0000${name.trim().toLowerCase()}`;
}

// The text of an API validation error, for the report.
function reasonFrom(error) {
  if (error instanceof ApiError && Array.isArray(error.details) && error.details.length > 0) {
    return error.details.map(item => `${item.field}: ${item.message}`).join(' ');
  }
  return error instanceof ApiError ? error.message : 'The record could not be validated.';
}

// Runs a validator and returns { value } or { reason } instead of throwing.
function validated(check) {
  try {
    return { value: check() };
  } catch (error) {
    if (error instanceof ApiError) return { reason: reasonFrom(error) };
    throw error;
  }
}

// Groups records that share an id. A group whose records are all identical is
// "the same record twice" (the later ones are duplicates). A group whose
// records differ cannot be resolved without guessing, so ALL of them are
// rejected as ambiguous.
function findRepeatedIds(records, sameData) {
  const groups = new Map();
  records.forEach((record, index) => {
    if (isPlainObject(record) && typeof record.id === 'string') {
      if (!groups.has(record.id)) groups.set(record.id, []);
      groups.get(record.id).push(index);
    }
  });

  const duplicates = new Set();
  const ambiguous = new Set();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const first = records[indexes[0]];
    if (indexes.every(index => sameData(first, records[index]))) {
      indexes.slice(1).forEach(index => duplicates.add(index));
    } else {
      indexes.forEach(index => ambiguous.add(index));
    }
  }
  return { duplicates, ambiguous };
}

const sameAccountData = (a, b) =>
  typeof a.name === 'string' && typeof b.name === 'string' &&
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.type === b.type && a.balance === b.balance;

const sameTransactionData = (a, b) =>
  JSON.stringify(normalizedTransaction(a)) === JSON.stringify(normalizedTransaction(b));

function normalizedTransaction(record) {
  return [
    record.type,
    typeof record.description === 'string' ? record.description.trim() : record.description,
    typeof record.category === 'string' ? record.category.trim().toLowerCase() : record.category,
    record.accountId,
    record.amount,
    record.note === undefined ? '' : record.note,
    record.date,
    record.createdAt === undefined ? 0 : record.createdAt
  ];
}

// ---------------------------------------------------------------------------
// The import envelope (checked before anything else)
// ---------------------------------------------------------------------------

function checkEnvelope(body) {
  if (body.format !== FORMAT) {
    const message = body.format === DATABASE_EXPORT_FORMAT
      ? 'This is a database export. Only a backup of the previous (browser-only) version can be imported.'
      : `Unsupported format. Expected "${FORMAT}".`;
    throw new ApiError(400, 'UNSUPPORTED_FORMAT', message);
  }
  if (body.version !== SUPPORTED_VERSION) {
    throw new ApiError(400, 'UNSUPPORTED_VERSION', `Unsupported version. This app understands version ${SUPPORTED_VERSION}.`);
  }
  if (!isPlainObject(body.data)) {
    throw new ApiError(400, 'INVALID_BODY', '"data" must be an object with accounts, categories and transactions.');
  }

  const unknown = Object.keys(body.data).filter(key => !ENTITIES.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(400, 'UNSUPPORTED_ENTITY', `Unsupported data: ${unknown.join(', ')}. Only accounts, categories and transactions can be imported.`);
  }

  for (const entity of ENTITIES) {
    if (!Array.isArray(body.data[entity])) {
      throw new ApiError(400, 'INVALID_BODY', `"data.${entity}" must be an array.`);
    }
    if (body.data[entity].length > MAX_RECORDS[entity]) {
      throw new ApiError(
        400,
        'LIMIT_EXCEEDED',
        `Too many ${entity}: ${body.data[entity].length} (the limit is ${MAX_RECORDS[entity]}).`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function newSection() {
  return {
    counts: {
      received: 0,
      imported: 0,
      duplicateInDatabase: 0,
      duplicateInFile: 0,
      oldDefaultNotImported: 0,
      rejected: 0,
      conflicts: 0, // part of "rejected"
      unresolvedReferences: 0
    },
    items: []
  };
}

function record(section, { index, id, label, outcome, reason, conflict = false }) {
  const counts = section.counts;
  if (outcome === IMPORTED) counts.imported += 1;
  else if (outcome === DUPLICATE_DATABASE) counts.duplicateInDatabase += 1;
  else if (outcome === DUPLICATE_FILE) counts.duplicateInFile += 1;
  else if (outcome === OLD_DEFAULT) counts.oldDefaultNotImported += 1;
  else if (outcome === UNRESOLVED) counts.unresolvedReferences += 1;
  else {
    counts.rejected += 1;
    if (conflict) counts.conflicts += 1;
  }

  const item = { index, outcome };
  if (id !== undefined) item.id = id;
  if (label) item.label = label;
  if (reason) item.reason = reason;
  section.items.push(item);
}

function databaseCounts() {
  const db = getDb();
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { accounts: count('accounts'), categories: count('categories'), transactions: count('transactions') };
}

// ---------------------------------------------------------------------------
// The import itself (runs inside one SQLite transaction)
// ---------------------------------------------------------------------------

function planAndWrite(data) {
  const db = getDb();
  const sections = { accounts: newSection(), categories: newSection(), transactions: newSection() };
  const before = databaseCounts();

  // What the old transactions use. An unused old default is not imported, but a
  // default that transactions refer to must be, or those transactions would
  // have nothing to point at.
  const usedAccountIds = new Set();
  const usedCategoryKeys = new Set();
  for (const tx of data.transactions) {
    if (!isPlainObject(tx)) continue;
    if (typeof tx.accountId === 'string') usedAccountIds.add(tx.accountId);
    if ((tx.type === 'income' || tx.type === 'expense') && typeof tx.category === 'string') {
      usedCategoryKeys.add(categoryKey(tx.type, tx.category));
    }
  }

  const written = { accounts: [], categories: [], transactions: [] }; // for read-back verification

  // ---- 1. accounts --------------------------------------------------------
  const accountSection = sections.accounts;
  accountSection.counts.received = data.accounts.length;
  const accountRepeats = findRepeatedIds(data.accounts, sameAccountData);
  const accountState = new Map(); // legacy id -> 'ok' | 'rejected'

  data.accounts.forEach((raw, index) => {
    const item = { index, id: isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : undefined };

    if (!isPlainObject(raw)) {
      return record(accountSection, { ...item, outcome: REJECTED, reason: 'Not a record (expected an object).' });
    }
    item.label = typeof raw.name === 'string' ? raw.name : undefined;

    if (accountRepeats.ambiguous.has(index)) {
      accountState.set(raw.id, 'rejected');
      return record(accountSection, { ...item, outcome: REJECTED, conflict: true, reason: 'The same id appears more than once with different data, so it cannot be decided which is correct.' });
    }
    if (accountRepeats.duplicates.has(index)) {
      return record(accountSection, { ...item, outcome: DUPLICATE_FILE, reason: 'Identical to an earlier account in this import.' });
    }

    const check = validated(() => {
      if (typeof raw.id !== 'string') {
        throw new ApiError(400, 'VALIDATION_ERROR', '', [{ field: 'id', message: 'This field is required.' }]);
      }
      return accounts.readBody({ id: raw.id, name: raw.name, type: raw.type, balance: raw.balance }, true);
    });
    if (check.reason) {
      if (typeof raw.id === 'string') accountState.set(raw.id, 'rejected');
      return record(accountSection, { ...item, outcome: REJECTED, reason: check.reason });
    }
    const input = check.value;

    if (isOldDefaultAccount(raw) && !usedAccountIds.has(raw.id)) {
      return record(accountSection, { ...item, outcome: OLD_DEFAULT, reason: 'Unchanged default of the old version that no transaction uses.' });
    }

    const existing = db.prepare('SELECT id, name, type, balance_minor FROM accounts WHERE id = ?').get(input.id);
    if (existing) {
      const identical = existing.name.toLowerCase() === input.name.toLowerCase()
        && existing.type === input.type
        && existing.balance_minor === toMinor(input.balance);
      if (identical) {
        accountState.set(input.id, 'ok');
        return record(accountSection, { ...item, outcome: DUPLICATE_DATABASE, reason: 'Already in the database with identical data.' });
      }
      accountState.set(input.id, 'rejected');
      return record(accountSection, { ...item, outcome: REJECTED, conflict: true, reason: 'An account with this id already exists in the database with different data. It was not changed.' });
    }
    if (accounts.nameTaken(input.name)) {
      accountState.set(input.id, 'rejected');
      return record(accountSection, { ...item, outcome: REJECTED, conflict: true, reason: `Another account in the database is already named "${input.name}". Rename one of them and import again.` });
    }

    accounts.insertAccount(input);
    accountState.set(input.id, 'ok');
    written.accounts.push(input);
    return record(accountSection, { ...item, outcome: IMPORTED });
  });

  // ---- 2. categories ------------------------------------------------------
  const categorySection = sections.categories;
  categorySection.counts.received = data.categories.length;
  const categoryIds = new Map(); // category key -> database id

  data.categories.forEach((raw, index) => {
    const item = { index };

    if (!isPlainObject(raw)) {
      return record(categorySection, { ...item, outcome: REJECTED, reason: 'Not a record (expected an object).' });
    }

    const check = validated(() => categories.readBody({ name: raw.name, type: raw.type }));
    if (check.reason) {
      item.label = typeof raw.name === 'string' ? raw.name : undefined;
      return record(categorySection, { ...item, outcome: REJECTED, reason: check.reason });
    }
    const input = check.value;
    const key = categoryKey(input.type, input.name);
    item.label = `${input.name} (${input.type})`;

    if (categoryIds.has(key)) {
      return record(categorySection, { ...item, outcome: DUPLICATE_FILE, reason: 'Same name and type as an earlier category in this import.' });
    }
    if (isOldDefaultCategory(raw) && !usedCategoryKeys.has(key)) {
      return record(categorySection, { ...item, outcome: OLD_DEFAULT, reason: 'Unchanged default of the old version that no transaction uses.' });
    }

    // A category's identity in the old app is its type and name (ignoring case).
    const existing = db
      .prepare('SELECT id, name FROM categories WHERE type = ?')
      .all(input.type)
      .find(row => row.name.toLowerCase() === input.name.toLowerCase());
    if (existing) {
      categoryIds.set(key, existing.id);
      return record(categorySection, { ...item, outcome: DUPLICATE_DATABASE, reason: 'A category with this name and type is already in the database.' });
    }

    const id = categories.insertCategory(input);
    categoryIds.set(key, id);
    written.categories.push({ id, ...input });
    return record(categorySection, { ...item, outcome: IMPORTED });
  });

  // ---- 3. transactions ----------------------------------------------------
  const txSection = sections.transactions;
  txSection.counts.received = data.transactions.length;
  const txRepeats = findRepeatedIds(data.transactions, sameTransactionData);

  data.transactions.forEach((raw, index) => {
    const item = { index, id: isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : undefined };

    if (!isPlainObject(raw)) {
      return record(txSection, { ...item, outcome: REJECTED, reason: 'Not a record (expected an object).' });
    }
    item.label = [raw.date, raw.description].filter(part => typeof part === 'string').join(' ') || undefined;

    if (txRepeats.ambiguous.has(index)) {
      return record(txSection, { ...item, outcome: REJECTED, conflict: true, reason: 'The same id appears more than once with different data, so it cannot be decided which is correct.' });
    }
    if (txRepeats.duplicates.has(index)) {
      return record(txSection, { ...item, outcome: DUPLICATE_FILE, reason: 'Identical to an earlier transaction in this import.' });
    }
    if (typeof raw.id !== 'string') {
      return record(txSection, { ...item, outcome: REJECTED, reason: 'id: This field is required.' });
    }

    // Resolve the references first. Never guess: a transaction whose account
    // or category was not imported (or is missing) is rejected, not repaired.
    if (typeof raw.accountId !== 'string' || !accountState.has(raw.accountId)) {
      return record(txSection, { ...item, outcome: UNRESOLVED, reason: `The account "${raw.accountId}" is not part of this import.` });
    }
    if (accountState.get(raw.accountId) !== 'ok') {
      return record(txSection, { ...item, outcome: UNRESOLVED, reason: `The account "${raw.accountId}" was not imported (see the account's own result).` });
    }
    const typeIsValid = raw.type === 'income' || raw.type === 'expense';
    let categoryId;
    if (typeIsValid && typeof raw.category === 'string') {
      categoryId = categoryIds.get(categoryKey(raw.type, raw.category));
      if (categoryId === undefined) {
        return record(txSection, { ...item, outcome: UNRESOLVED, reason: `The ${raw.type} category "${raw.category}" is not part of this import.` });
      }
    }

    if (categoryId === undefined) {
      // The type or the category name has the wrong form, so no category can be looked up.
      return record(txSection, {
        ...item,
        outcome: REJECTED,
        reason: typeIsValid ? 'category: Must be the name of a category.' : 'type: Must be one of: income, expense.'
      });
    }

    const check = validated(() => transactions.readBody({
      id: raw.id,
      type: raw.type,
      description: raw.description,
      categoryId,
      accountId: raw.accountId,
      amount: raw.amount,
      note: raw.note === undefined ? '' : raw.note,
      date: raw.date,
      createdAt: raw.createdAt === undefined ? 0 : raw.createdAt // the old app sorted a missing createdAt as 0
    }, true));
    if (check.reason) {
      return record(txSection, { ...item, outcome: REJECTED, reason: check.reason });
    }
    const input = check.value;

    const existing = db
      .prepare('SELECT id, type, description, category_id, account_id, amount_minor, note, date, created_at FROM transactions WHERE id = ?')
      .get(input.id);
    if (existing) {
      const identical = existing.type === input.type
        && existing.description === input.description
        && existing.category_id === input.categoryId
        && existing.account_id === input.accountId
        && existing.amount_minor === toMinor(input.amount)
        && existing.note === input.note
        && existing.date === input.date
        && existing.created_at === input.createdAt;
      if (identical) {
        return record(txSection, { ...item, outcome: DUPLICATE_DATABASE, reason: 'Already in the database with identical data.' });
      }
      return record(txSection, { ...item, outcome: REJECTED, conflict: true, reason: 'A transaction with this id already exists in the database with different data. It was not changed.' });
    }

    transactions.insertTransaction(input);
    written.transactions.push(input);
    return record(txSection, { ...item, outcome: IMPORTED });
  });

  // ---- 4. read everything back --------------------------------------------
  const verification = verifyWritten(written);

  const rejectedTotal = ENTITIES.reduce((sum, name) => {
    const c = sections[name].counts;
    return sum + c.rejected + c.unresolvedReferences;
  }, 0);

  const txItems = txSection.items.filter(entry => entry.outcome !== IMPORTED);
  const transactionsTruncated = txItems.length > MAX_LISTED_ITEMS;

  return {
    complete: rejectedTotal === 0,
    counts: {
      accounts: accountSection.counts,
      categories: categorySection.counts,
      transactions: txSection.counts
    },
    items: {
      accounts: accountSection.items,
      categories: categorySection.items,
      transactions: txItems.slice(0, MAX_LISTED_ITEMS),
      transactionsTruncated
    },
    verification,
    databaseBefore: before,
    databaseAfter: databaseCounts()
  };
}

function isOldDefaultAccount(record) {
  return OLD_DEFAULT_ACCOUNTS.some(item =>
    item.id === record.id && item.name === record.name && item.type === record.type && item.balance === record.balance);
}

function isOldDefaultCategory(record) {
  return OLD_DEFAULT_CATEGORIES.some(item => item.name === record.name && item.type === record.type);
}

// Reads every record this import wrote back out of the database and compares
// it with what was meant to be written. A mismatch aborts the whole import.
function verifyWritten(written) {
  const db = getDb();
  let checked = 0;

  const expect = (condition, what) => {
    if (!condition) throw new Error(`Read-back check failed for ${what}.`);
    checked += 1;
  };

  for (const input of written.accounts) {
    const row = db.prepare('SELECT name, type, balance_minor FROM accounts WHERE id = ?').get(input.id);
    expect(row && row.name === input.name && row.type === input.type && row.balance_minor === toMinor(input.balance), 'an account');
  }
  for (const input of written.categories) {
    const row = db.prepare('SELECT name, type FROM categories WHERE id = ?').get(input.id);
    expect(row && row.name === input.name && row.type === input.type, 'a category');
  }
  for (const input of written.transactions) {
    const row = db
      .prepare('SELECT type, description, category_id, account_id, amount_minor, note, date, created_at FROM transactions WHERE id = ?')
      .get(input.id);
    expect(
      row
        && row.type === input.type
        && row.description === input.description
        && row.category_id === input.categoryId
        && row.account_id === input.accountId
        && row.amount_minor === toMinor(input.amount)
        && row.note === input.note
        && row.date === input.date
        && row.created_at === input.createdAt,
      'a transaction'
    );
  }
  return { recordsChecked: checked, recordsMatching: checked };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function run(body, commit) {
  checkEnvelope(body);

  let result;
  try {
    result = runInTransaction(() => planAndWrite(body.data), { dryRun: !commit });
  } catch (error) {
    // Details stay in the server console (they never contain the records).
    console.error(`Import ${commit ? 'failed' : 'preview failed'}:`, error.message);
    throw new ApiError(
      500,
      commit ? 'IMPORT_FAILED' : 'PREVIEW_FAILED',
      commit
        ? 'The import failed and nothing was saved. The database is unchanged.'
        : 'The preview could not be completed. Nothing was changed.'
    );
  }

  return ok({ mode: commit ? 'import' : 'preview', ...result });
}

function preview({ body }) {
  return run(body, false);
}

// The real import needs an explicit "confirm": true so that it can never be
// started by accident (for example by repeating a preview request).
function commit({ body }) {
  if (body.confirm !== true) {
    throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Send "confirm": true to start the import.');
  }
  return run(body, true);
}

// The import routes accept much larger bodies than the 64 KB default.
preview.maxBodyBytes = MAX_BODY_BYTES;
commit.maxBodyBytes = MAX_BODY_BYTES;

const routes = {
  '/api/import/preview': { POST: preview },
  '/api/import': { POST: commit }
};

module.exports = {
  routes,
  FORMAT,
  SUPPORTED_VERSION,
  MAX_RECORDS,
  MAX_BODY_BYTES,
  OLD_DEFAULT_ACCOUNTS,
  OLD_DEFAULT_CATEGORIES
};
