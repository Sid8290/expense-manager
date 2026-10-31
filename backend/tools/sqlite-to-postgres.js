#!/usr/bin/env node
'use strict';

// Optional, one-time tool: copies the data of the old SQLite version of this
// app (backend/data/expense-manager.db) into the PostgreSQL database.
//
//   npm run migrate:sqlite -- --source path/to/expense-manager.db            (preview)
//   npm run migrate:sqlite -- --source path/to/expense-manager.db --apply    (really copy)
//
// The destination is the database in DATABASE_URL (from the environment or
// .env). Nothing is assumed: --source is required and DATABASE_URL must be set.
//
// Safety rules (each one is covered by backend/test/sqlite-migration.test.js):
//  * The SQLite file is opened READ-ONLY. It is never changed, created or deleted.
//  * Without --apply nothing is kept. The preview runs the real inserts inside a
//    transaction (so every constraint is really checked) and then rolls back.
//  * Everything happens in ONE PostgreSQL transaction. Any problem rolls it all
//    back, so a failed migration never leaves partial data.
//  * Nothing existing is overwritten. A record that is already in PostgreSQL with
//    identical data is skipped ("already migrated"); the same id with different
//    data, or a name that clashes with another record, is a conflict and the
//    whole migration is refused before anything is written. Running the tool
//    twice therefore changes nothing the second time.
//  * IDs (account ids, category numbers, transaction ids), amounts (exact whole
//    paise, never converted through decimals), dates and creation times are
//    copied as they are, and every copied row is read back and compared before
//    the transaction is committed.
//
// This file is the ONLY place that still uses node:sqlite (a built-in module of
// Node.js 22.13 or newer, so nothing is installed). It is loaded only when the
// tool runs; the server never loads it.

const fs = require('node:fs');
const db = require('../db');

const LEGACY_SCHEMA_VERSION = 2; // the last version of the SQLite schema (PRAGMA user_version)
const MIGRATION_LOCK_ID = 7243002; // differs from the schema-migration and import locks
const CHUNK = 1000;
const MAX_LISTED = 20; // conflicts shown in the report

class MigrationError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Reading the SQLite file (read-only)
// ---------------------------------------------------------------------------

function readSource(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath === '') {
    throw new MigrationError('No source given. Use --source <path to the SQLite file>.');
  }
  // Check first: opening a missing path must never create an empty file.
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch (error) {
    throw new MigrationError(`The source file does not exist: ${sourcePath}`);
  }
  if (!stat.isFile()) {
    throw new MigrationError(`The source is not a file: ${sourcePath}`);
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new MigrationError(
      `This tool needs the built-in node:sqlite module (Node.js 22.13 or newer; you are running ${process.version}).`
    );
  }

  let source;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
  } catch (error) {
    throw new MigrationError(`Cannot open the source as a SQLite database: ${sourcePath}`);
  }

  try {
    let version;
    let tables;
    try {
      version = source.prepare('PRAGMA user_version').get().user_version;
      tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    } catch (error) {
      throw new MigrationError(`The source is not a valid SQLite database of this app: ${sourcePath}`);
    }

    if (version > LEGACY_SCHEMA_VERSION) {
      throw new MigrationError(`The source schema version ${version} is newer than this tool understands (${LEGACY_SCHEMA_VERSION}).`);
    }
    if (version < LEGACY_SCHEMA_VERSION || !['accounts', 'categories', 'transactions'].every(name => tables.includes(name))) {
      throw new MigrationError(
        `The source has no financial tables (schema version ${version}, expected ${LEGACY_SCHEMA_VERSION}). Is this the right file?`
      );
    }

    // rowid is SQLite's insertion order; keeping it keeps the order of equal records.
    const accounts = source.prepare('SELECT id, name, type, balance_minor FROM accounts ORDER BY rowid').all()
      .map(row => ({ ...row }));
    const categories = source.prepare('SELECT id, name, type FROM categories ORDER BY id').all()
      .map(row => ({ ...row }));
    const transactions = source.prepare(
      'SELECT id, type, description, category_id, account_id, amount_minor, note, date, created_at FROM transactions ORDER BY rowid'
    ).all().map(row => ({ ...row }));

    // The source should already be consistent; a broken one is refused rather than guessed at.
    const broken = source.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) {
      throw new MigrationError(
        `The source database has ${broken.length} broken reference(s) (PRAGMA foreign_key_check). Nothing was migrated.`
      );
    }

    return { accounts, categories, transactions };
  } finally {
    source.close();
  }
}

