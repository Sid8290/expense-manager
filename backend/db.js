'use strict';

// PostgreSQL connection management for the Expense Manager backend.
//
// This module owns the one connection pool. Other modules use query() or
// runInTransaction(); server.js calls initDatabase() once at startup and
// closeDatabase() at shutdown.
//
// Everything here is asynchronous (the old SQLite code was synchronous), so
// callers must `await` it.

const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types: pgTypes } = require('pg');

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------
//
// Schema changes are a list of numbered steps. The table `schema_migrations`
// remembers which steps have run, so each step runs exactly once. Never edit
// or reorder a step that has already shipped; add a new one instead.
//
// Versions 1 and 2 are the same two steps the SQLite version had.
//
// Money is stored as whole minor units (paise) in BIGINT columns, e.g. 12.34
// is stored as 1234. The limit is 100,000,000,000 (1e11), which does not fit
// in a 32-bit INTEGER, so BIGINT is required. The same goes for created_at,
// which holds Date.now() in milliseconds.
//
// The CHECK constraints repeat the API's validation rules on purpose: the API
// gives friendly messages, the database guarantees that bad data can never be
// stored even if a bug lets it through.
//
// Differences from the SQLite schema, and why:
//  - COLLATE NOCASE became a unique index on lower(name). (SQLite's NOCASE only
//    folded English letters; lower() follows the database's locale. The API
//    also compares with toLowerCase(), so behavior is the same in practice.)
//  - SQLite's hidden `rowid` gave "insertion order". PostgreSQL has no rowid,
//    so accounts and transactions get an identity column `seq` for the same job.
//  - AUTOINCREMENT became GENERATED ALWAYS AS IDENTITY (use INSERT ... RETURNING id).
//  - The date GLOB check became a regular expression with the same meaning.
//    Dates stay TEXT so the API keeps returning plain 'YYYY-MM-DD' strings.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO app_meta (key, value)
        VALUES ('created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    `
  },
  {
    // The financial tables. They start EMPTY (nothing is seeded).
    version: 2,
    sql: `
      CREATE TABLE accounts (
        seq           BIGINT GENERATED ALWAYS AS IDENTITY,
        id            TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
        type          TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'online', 'asset', 'receivable', 'payable')),
        balance_minor BIGINT NOT NULL CHECK (balance_minor BETWEEN 0 AND 100000000000)
      );
      CREATE UNIQUE INDEX accounts_name_unique ON accounts (lower(name));

      CREATE TABLE categories (
        id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        -- Needed so transactions can point at (id, type) together (see below).
        UNIQUE (id, type)
      );
      CREATE UNIQUE INDEX categories_type_name_unique ON categories (type, lower(name));

      CREATE TABLE transactions (
        seq          BIGINT GENERATED ALWAYS AS IDENTITY,
        id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        description  TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 100),
        category_id  INTEGER NOT NULL,
        account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
        amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000000),
        note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
        date         TEXT NOT NULL CHECK (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        created_at   BIGINT NOT NULL CHECK (created_at >= 0),
        -- The reference includes the type, so the database itself guarantees an
        -- income transaction can only use an income category (and vice versa),
        -- and that a category cannot change type while transactions use it.
        FOREIGN KEY (category_id, type) REFERENCES categories (id, type) ON DELETE RESTRICT
      );

      CREATE INDEX idx_transactions_account  ON transactions (account_id);
      CREATE INDEX idx_transactions_category ON transactions (category_id);
      CREATE INDEX idx_transactions_date     ON transactions (date DESC, created_at DESC);
    `
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Any number will do; it only has to be the same in every copy of the app so
// that two servers starting at once do not run migrations at the same time.
const MIGRATION_LOCK_ID = 727001;

// ---------------------------------------------------------------------------
// Number conversion
// ---------------------------------------------------------------------------
//
// By default `pg` returns BIGINT (and COUNT(*), which is BIGINT) as strings,
// because a JavaScript number cannot hold every 64-bit integer. SUM() of a
// BIGINT column is NUMERIC, which also arrives as a string.
//
// This app's values are small (a single amount is at most 1e11), so whole
// numbers can safely become JavaScript numbers. The parser below does that but
// THROWS if a value is ever outside the safe range (about 9e15), instead of
// silently rounding it. It is attached to this pool only (not to `pg` globally),
// and decimals in NUMERIC values are left alone.
function parseWholeNumber(text) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`The database returned ${text}, which is too large to use as a JavaScript number.`);
  }
  return value;
}

