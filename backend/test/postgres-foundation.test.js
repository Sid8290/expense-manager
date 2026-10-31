'use strict';

// Part 1 tests: the PostgreSQL foundation (backend/db.js and backend/db-errors.js).
//
// These run against a REAL PostgreSQL server. Set TEST_DATABASE_URL to a
// database that exists only for testing (see .env.example and docs). Every
// test works inside its own throw-away schema (em_test_<random>) which is
// dropped afterwards, so nothing in your real database is ever read or changed.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client, types: pgTypes } = require('pg');

const db = require('../db');
const errors = require('../db-errors');

const TEST_URL = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Safety checks. These stop the whole file before anything is created.
// ---------------------------------------------------------------------------

function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

if (!TEST_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. These tests need a PostgreSQL database used ONLY for testing, ' +
      'for example postgres://expense_user:PASSWORD@127.0.0.1:5432/expense_manager_test (see .env.example).'
  );
}
if (!/test/i.test(databaseName(TEST_URL))) {
  throw new Error(`Refusing to run: the TEST_DATABASE_URL database name "${databaseName(TEST_URL)}" does not contain "test".`);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === TEST_URL) {
  throw new Error('Refusing to run: TEST_DATABASE_URL is the same as DATABASE_URL.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdSchemas = [];

async function admin(sql) {
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function newSchema() {
  const name = `em_test_${crypto.randomBytes(6).toString('hex')}`;
  await admin(`CREATE SCHEMA ${name}`);
  createdSchemas.push(name);
  return name;
}

// Closes any open pool and opens a fresh one on a brand-new empty schema.
async function openFresh(options = {}) {
  await db.closeDatabase();
  const schema = await newSchema();
  await db.initDatabase({ connectionString: TEST_URL, schema, ...options });
  return schema;
}

// Returns a copy of TEST_URL with some parts replaced.
function urlWith({ port, password, database } = {}) {
  const url = new URL(TEST_URL);
  if (port !== undefined) url.port = String(port);
  if (password !== undefined) url.password = password;
  if (database !== undefined) url.pathname = '/' + database;
  return url.toString();
}

async function addAccount(id = 'acc-1', name = 'Cash', type = 'cash', balance = 0) {
  await db.query('INSERT INTO accounts (id, name, type, balance_minor) VALUES ($1, $2, $3, $4)', [id, name, type, balance]);
}

async function addCategory(name = 'Salary', type = 'income') {
  const { rows } = await db.query('INSERT INTO categories (name, type) VALUES ($1, $2) RETURNING id', [name, type]);
  return rows[0].id;
}

async function addTransaction(overrides = {}) {
  const row = {
    id: 'txn-1', type: 'income', description: 'Pay', categoryId: null, accountId: 'acc-1',
    amount: 1234, note: '', date: '2025-01-31', createdAt: 1700000000000, ...overrides
  };
  await db.query(
    `INSERT INTO transactions (id, type, description, category_id, account_id, amount_minor, note, date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.id, row.type, row.description, row.categoryId, row.accountId, row.amount, row.note, row.date, row.createdAt]
  );
}

// Runs `action` and returns the error it throws (fails the test if it does not throw).
async function errorOf(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected the action to throw an error');
}

const countOf = async table => (await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n;

after(async () => {
  await db.closeDatabase();
  for (const schema of createdSchemas) {
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
});

// ---------------------------------------------------------------------------
// 1. Error helpers (no database needed)
// ---------------------------------------------------------------------------

describe('db-errors: recognizing constraint errors by SQLSTATE', () => {
  test('each helper matches only its own code', () => {
    const unique = { code: '23505' };
    const foreignKey = { code: '23503' };
    const check = { code: '23514' };
    assert.ok(errors.isUniqueViolation(unique) && !errors.isUniqueViolation(foreignKey));
    assert.ok(errors.isForeignKeyViolation(foreignKey) && !errors.isForeignKeyViolation(check));
    assert.ok(errors.isCheckViolation(check) && !errors.isCheckViolation(unique));
    assert.ok([unique, foreignKey, check, { code: '23502' }].every(errors.isConstraintViolation));
    assert.ok(!errors.isConstraintViolation({ code: '42P01' }));
  });

  test('odd inputs never throw and match nothing', () => {
    for (const value of [undefined, null, 'text', 42, {}, { code: 23505 }, new Error('x')]) {
      assert.equal(errors.isUniqueViolation(value), false);
      assert.equal(errors.isConstraintViolation(value), false);
      assert.equal(errors.describeConstraintError(value), null);
    }
  });

  test('the API answer for each kind matches what the SQLite version sent', () => {
    assert.deepEqual(errors.describeConstraintError({ code: '23505' }), { status: 409, code: 'CONFLICT', message: 'That value already exists.' });
    assert.deepEqual(errors.describeConstraintError({ code: '23503' }), { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'The record is linked to other records.' });
    assert.deepEqual(errors.describeConstraintError({ code: '23514' }), { status: 400, code: 'VALIDATION_ERROR', message: 'The request contains invalid data.' });
    assert.equal(errors.describeConstraintError({ code: '42P01' }), null);
  });
});

// ---------------------------------------------------------------------------
// 2. Connecting
// ---------------------------------------------------------------------------

describe('connection', () => {
  test('connects, reports its real status, and uses the test schema', async () => {
    const schema = await openFresh();
    const status = await db.getStatus();
    assert.equal(status.ready, true);
    assert.equal(status.engine, 'postgresql');
    assert.equal(status.schemaVersion, db.LATEST_VERSION);
    assert.match(status.serverVersion, /^\d+/);
    const { rows } = await db.query('SELECT current_schema() AS schema');
    assert.equal(rows[0].schema, schema);
  });

  test('status is "not ready" before initialization and after closing', async () => {
    await db.closeDatabase();
    assert.deepEqual(await db.getStatus(), { ready: false, engine: 'postgresql' });
    await assert.rejects(db.query('SELECT 1'), /not initialized/);
    assert.throws(() => db.getPool(), /not initialized/);
  });

  test('calling initDatabase twice (even at once) shares one pool', async () => {
    await db.closeDatabase();
    const schema = await newSchema();
    const [a, b] = await Promise.all([
      db.initDatabase({ connectionString: TEST_URL, schema }),
      db.initDatabase({ connectionString: TEST_URL, schema })
    ]);
    assert.equal(a, b);
    assert.equal(await db.initDatabase(), a);
  });

  test('a missing DATABASE_URL gives a clear message', async () => {
    await db.closeDatabase();
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(db.initDatabase(), /DATABASE_URL is not set.*\.env\.example/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  test('an invalid schema name is refused (it ends up in a SQL option)', async () => {
    await db.closeDatabase();
    await assert.rejects(db.initDatabase({ connectionString: TEST_URL, schema: 'x; DROP SCHEMA public' }), /Invalid schema name/);
  });

  test('nothing listening: says so, names host and port, leaves no pool behind', async () => {
    await db.closeDatabase();
    const error = await errorOf(() => db.initDatabase({ connectionString: urlWith({ port: 1 }) }));
    assert.match(error.message, /Cannot connect to PostgreSQL at .*:1\. Is the server running\?/);
    assert.equal((await db.getStatus()).ready, false);
  });

  test('wrong password: clear message that does not repeat the password', async () => {
    await db.closeDatabase();
    const secret = 'definitely-not-the-password-9X';
    const error = await errorOf(() => db.initDatabase({ connectionString: urlWith({ password: secret }) }));
    assert.match(error.message, /rejected the user name or password/);
    assert.ok(!error.message.includes(secret), 'the password must never appear in the message');
  });

  test('database does not exist: clear message', async () => {
    await db.closeDatabase();
    const error = await errorOf(() => db.initDatabase({ connectionString: urlWith({ database: 'em_test_no_such_database' }) }));
    assert.match(error.message, /database "em_test_no_such_database" does not exist/);
  });

  test('a malformed URL is reported as such, without echoing it', async () => {
    await db.closeDatabase();
    const error = await errorOf(() => db.initDatabase({ connectionString: 'not a url with secret:pw' }));
    assert.match(error.message, /not a valid PostgreSQL connection URL/);
    assert.ok(!error.message.includes('secret:pw'));
  });
});

// ---------------------------------------------------------------------------
// 3. Migrations and schema
// ---------------------------------------------------------------------------

describe('migrations', () => {
  test('a fresh database gets every migration, and the tables start empty', async () => {
    const schema = await openFresh();
    const versions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
    assert.deepEqual(versions, db.MIGRATIONS.map(m => m.version));
    const tables = (await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema]
    )).rows.map(r => r.table_name);
    assert.deepEqual(tables, ['accounts', 'app_meta', 'categories', 'schema_migrations', 'transactions']);
    for (const table of ['accounts', 'categories', 'transactions']) {
      assert.equal(await countOf(table), 0, `${table} starts empty`);
    }
    const meta = (await db.query(`SELECT value FROM app_meta WHERE key = 'created_at'`)).rows[0].value;
    assert.match(meta, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('running again does not repeat any step (same rows, same timestamps)', async () => {
    const schema = await openFresh();
    const before = (await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    const metaBefore = (await db.query(`SELECT value FROM app_meta`)).rows;
    await db.closeDatabase();
    await db.initDatabase({ connectionString: TEST_URL, schema });
    const after = (await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(after, before);
    assert.deepEqual((await db.query(`SELECT value FROM app_meta`)).rows, metaBefore);
  });

  test('data survives closing and reopening (persistence)', async () => {
    const schema = await openFresh();
    await addAccount('acc-keep', 'Kept', 'bank', 500);
    await db.closeDatabase();
    await db.initDatabase({ connectionString: TEST_URL, schema });
    const { rows } = await db.query('SELECT id, balance_minor FROM accounts');
    assert.deepEqual(rows, [{ id: 'acc-keep', balance_minor: 500 }]);
  });

  test('a database from a newer app version is refused, and left untouched', async () => {
    const schema = await openFresh();
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [db.LATEST_VERSION + 1]);
    await db.closeDatabase();
    await assert.rejects(db.initDatabase({ connectionString: TEST_URL, schema }), /newer than this app understands/);
    assert.equal((await db.getStatus()).ready, false);
  });

  test('a failing step rolls back completely and does not record its version', async () => {
    await db.closeDatabase();
    const schema = await newSchema();
    // Break step 2 by pre-creating one of its tables with a different shape.
    await admin(`CREATE TABLE ${schema}.categories (oops INTEGER)`);
    await assert.rejects(db.initDatabase({ connectionString: TEST_URL, schema }), /categories/);
    const left = (await admin(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`
    )).rows.map(r => r.table_name);
    // Step 1 (app_meta) and step 2 are in one transaction: nothing but our own table remains.
    assert.deepEqual(left, ['categories']);
  });

  test('two servers starting at the same time migrate a new database safely', async () => {
    await db.closeDatabase();
    const schema = await newSchema();
    const script = `
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      db.initDatabase({ connectionString: process.env.TEST_DATABASE_URL, schema: process.env.SCHEMA })
        .then(() => db.closeDatabase()).then(() => process.exit(0))
        .catch(error => { console.error(error.message); process.exit(1); });
    `;
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, TEST_DATABASE_URL: TEST_URL, SCHEMA: schema } });
      let output = '';
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('exit', code => resolve({ code, output }));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert.deepEqual(results.map(r => r.code), [0, 0, 0], results.map(r => r.output).join('|'));
    const { rows } = await admin(`SELECT version FROM ${schema}.schema_migrations ORDER BY version`);
    assert.deepEqual(rows.map(r => r.version), db.MIGRATIONS.map(m => m.version));
  });

  test('the schema has the expected constraints, indexes and foreign keys', async () => {
    const schema = await openFresh();
    const constraints = (await db.query(
      `SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = $1::regnamespace ORDER BY 1, 2, 3`, [schema]
    )).rows;
    const find = (table, type, text) => constraints.some(c => c.table_name.endsWith(table) && c.contype === type && c.def.includes(text));
    assert.ok(find('transactions', 'f', 'FOREIGN KEY (category_id, type) REFERENCES'), 'composite category FK');
    assert.ok(find('transactions', 'f', 'ON DELETE RESTRICT'), 'RESTRICT delete');
    assert.ok(find('transactions', 'f', 'FOREIGN KEY (account_id) REFERENCES'), 'account FK');
    assert.ok(find('categories', 'u', 'UNIQUE (id, type)'), 'unique (id, type)');
    const indexes = (await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [schema])).rows.map(r => r.indexname);
    for (const name of ['accounts_name_unique', 'categories_type_name_unique', 'idx_transactions_account', 'idx_transactions_category', 'idx_transactions_date']) {
      assert.ok(indexes.includes(name), `index ${name}`);
    }
    const columns = (await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1`, [schema]
    )).rows;
    const typeOf = (table, column) => columns.find(c => c.table_name === table && c.column_name === column).data_type;
    assert.equal(typeOf('transactions', 'amount_minor'), 'bigint');
    assert.equal(typeOf('transactions', 'created_at'), 'bigint');
    assert.equal(typeOf('accounts', 'balance_minor'), 'bigint');
    assert.equal(typeOf('transactions', 'date'), 'text');
    assert.equal(typeOf('categories', 'id'), 'integer');
  });
});

// ---------------------------------------------------------------------------
// 4. Constraints enforced by the database itself
// ---------------------------------------------------------------------------

describe('constraints', () => {
  before(async () => { await openFresh(); });
  beforeEach(async () => {
    await db.query('TRUNCATE transactions, categories, accounts RESTART IDENTITY');
  });

  test('foreign keys: a transaction needs an existing account and category', async () => {
    const category = await addCategory();
    await addAccount();
    const noAccount = await errorOf(() => addTransaction({ accountId: 'ghost', categoryId: category }));
    assert.ok(errors.isForeignKeyViolation(noAccount), noAccount.message);
    const noCategory = await errorOf(() => addTransaction({ categoryId: 9999 }));
    assert.ok(errors.isForeignKeyViolation(noCategory), noCategory.message);
    assert.equal(await countOf('transactions'), 0);
  });

  test('a transaction can only use a category of its own type', async () => {
    await addAccount();
    const expense = await addCategory('Food', 'expense');
    const error = await errorOf(() => addTransaction({ type: 'income', categoryId: expense }));
    assert.ok(errors.isForeignKeyViolation(error), error.message);
    await addTransaction({ type: 'expense', categoryId: expense }); // the matching type is fine
    assert.equal(await countOf('transactions'), 1);
  });

  test('records in use cannot be deleted or have their type changed (RESTRICT)', async () => {
    const category = await addCategory();
    await addAccount();
    await addTransaction({ categoryId: category });
    assert.ok(errors.isForeignKeyViolation(await errorOf(() => db.query('DELETE FROM accounts WHERE id = $1', ['acc-1']))));
    assert.ok(errors.isForeignKeyViolation(await errorOf(() => db.query('DELETE FROM categories WHERE id = $1', [category]))));
    assert.ok(errors.isForeignKeyViolation(await errorOf(() => db.query(`UPDATE categories SET type = 'expense' WHERE id = $1`, [category]))));
    assert.equal(await countOf('accounts'), 1);
    assert.equal(await countOf('categories'), 1);
    // Renaming is allowed, and deleting is allowed once nothing uses the record.
    await db.query(`UPDATE categories SET name = 'Pay' WHERE id = $1`, [category]);
    await db.query('DELETE FROM transactions WHERE id = $1', ['txn-1']);
    await db.query('DELETE FROM categories WHERE id = $1', [category]);
    await db.query('DELETE FROM accounts WHERE id = $1', ['acc-1']);
  });

  test('CHECK constraints reject bad values', async () => {
    const category = await addCategory();
    await addAccount();
    const bad = {
      'account type': () => addAccount('a2', 'Wallet', 'wallet'),
      'negative opening balance': () => addAccount('a3', 'Neg', 'cash', -1),
      'opening balance above the limit': () => addAccount('a4', 'Big', 'cash', 100000000001),
      'empty account name': () => addAccount('a5', '', 'cash'),
      'account name over 40 characters': () => addAccount('a6', 'x'.repeat(41), 'cash'),
      'category type': () => db.query(`INSERT INTO categories (name, type) VALUES ('X', 'other')`),
      'category name over 30 characters': () => addCategory('y'.repeat(31), 'income'),
      'transaction type': () => addTransaction({ type: 'transfer', categoryId: category }),
      'zero amount': () => addTransaction({ categoryId: category, amount: 0 }),
      'amount above the limit': () => addTransaction({ categoryId: category, amount: 100000000001 }),
      'empty description': () => addTransaction({ categoryId: category, description: '' }),
      'note over 200 characters': () => addTransaction({ categoryId: category, note: 'n'.repeat(201) }),
      'date not in YYYY-MM-DD form': () => addTransaction({ categoryId: category, date: '31/01/2025' }),
      'negative created_at': () => addTransaction({ categoryId: category, createdAt: -1 }),
      'empty id': () => addTransaction({ categoryId: category, id: '' })
    };
    for (const [label, action] of Object.entries(bad)) {
      const error = await errorOf(action);
      assert.ok(errors.isCheckViolation(error), `${label}: expected a CHECK violation but got ${error.code} ${error.message}`);
    }
    assert.equal(await countOf('transactions'), 0);
  });

  test('values exactly at the limits are accepted', async () => {
    const category = await addCategory('N'.repeat(30), 'income');
    await addAccount('a'.repeat(64), 'N'.repeat(40), 'cash', 100000000000);
    await addTransaction({ id: 't'.repeat(64), accountId: 'a'.repeat(64), categoryId: category, amount: 100000000000, description: 'd'.repeat(100), note: 'n'.repeat(200) });
    assert.equal(await countOf('transactions'), 1);
  });

  test('account names are unique ignoring case', async () => {
    await addAccount('a1', 'Cash');
    for (const name of ['CASH', 'cash', 'cAsH']) {
      const error = await errorOf(() => addAccount('x-' + name, name));
      assert.ok(errors.isUniqueViolation(error), `${name}: ${error.message}`);
    }
    assert.ok(errors.isUniqueViolation(await errorOf(() => addAccount('a1', 'Other'))), 'duplicate id');
    assert.equal(await countOf('accounts'), 1);
  });

  test('category names are unique per type, ignoring case', async () => {
    await addCategory('Food', 'expense');
    assert.ok(errors.isUniqueViolation(await errorOf(() => addCategory('FOOD', 'expense'))));
    await addCategory('Food', 'income'); // same name, other type: allowed
    assert.equal(await countOf('categories'), 2);
  });

  test('NOT NULL is enforced (SQLSTATE 23502 is recognized too)', async () => {
    const error = await errorOf(() => db.query(`INSERT INTO accounts (id, name, type) VALUES ('a', 'n', 'cash')`));
    assert.ok(errors.isNotNullViolation(error), error.message);
    assert.ok(errors.isConstraintViolation(error));
  });

  test('a rejected statement does not damage the pool: later queries still work', async () => {
    await errorOf(() => addAccount('a1', 'x', 'wallet'));
    await addAccount('a2', 'Fine');
    assert.equal(await countOf('accounts'), 1);
  });
});

// ---------------------------------------------------------------------------
// 5. Identity columns, RETURNING and ordering
// ---------------------------------------------------------------------------

describe('identity columns and ordering', () => {
  before(async () => { await openFresh(); });
  beforeEach(async () => {
    await db.query('TRUNCATE transactions, categories, accounts RESTART IDENTITY');
  });

  test('INSERT ... RETURNING gives the new category id as a number', async () => {
    const first = await addCategory('A', 'income');
    const second = await addCategory('B', 'income');
    assert.equal(typeof first, 'number');
    assert.equal(second, first + 1);
  });

  test('ids cannot be forced (GENERATED ALWAYS) and failed inserts do not break the sequence', async () => {
    const error = await errorOf(() => db.query(`INSERT INTO categories (id, name, type) VALUES (7, 'X', 'income')`));
    assert.equal(error.code, '428C9');
    const id = await addCategory('Y', 'income');
    assert.equal(typeof id, 'number');
  });

  test('seq keeps insertion order for accounts and transactions (the old rowid)', async () => {
    const category = await addCategory();
    for (const name of ['Zeta', 'Alpha', 'Mid']) await addAccount(`id-${name}`, name);
    for (const id of ['t-b', 't-a', 't-c']) await addTransaction({ id, accountId: 'id-Zeta', categoryId: category });
    const accounts = (await db.query('SELECT name FROM accounts ORDER BY seq')).rows.map(r => r.name);
    const transactions = (await db.query('SELECT id FROM transactions ORDER BY seq')).rows.map(r => r.id);
    assert.deepEqual(accounts, ['Zeta', 'Alpha', 'Mid']);
    assert.deepEqual(transactions, ['t-b', 't-a', 't-c']);
  });
});

// ---------------------------------------------------------------------------
// 6. Numbers: integer paise and large integers
// ---------------------------------------------------------------------------

describe('numbers', () => {
  before(async () => { await openFresh(); });
  beforeEach(async () => {
    await db.query('TRUNCATE transactions, categories, accounts RESTART IDENTITY');
  });

  test('BIGINT, COUNT and SUM come back as exact JavaScript numbers', async () => {
    const category = await addCategory();
    await addAccount('acc-1', 'Cash', 'cash', 100000000000);
    for (let i = 0; i < 3; i += 1) {
      await addTransaction({ id: `t-${i}`, categoryId: category, amount: 100000000000, createdAt: 1700000000000 + i });
    }
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n, SUM(amount_minor) AS total, MAX(created_at) AS newest, MIN(amount_minor) AS smallest
         FROM transactions`
    );
    assert.deepEqual(rows[0], { n: 3, total: 300000000000, newest: 1700000000002, smallest: 100000000000 });
    assert.equal(typeof rows[0].n, 'number');
    assert.equal(typeof rows[0].total, 'number');
    // A value above 2^31 round-trips exactly (it would overflow a 32-bit column).
    const stored = (await db.query('SELECT amount_minor, created_at FROM transactions WHERE id = $1', ['t-0'])).rows[0];
    assert.deepEqual(stored, { amount_minor: 100000000000, created_at: 1700000000000 });
  });

  test('integer paise arithmetic is exact (no floating-point drift)', async () => {
    const category = await addCategory();
    await addAccount('acc-1', 'Cash', 'cash', 10);
    await addTransaction({ id: 't1', categoryId: category, amount: 20 }); // 0.20
    await addTransaction({ id: 't2', categoryId: category, amount: 10, createdAt: 1700000000001 }); // 0.10
    const { rows } = await db.query(
      `SELECT a.balance_minor + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount_minor ELSE -t.amount_minor END), 0) AS current_minor
         FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id WHERE a.id = $1 GROUP BY a.id`, ['acc-1']
    );
    assert.equal(rows[0].current_minor, 40);
    assert.equal(rows[0].current_minor / 100, 0.4);
    assert.notEqual(0.1 + 0.2, 0.3, 'sanity: plain floats would drift');
  });

  test('an empty SUM is NULL, so callers must COALESCE it', async () => {
    const { rows } = await db.query('SELECT SUM(amount_minor) AS total, COUNT(*) AS n FROM transactions');
    assert.deepEqual(rows[0], { total: null, n: 0 });
  });

  test('a number too large to be exact is an error, never silent rounding', async () => {
    const error = await errorOf(() => db.query('SELECT 9007199254740993::bigint AS big'));
    assert.ok(error instanceof RangeError, String(error));
    assert.match(error.message, /too large/);
    const numeric = await errorOf(() => db.query('SELECT 9007199254740993::numeric AS big'));
    assert.ok(numeric instanceof RangeError);
  });

  test('decimals and other types are left alone', async () => {
    const { rows } = await db.query(`SELECT 1.5::numeric AS d, 7::int4 AS i, 'x'::text AS t, true AS b, '2025-01-31'::date AS dt`);
    assert.equal(rows[0].d, '1.5');
    assert.equal(rows[0].i, 7);
    assert.equal(rows[0].t, 'x');
    assert.equal(rows[0].b, true);
    assert.ok(rows[0].dt instanceof Date);
    assert.equal(typeof (await db.query(`SELECT 5::numeric AS whole`)).rows[0].whole, 'number');
  });

  test('the conversion is attached to this pool only; pg itself is unchanged', () => {
    assert.equal(pgTypes.getTypeParser(20)('9007199254740993'), '9007199254740993');
    assert.equal(typeof pgTypes.getTypeParser(20)('5'), 'string');
  });
});