// ---------------------------------------------------------------------------
// Planning: compare the source with what PostgreSQL already holds
// ---------------------------------------------------------------------------

const sameAccount = (a, b) => a.name === b.name && a.type === b.type && Number(a.balance_minor) === Number(b.balance_minor);
const sameCategory = (a, b) => a.name === b.name && a.type === b.type;
const sameTransaction = (a, b) =>
  a.type === b.type && a.description === b.description && a.category_id === b.category_id
  && a.account_id === b.account_id && Number(a.amount_minor) === Number(b.amount_minor)
  && a.note === b.note && a.date === b.date && Number(a.created_at) === Number(b.created_at);

async function loadDestination() {
  const accounts = (await db.query('SELECT id, name, type, balance_minor FROM accounts')).rows;
  const categories = (await db.query('SELECT id, name, type FROM categories')).rows;
  const transactions = (await db.query(
    'SELECT id, type, description, category_id, account_id, amount_minor, note, date, created_at FROM transactions'
  )).rows;
  return { accounts, categories, transactions };
}

function plan(source, dest) {
  const conflicts = [];
  const conflict = (entity, id, reason) => conflicts.push({ entity, id, reason });
  const result = { accounts: [], categories: [], transactions: [] }; // records to insert
  const alreadyThere = { accounts: 0, categories: 0, transactions: 0 };

  const destAccounts = new Map(dest.accounts.map(row => [row.id, row]));
  const destAccountNames = new Map(dest.accounts.map(row => [row.name.toLowerCase(), row.id]));
  for (const row of source.accounts) {
    const existing = destAccounts.get(row.id);
    if (existing) {
      if (sameAccount(row, existing)) alreadyThere.accounts += 1;
      else conflict('account', row.id, 'An account with this id already exists with different data.');
    } else if (destAccountNames.has(row.name.toLowerCase())) {
      conflict('account', row.id, `Another account (${destAccountNames.get(row.name.toLowerCase())}) is already named "${row.name}".`);
    } else {
      result.accounts.push(row);
    }
  }

  const destCategories = new Map(dest.categories.map(row => [row.id, row]));
  const destCategoryNames = new Map(dest.categories.map(row => [`${row.type}\u0000${row.name.toLowerCase()}`, row.id]));
  for (const row of source.categories) {
    const existing = destCategories.get(row.id);
    const nameKey = `${row.type}\u0000${row.name.toLowerCase()}`;
    if (existing) {
      if (sameCategory(row, existing)) alreadyThere.categories += 1;
      else conflict('category', row.id, 'A category with this id already exists with a different name or type.');
    } else if (destCategoryNames.has(nameKey)) {
      conflict('category', row.id, `The ${row.type} category "${row.name}" already exists with a different id (${destCategoryNames.get(nameKey)}).`);
    } else {
      result.categories.push(row);
    }
  }

  const destTransactions = new Map(dest.transactions.map(row => [row.id, row]));
  for (const row of source.transactions) {
    const existing = destTransactions.get(row.id);
    if (existing) {
      if (sameTransaction(row, existing)) alreadyThere.transactions += 1;
      else conflict('transaction', row.id, 'A transaction with this id already exists with different data.');
    } else {
      result.transactions.push(row);
    }
  }

  return { toInsert: result, alreadyThere, conflicts };
}

// ---------------------------------------------------------------------------
// Writing (parameterized; arrays are passed as ONE parameter per column)
// ---------------------------------------------------------------------------

function* chunks(rows) {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}