const OID_INT8 = 20;
const OID_NUMERIC = 1700;

const poolTypes = {
  getTypeParser(oid, format) {
    const standard = pgTypes.getTypeParser(oid, format);
    if (oid === OID_INT8) return parseWholeNumber;
    if (oid === OID_NUMERIC) return text => (/^-?\d+$/.test(text) ? parseWholeNumber(text) : standard(text));
    return standard;
  }
};

// ---------------------------------------------------------------------------
// Connection errors
// ---------------------------------------------------------------------------

// Turns a failed start-up into one clear sentence. The password is never
// included: only the host, port, database and user are read from the URL.
function describeConnectionProblem(error, connectionString) {
  let target = 'the configured PostgreSQL server';
  let user = 'the configured user';
  let database = 'the configured database';
  try {
    const url = new URL(connectionString);
    target = `${url.hostname || 'localhost'}:${url.port || 5432}`;
    if (url.username) user = decodeURIComponent(url.username);
    if (url.pathname.length > 1) database = decodeURIComponent(url.pathname.slice(1));
  } catch (parseError) {
    // The URL itself is malformed; report that below.
    return 'DATABASE_URL is not a valid PostgreSQL connection URL. ' +
      'Expected: postgres://USER:PASSWORD@HOST:5432/DATABASE';
  }

  switch (error && error.code) {
    case 'ECONNREFUSED':
      return `Cannot connect to PostgreSQL at ${target}. Is the server running?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot find the PostgreSQL host in DATABASE_URL (${target}).`;
    case 'ETIMEDOUT':
      return `Timed out connecting to PostgreSQL at ${target}.`;
    case '28P01':
    case '28000':
      return `PostgreSQL rejected the user name or password for "${user}". Check DATABASE_URL.`;
    case '3D000':
      return `The PostgreSQL database "${database}" does not exist. Create it first (see docs).`;
    default:
      if (/timeout/i.test(String(error && error.message))) {
        return `Timed out connecting to PostgreSQL at ${target}.`;
      }
      return null; // not a connection problem; the caller rethrows the original error
  }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

let pool = null;
let initPromise = null;

// Holds the checked-out client while runInTransaction() is running, so that
// query() calls made anywhere inside it use that same client automatically.
const transactionContext = new AsyncLocalStorage();

function getPool() {
  if (!pool) {
    throw new Error('Database is not initialized. Call initDatabase() first.');
  }
  return pool;
}

// Runs a query on a transaction's client. Refuses once the transaction is over.
async function queryOn(context, text, params) {
  if (!context.active) {
    throw new Error('This transaction has already finished; its client can no longer be used.');
  }
  return context.client.query(text, params);
}

// Runs a query. Inside runInTransaction() it uses the transaction's client;
// otherwise it borrows a connection from the pool for just this query.
// Always returns a promise (problems such as "not initialized" are rejections).
// Use $1, $2, ... placeholders for values; never build SQL from user input.
async function query(text, params) {
  const context = transactionContext.getStore();
  if (context) {
    return queryOn(context, text, params);
  }
  return getPool().query(text, params);
}

// Runs `work(tx)` inside ONE transaction: either every change it makes is kept
// (COMMIT) or none is (ROLLBACK). `tx.query(text, params)` and the module-level
// query() both use the same checked-out client. If `work` throws, the
// transaction is rolled back and the error is rethrown unchanged. With
// { dryRun: true } the changes are always rolled back, which lets a caller run
// real code, constraints included, and look at the outcome without keeping
// anything (used by the import preview). The client is always released; if the
// rollback itself fails (for example the connection died) it is destroyed
// instead of being returned to the pool.
async function runInTransaction(work, { dryRun = false } = {}) {
  if (transactionContext.getStore()) {
    throw new Error('runInTransaction() cannot be nested.');
  }

  const client = await getPool().connect();
  const context = { client, active: true };
  let discardClient = false;

  // While we hold the client, nobody else listens for its errors. If the
  // connection is lost, `pg` emits an 'error' event on the client; with no
  // listener Node would treat that as an uncaught exception and crash the
  // server. The failure still reaches us as a rejected query, so just log it.
  const onClientError = error => console.error('PostgreSQL connection error during a transaction:', error.message);
  client.on('error', onClientError);

  try {
    await client.query('BEGIN');
    const result = await transactionContext.run(context, () =>
      work({ query: (text, params) => queryOn(context, text, params) })
    );
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Usually "no transaction in progress" after a failed COMMIT (harmless).
      // If the connection itself is broken, do not put it back in the pool.
      discardClient = true;
    }
    throw error; // never swallowed
  } finally {
    context.active = false;
    client.removeListener('error', onClientError);
    client.release(discardClient);
  }
}