// ---------------------------------------------------------------------------
// 7. Transactions
// ---------------------------------------------------------------------------

describe('runInTransaction', () => {
  before(async () => { await openFresh({ max: 3 }); });
  beforeEach(async () => {
    await db.query('TRUNCATE transactions, categories, accounts RESTART IDENTITY');
  });

  const poolIsHealthy = () => {
    const pool = db.getPool();
    assert.equal(pool.waitingCount, 0, 'nobody is waiting for a client');
    assert.equal(pool.idleCount, pool.totalCount, 'every client has been given back');
  };

  test('commit keeps the changes and returns the result of the work', async () => {
    const result = await db.runInTransaction(async tx => {
      await tx.query(`INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a1', 'One', 'cash', 1)`);
      await db.query(`INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a2', 'Two', 'cash', 2)`);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(await countOf('accounts'), 2);
    poolIsHealthy();
  });

  test('an error rolls everything back and is rethrown unchanged', async () => {
    const failure = new Error('boom');
    const caught = await errorOf(() => db.runInTransaction(async () => {
      await db.query(`INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a1', 'One', 'cash', 1)`);
      throw failure;
    }));
    assert.equal(caught, failure, 'the very same error object');
    assert.equal(await countOf('accounts'), 0);
    poolIsHealthy();
  });

  test('a database error halfway through undoes the earlier statements', async () => {
    const caught = await errorOf(() => db.runInTransaction(async () => {
      await addAccount('a1', 'One');
      await addAccount('a2', 'ONE'); // case-insensitive duplicate
    }));
    assert.ok(errors.isUniqueViolation(caught));
    assert.equal(await countOf('accounts'), 0);
    poolIsHealthy();
  });

  test('every query inside one transaction uses the same connection; outside it does not', async () => {
    const pid = tx => tx.query('SELECT pg_backend_pid() AS pid').then(r => r.rows[0].pid);
    const inside = await db.runInTransaction(async tx => [await pid(tx), await pid({ query: db.query }), await pid(tx)]);
    assert.equal(new Set(inside).size, 1, `pids inside: ${inside}`);
    // A transaction's own changes are invisible to other connections until COMMIT.
    await db.runInTransaction(async () => {
      await addAccount('a1', 'Hidden');
      const other = await admin('SELECT 1'); // unrelated connection, sanity only
      assert.equal(other.rowCount, 1);
      const pool = db.getPool();
      const { rows } = await pool.query('SELECT COUNT(*) AS n FROM accounts');
      assert.equal(rows[0].n, 0, 'another connection must not see uncommitted rows');
    });
    assert.equal(await countOf('accounts'), 1);
  });

  test('dry run: constraints really fire inside it, and still nothing is kept', async () => {
    const result = await db.runInTransaction(async () => {
      await addAccount('a1', 'Preview');
      const inside = await countOf('accounts');
      const duplicate = await errorOf(() => addAccount('a2', 'PREVIEW'));
      return { inside, sqlstate: duplicate.code };
    }, { dryRun: true });
    assert.deepEqual(result, { inside: 1, sqlstate: '23505' });
    assert.equal(await countOf('accounts'), 0);
    poolIsHealthy();
  });

  test('dry run with valid work returns its result and rolls back', async () => {
    const result = await db.runInTransaction(async () => {
      await addAccount('a1', 'Preview');
      return await countOf('accounts');
    }, { dryRun: true });
    assert.equal(result, 1, 'the work saw its own changes');
    assert.equal(await countOf('accounts'), 0, 'but none were kept');
  });

  test('clients are released after errors: many failures in a row do not exhaust a pool of 3', async () => {
    for (let i = 0; i < 12; i += 1) {
      await errorOf(() => db.runInTransaction(async () => { throw new Error(`fail ${i}`); }));
      await errorOf(() => db.runInTransaction(async () => addAccount('dup', 'Same')).then(() => addAccount('dup', 'Same')));
      await db.query('DELETE FROM accounts');
    }
    poolIsHealthy();
    await db.runInTransaction(async () => addAccount('ok', 'Still fine'));
    assert.equal(await countOf('accounts'), 1);
  });

  test('concurrent transactions do not mix up their changes', async () => {
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) =>
      db.runInTransaction(async () => {
        await addAccount(`acc-${i}`, `Account ${i}`);
        if (i % 3 === 0) throw new Error('rollback me');
      })
    ));
    assert.equal(results.filter(r => r.status === 'rejected').length, 3);
    const ids = (await db.query('SELECT id FROM accounts ORDER BY id')).rows.map(r => r.id);
    assert.deepEqual(ids, ['acc-1', 'acc-2', 'acc-4', 'acc-5', 'acc-7', 'acc-8']);
    poolIsHealthy();
  });

  test('nesting is refused with a clear error, and the outer transaction rolls back', async () => {
    const error = await errorOf(() => db.runInTransaction(async () => {
      await addAccount('a1', 'Outer');
      await db.runInTransaction(async () => {});
    }));
    assert.match(error.message, /cannot be nested/);
    assert.equal(await countOf('accounts'), 0);
    poolIsHealthy();
  });

  test('a transaction handle cannot be used after the transaction ended', async () => {
    let leaked;
    await db.runInTransaction(async tx => { leaked = tx; });
    await assert.rejects(leaked.query('SELECT 1'), /already finished/);
  });

  test('if the connection dies, the error is still thrown, the broken client is discarded and the pool recovers', async () => {
    const killed = await errorOf(() => db.runInTransaction(async tx => {
      const { rows } = await tx.query('SELECT pg_backend_pid() AS pid');
      await admin(`SELECT pg_terminate_backend(${rows[0].pid})`);
      await tx.query('SELECT 1'); // fails: the connection is gone
    }));
    assert.ok(killed instanceof Error);
    // The pool must hand out a working connection next time.
    assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok, 1);
    await db.runInTransaction(async () => addAccount('after', 'After crash'));
    assert.equal(await countOf('accounts'), 1);
    poolIsHealthy();
  });

  test('a failure when calling runInTransaction before init is a clear error', async () => {
    const schema = await newSchema();
    await db.closeDatabase();
    await assert.rejects(db.runInTransaction(async () => {}), /not initialized/);
    await db.initDatabase({ connectionString: TEST_URL, schema, max: 3 });
  });
});

// ---------------------------------------------------------------------------
// 8. Shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  test('closeDatabase ends the pool, is safe to repeat, and later use fails clearly', async () => {
    await openFresh();
    const pool = db.getPool();
    await db.closeDatabase();
    assert.equal(pool.ended, true);
    assert.equal(pool.totalCount, 0);
    await db.closeDatabase(); // second call: no error
    await assert.rejects(db.query('SELECT 1'), /not initialized/);
    assert.equal((await db.getStatus()).ready, false);
  });

  test('closing waits for a running transaction to finish instead of cutting it off', async () => {
    await openFresh();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let closed = false;
    const running = db.runInTransaction(async () => {
      await addAccount('a1', 'In flight');
      await gate;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const closing = db.closeDatabase().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(closed, false, 'still open while a transaction is running');
    release();
    await running;
    await closing;
    assert.equal(closed, true);
  });

  test('the database can be opened again after closing, and the committed data is there', async () => {
    const schema = await openFresh();
    await addAccount('a1', 'Persisted');
    await db.closeDatabase();
    await db.initDatabase({ connectionString: TEST_URL, schema });
    assert.equal(await countOf('accounts'), 1);
  });
});