async function insertAll(toInsert) {
  for (const part of chunks(toInsert.accounts)) {
    await db.query(
      `INSERT INTO accounts (id, name, type, balance_minor)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])`,
      [part.map(r => r.id), part.map(r => r.name), part.map(r => r.type), part.map(r => r.balance_minor)]
    );
  }
  for (const part of chunks(toInsert.categories)) {
    // The id column is GENERATED ALWAYS, so keeping the old id needs OVERRIDING SYSTEM VALUE.
    await db.query(
      `INSERT INTO categories (id, name, type) OVERRIDING SYSTEM VALUE
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
      [part.map(r => r.id), part.map(r => r.name), part.map(r => r.type)]
    );
  }
  for (const part of chunks(toInsert.transactions)) {
    await db.query(
      `INSERT INTO transactions (id, type, description, category_id, account_id, amount_minor, note, date, created_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[], $7::text[], $8::text[], $9::bigint[])`,
      [
        part.map(r => r.id), part.map(r => r.type), part.map(r => r.description), part.map(r => r.category_id),
        part.map(r => r.account_id), part.map(r => r.amount_minor), part.map(r => r.note), part.map(r => r.date),
        part.map(r => r.created_at)
      ]
    );
  }
}

// Reads everything back and compares it with the source. Any difference throws,
// which rolls the whole migration back.
async function verify(source, before) {
  const dest = await loadDestination();
  const check = (condition, what) => {
    if (!condition) throw new Error(`Read-back check failed: ${what}.`);
  };

  const accounts = new Map(dest.accounts.map(row => [row.id, row]));
  const categories = new Map(dest.categories.map(row => [row.id, row]));
  const transactions = new Map(dest.transactions.map(row => [row.id, row]));
  source.accounts.forEach(row => check(accounts.has(row.id) && sameAccount(row, accounts.get(row.id)), `account ${row.id}`));
  source.categories.forEach(row => check(categories.has(row.id) && sameCategory(row, categories.get(row.id)), `category ${row.id}`));
  source.transactions.forEach(row => check(transactions.has(row.id) && sameTransaction(row, transactions.get(row.id)), `transaction ${row.id}`));

  // Every migrated account must end with the balance the source data implies.
  const expected = new Map(source.accounts.map(row => [row.id, Number(row.balance_minor)]));
  for (const row of source.transactions) {
    expected.set(row.account_id, expected.get(row.account_id) + (row.type === 'income' ? 1 : -1) * Number(row.amount_minor));
  }
  const migratedOnly = new Set(source.accounts.map(row => row.id));
  const { rows } = await db.query(`
    SELECT a.id, a.balance_minor + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount_minor ELSE -t.amount_minor END), 0)::bigint AS current_minor
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id`);
  for (const row of rows) {
    if (!migratedOnly.has(row.id)) continue;
    // Transactions already in PostgreSQL for this account (identical re-run) are in `source` too.
    check(Number(row.current_minor) === expected.get(row.id), `balance of account ${row.id}`);
  }
  return {
    accounts: dest.accounts.length - before.accounts.length,
    categories: dest.categories.length - before.categories.length,
    transactions: dest.transactions.length - before.transactions.length
  };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

// db.initDatabase() must already have been called (the CLI does it; tests do too).
// Returns a report; throws MigrationError / Error when nothing could be done.
async function migrate({ sourcePath, apply = false }) {
  const source = readSource(sourcePath);

  const report = await db.runInTransaction(async () => {
    // One migration at a time (and not while an import runs).
    await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);

    const before = await loadDestination();
    const { toInsert, alreadyThere, conflicts } = plan(source, before);

    const base = {
      mode: apply ? 'apply' : 'preview',
      source: {
        accounts: source.accounts.length, categories: source.categories.length, transactions: source.transactions.length
      },
      toInsert: {
        accounts: toInsert.accounts.length, categories: toInsert.categories.length, transactions: toInsert.transactions.length
      },
      alreadyMigrated: alreadyThere,
      conflicts: conflicts.slice(0, MAX_LISTED),
      conflictCount: conflicts.length
    };

    if (conflicts.length > 0) {
      return { ...base, status: 'conflicts', saved: false };
    }
    const nothingNew = toInsert.accounts.length + toInsert.categories.length + toInsert.transactions.length === 0;
    if (nothingNew) {
      return { ...base, status: 'already-migrated', saved: false };
    }

    await insertAll(toInsert);
    const added = await verify(source, before);
    if (added.accounts !== toInsert.accounts.length || added.categories !== toInsert.categories.length
      || added.transactions !== toInsert.transactions.length) {
      throw new Error('Read-back check failed: the number of new rows is not what was planned.');
    }

    if (apply && toInsert.categories.length > 0) {
      // New categories created later must not reuse the copied ids.
      await db.query(
        `SELECT setval(pg_get_serial_sequence('categories', 'id'), (SELECT MAX(id) FROM categories))`
      );
    }
    return { ...base, status: apply ? 'migrated' : 'preview-ok', saved: apply, verified: added };
  }, { dryRun: !apply });

  // A dry run (or a refusal) keeps nothing; say so plainly.
  if (!apply) report.saved = false;
  return report;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const HELP = `Copies the data of the old SQLite version into PostgreSQL.

Usage:
  npm run migrate:sqlite -- --source <path to the SQLite file> [--apply]

  --source <file>  The old SQLite database (opened read-only, never changed). Required.
  --apply          Really copy the data. Without it, only a preview is shown and nothing is saved.
  --help           Show this text.

The destination is the PostgreSQL database in DATABASE_URL (environment or .env).
Back up both databases first (see README.md, "Moving data from the old SQLite version").
Exit codes: 0 = done (or nothing to do), 1 = error, 2 = conflicts (nothing was written).
`;

function parseArgs(argv) {
  const options = { apply: false, help: false, source: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--source') {
      options.source = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length);
    else throw new MigrationError(`Unknown option "${arg}". Use --help.`);
  }
  return options;
}

// Shows the destination without the password.
function describeDestination(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch (error) {
    return '(DATABASE_URL)';
  }
}

function printReport(report, out) {
  const line = text => out(text);
  const row = (label, counts) => line(`  ${label.padEnd(14)} ${counts.accounts} accounts, ${counts.categories} categories, ${counts.transactions} transactions`);
  line('');
  row('In SQLite:', report.source);
  row('To copy:', report.toInsert);
  row('Already there:', report.alreadyMigrated);
  line('');

  if (report.status === 'conflicts') {
    line(`REFUSED: ${report.conflictCount} conflict(s) with data already in PostgreSQL. Nothing was written.`);
    report.conflicts.forEach(item => line(`  - ${item.entity} ${item.id}: ${item.reason}`));
    if (report.conflictCount > report.conflicts.length) line(`  ... and ${report.conflictCount - report.conflicts.length} more.`);
    line('Fix or remove the conflicting records (or migrate into an empty database) and run again.');
  } else if (report.status === 'already-migrated') {
    line('Nothing to do: all of this data is already in PostgreSQL with identical content.');
  } else if (report.status === 'preview-ok') {
    line('PREVIEW OK: every record was inserted and checked inside a transaction, which was then rolled back.');
    line('Nothing was saved. Run again with --apply to copy the data.');
  } else if (report.status === 'migrated') {
    line('DONE: the data was copied, read back and verified, and the transaction was committed.');
    line('The SQLite file was not changed. Keep it as a backup.');
  }
}

async function main(argv, { out = console.log, err = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      out(HELP);
      return 0;
    }
    if (!options.source) throw new MigrationError('No source given. Use --source <path to the SQLite file>.');
    if (!process.env.DATABASE_URL) {
      throw new MigrationError('DATABASE_URL is not set. Put it in .env or the environment (see .env.example).');
    }

    out(`Source:      ${options.source} (read-only)`);
    out(`Destination: ${describeDestination(process.env.DATABASE_URL)}`);
    out(`Mode:        ${options.apply ? 'APPLY (the data will be saved)' : 'preview (nothing will be saved)'}`);

    // Read the source before touching PostgreSQL, so a wrong path fails fast.
    readSource(options.source);

    try {
      await db.initDatabase();
    } catch (error) {
      throw new MigrationError(`Cannot start PostgreSQL: ${error.message}`);
    }

    const report = await migrate({ sourcePath: options.source, apply: options.apply });
    printReport(report, out);
    return report.status === 'conflicts' ? 2 : 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      err(`Error: ${error.message}`);
      return error.exitCode;
    }
    // Unexpected: the transaction was rolled back. Do not print connection details.
    err(`The migration failed and nothing was saved: ${error.message}`);
    return 1;
  } finally {
    await db.closeDatabase().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}

module.exports = { migrate, readSource, plan, main, parseArgs, MigrationError, LEGACY_SCHEMA_VERSION };