async function applyMigrations() {
  await runInTransaction(async () => {
    // Held until COMMIT/ROLLBACK, so a second server starting at the same time
    // waits here and then finds the migrations already done.
    await query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
    const current = rows[0].version;

    if (current > LATEST_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than this app understands (${LATEST_VERSION}).`
      );
    }

    // All pending steps share this one transaction (PostgreSQL can roll back
    // schema changes too), so a failure leaves the database exactly as it was.
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await query(migration.sql);
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    }
  });
}

async function openAndMigrate({ connectionString, schema, max }) {
  const candidate = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    types: poolTypes,
    // Lets the tests give every test file its own schema (see postgres-foundation.test.js).
    options: schema ? `-c search_path=${schema}` : undefined
  });

  // An idle connection can fail (server restarted, network drop). Without a
  // listener Node would treat that as an uncaught error and crash.
  candidate.on('error', error => {
    console.error('Unexpected PostgreSQL pool error:', error.message);
  });

  pool = candidate;

  try {
    await candidate.query('SELECT 1'); // fail fast with a clear message if unreachable
    await applyMigrations();
    return candidate;
  } catch (error) {
    pool = null;
    await candidate.end().catch(() => {});
    const friendly = describeConnectionProblem(error, connectionString);
    if (friendly) {
      throw new Error(friendly, { cause: error });
    }
    throw error;
  }
}

// Connects (using DATABASE_URL unless told otherwise) and brings the schema up
// to date. Throws if anything goes wrong, so the server never starts with a
// broken database. Safe to call more than once. Options (all optional):
//   connectionString  default process.env.DATABASE_URL
//   schema            use this PostgreSQL schema instead of "public" (tests)
//   max               maximum connections in the pool (default 10)
function initDatabase({ connectionString = process.env.DATABASE_URL, schema, max = 10 } = {}) {
  if (pool) return Promise.resolve(pool);
  if (initPromise) return initPromise;

  if (!connectionString) {
    return Promise.reject(new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and fill it in, or set the DATABASE_URL ' +
        'environment variable (postgres://USER:PASSWORD@HOST:5432/DATABASE).'
    ));
  }
  if (schema !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    return Promise.reject(new Error(`Invalid schema name "${schema}".`));
  }

  initPromise = openAndMigrate({ connectionString, schema, max }).finally(() => {
    initPromise = null;
  });
  return initPromise;
}

// Reports the real, current state by actually querying the database,
// rather than trusting a flag that was set at startup.
async function getStatus() {
  const status = { ready: false, engine: 'postgresql' };
  if (!pool) return status;

  try {
    const { rows } = await pool.query(
      `SELECT current_setting('server_version') AS server_version,
              (SELECT COALESCE(MAX(version), 0) FROM schema_migrations) AS schema_version`
    );
    status.serverVersion = rows[0].server_version;
    status.schemaVersion = rows[0].schema_version;
    status.ready = true;
  } catch (error) {
    status.ready = false;
  }
  return status;
}

// Waits for checked-out clients to be released, then closes every connection.
// Safe to call more than once.
async function closeDatabase() {
  const closing = pool;
  pool = null;
  if (!closing) return;
  await closing.end();
}

module.exports = {
  initDatabase,
  getPool,
  query,
  runInTransaction,
  getStatus,
  closeDatabase,
  describeConnectionProblem,
  MIGRATIONS,
  LATEST_VERSION
};
