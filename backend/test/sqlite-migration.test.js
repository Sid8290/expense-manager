'use strict';

// Tests for the optional SQLite-to-PostgreSQL migration tool
// (backend/tools/sqlite-to-postgres.js). Run with:  npm run test:migration
//
// The legacy SQLite files are built in the OS temp folder by
// helpers/legacy-sqlite.js. PostgreSQL is a throw-away schema in TEST_DATABASE_URL.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const db = require('../db');
const { migrate, MigrationError } = require('../tools/sqlite-to-postgres');
const { TEST_URL, createTestSchema } = require('./helpers/pg-test-db');
const { createLegacyDb } = require('./helpers/legacy-sqlite');

const TOOL = path.join(__dirname, '..', 'tools', 'sqlite-to-postgres.js');
let tmp;
let testSchema;
let fileCounter = 0;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-migration-test-'));
  testSchema = await createTestSchema();
  await db.initDatabase({ connectionString: TEST_URL, schema: testSchema.schema });
});

after(async () => {
  await db.closeDatabase();
  await testSchema.drop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.query('DROP TRIGGER IF EXISTS boom ON transactions');
  await db.query('DROP FUNCTION IF EXISTS boom_fail()');
  await db.query('DELETE FROM transactions');
  await db.query('DELETE FROM categories');
  await db.query('DELETE FROM accounts');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const newFile = () => path.join(tmp, `legacy-${(fileCounter += 1)}.db`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Category ids 1, 2 and 5 (3 and 4 were deleted in the old app), so the tool must keep the ids, not renumber.
const legacyData = () => ({
  accounts: [
    { id: 'acc-cash', name: 'Cash', type: 'cash', balance_minor: 10000 },
    { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance_minor: 50000000 },
    { id: 'acc-loan', name: 'Loan', type: 'payable', balance_minor: 0 }
  ],
  categories: [
    { id: 1, name: 'Groceries', type: 'expense' },
    { id: 2, name: 'Salary', type: 'income' },
    { id: 5, name: 'Other', type: 'expense' }
  ],
  transactions: [
    { id: 'txn-a', type: 'expense', description: 'Milk', category_id: 1, account_id: 'acc-cash', amount_minor: 1, note: 'one paisa', date: '2025-01-05', created_at: 1736000000001 },
    { id: 'txn-b', type: 'income', description: 'Pay', category_id: 2, account_id: 'acc-bank', amount_minor: 100000000000, note: '', date: '2025-01-31', created_at: 1736000000002 },
    { id: 'txn-c', type: 'expense', description: "Bob's \"café\" ; DROP TABLE accounts; --", category_id: 5, account_id: 'acc-cash', amount_minor: 1999, note: 'ünï', date: '2024-02-29', created_at: 0 },
    { id: 'txn-d', type: 'expense', description: 'Same text', category_id: 1, account_id: 'acc-bank', amount_minor: 7, note: '', date: '2025-01-05', created_at: 1736000000004 },
    { id: 'txn-e', type: 'expense', description: 'Same text', category_id: 1, account_id: 'acc-bank', amount_minor: 7, note: '', date: '2025-01-05', created_at: 1736000000004 }
  ]
});

const counts = async () => {
  const n = async table => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  return { accounts: await n('accounts'), categories: await n('categories'), transactions: await n('transactions') };
};
const dump = async () => ({
  accounts: (await db.query('SELECT id, name, type, balance_minor FROM accounts ORDER BY seq')).rows,
  categories: (await db.query('SELECT id, name, type FROM categories ORDER BY id')).rows,
  transactions: (await db.query('SELECT * FROM transactions ORDER BY seq')).rows
});

const described = report => report.conflicts.map(c => `${c.entity} ${c.id}: ${c.reason}`).join('\n');
const apply = file => migrate({ sourcePath: file, apply: true });
const preview = file => migrate({ sourcePath: file });

// ---------------------------------------------------------------------------
// Preview, apply, accuracy
// ---------------------------------------------------------------------------

describe('preview', () => {
  test('reports the counts, saves nothing, and never touches the SQLite file', async () => {
    const file = createLegacyDb(newFile(), legacyData());
    const before = { hash: sha(file), mtime: fs.statSync(file).mtimeMs, dir: fs.readdirSync(tmp).sort() };

    const report = await preview(file);
    assert.equal(report.status, 'preview-ok');
    assert.equal(report.mode, 'preview');
    assert.equal(report.saved, false);
    assert.deepEqual(report.source, { accounts: 3, categories: 3, transactions: 5 });
    assert.deepEqual(report.toInsert, { accounts: 3, categories: 3, transactions: 5 });
    assert.deepEqual(report.alreadyMigrated, { accounts: 0, categories: 0, transactions: 0 });
    assert.deepEqual(report.verified, { accounts: 3, categories: 3, transactions: 5 }, 'the rows really went in (inside the rolled-back transaction)');

    assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 });
    assert.equal(sha(file), before.hash);
    assert.equal(fs.statSync(file).mtimeMs, before.mtime);
    assert.deepEqual(fs.readdirSync(tmp).sort(), before.dir, 'no journal or other file appeared next to it');
  });

  test('a preview followed by the real run gives the same plan', async () => {
    const file = createLegacyDb(newFile(), legacyData());
    const previewed = await preview(file);
    const applied = await apply(file);
    assert.deepEqual(applied.toInsert, previewed.toInsert);
    assert.equal(applied.status, 'migrated');
    assert.equal(applied.saved, true);
  });
});

describe('apply', () => {
  test('copies every record exactly: ids, amounts, dates, notes, creation times and order', async () => {
    const data = legacyData();
    const file = createLegacyDb(newFile(), data);
    const hash = sha(file);

    const report = await apply(file);
    assert.equal(report.status, 'migrated');
    assert.deepEqual(await counts(), { accounts: 3, categories: 3, transactions: 5 });

    const stored = await dump();
    assert.deepEqual(stored.accounts, data.accounts);
    assert.deepEqual(stored.categories, data.categories, 'category ids 1, 2 and 5 are kept');
    assert.deepEqual(stored.transactions.map(({ seq, ...row }) => row), data.transactions.map(t => ({ ...t })), 'including 1 paisa, 1e9 rupees, quotes, accents, created_at 0 and the insertion order');
    assert.equal(sha(file), hash, 'the SQLite file is unchanged');
  });

  test('relationships and balances are right, seen through the normal queries', async () => {
    const file = createLegacyDb(newFile(), legacyData());
    await apply(file);

    const { rows } = await db.query(`
      SELECT a.id, a.balance_minor + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount_minor ELSE -t.amount_minor END), 0)::bigint AS current_minor
      FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id ORDER BY a.id`);
    assert.deepEqual(rows.map(r => [r.id, Number(r.current_minor)]), [
      ['acc-bank', 50000000 + 100000000000 - 7 - 7],
      ['acc-cash', 10000 - 1 - 1999],
      ['acc-loan', 0]
    ]);

    const orphans = await db.query(`
      SELECT COUNT(*) AS n FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id AND c.type = t.type
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE c.id IS NULL OR a.id IS NULL`);
    assert.equal(Number(orphans.rows[0].n), 0);
  });

  test('categories created afterwards do not reuse the copied ids', async () => {
    await apply(createLegacyDb(newFile(), legacyData()));
    const { rows } = await db.query("INSERT INTO categories (name, type) VALUES ('Brand new', 'expense') RETURNING id");
    assert.ok(rows[0].id > 5, `new id ${rows[0].id} is above the highest copied id`);
  });

  test('an empty (but valid) legacy database migrates nothing and says so', async () => {
    const report = await apply(createLegacyDb(newFile(), {}));
    assert.equal(report.status, 'already-migrated');
    assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 });
  });

  test('a large database (20,000 transactions) migrates correctly', async () => {
    const transactions = Array.from({ length: 20000 }, (_, i) => ({
      id: `big-${i}`, type: 'expense', description: `Item ${i}`, category_id: 1, account_id: 'acc-cash',
      amount_minor: 1 + (i % 9999), note: '', date: '2025-03-01', created_at: i
    }));
    const file = createLegacyDb(newFile(), {
      accounts: [{ id: 'acc-cash', name: 'Cash', type: 'cash', balance_minor: 0 }],
      categories: [{ id: 1, name: 'Food', type: 'expense' }],
      transactions
    });
    const started = Date.now();
    const report = await apply(file);
    assert.equal(report.status, 'migrated');
    assert.equal((await counts()).transactions, 20000);
    const sum = Number((await db.query('SELECT SUM(amount_minor) AS s FROM transactions')).rows[0].s);
    assert.equal(sum, transactions.reduce((total, t) => total + t.amount_minor, 0));
    assert.ok(Date.now() - started < 60000);
  });
});

// ---------------------------------------------------------------------------
// Repeated runs and conflicts
// ---------------------------------------------------------------------------

describe('duplicates and conflicts', () => {
  test('running it again changes nothing ("already migrated")', async () => {
    const file = createLegacyDb(newFile(), legacyData());
    await apply(file);
    const afterFirst = await dump();

    for (const run of [preview, apply]) {
      const report = await run(file);
      assert.equal(report.status, 'already-migrated');
      assert.deepEqual(report.alreadyMigrated, { accounts: 3, categories: 3, transactions: 5 });
      assert.deepEqual(report.toInsert, { accounts: 0, categories: 0, transactions: 0 });
      assert.equal(report.saved, false);
    }
    assert.deepEqual(await dump(), afterFirst);
  });

  test('partly present data: identical records are skipped, only the missing ones are added', async () => {
    const data = legacyData();
    await apply(createLegacyDb(newFile(), { accounts: data.accounts, categories: data.categories, transactions: data.transactions.slice(0, 2) }));

    const report = await apply(createLegacyDb(newFile(), data));
    assert.equal(report.status, 'migrated');
    assert.deepEqual(report.alreadyMigrated, { accounts: 3, categories: 3, transactions: 2 });
    assert.deepEqual(report.toInsert, { accounts: 0, categories: 0, transactions: 3 });
    assert.equal((await counts()).transactions, 5);
  });

  const conflictCases = [
    ['an account id with different data', async () => {
      await db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('acc-cash', 'Cash', 'cash', 999)");
    }, /account acc-cash/],
    ['an account name used by another id (any letter case)', async () => {
      await db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('other', 'CASH', 'cash', 10000)");
    }, /already named "Cash"/],
    ['a category id used by a different category', async () => {
      await db.query("INSERT INTO categories (id, name, type) OVERRIDING SYSTEM VALUE VALUES (1, 'Something else', 'expense')");
    }, /category 1/],
    ['a category name that exists with another id', async () => {
      await db.query("INSERT INTO categories (id, name, type) OVERRIDING SYSTEM VALUE VALUES (77, 'groceries', 'expense')");
    }, /already exists with a different id \(77\)/]
  ];
  for (const [name, setup, expected] of conflictCases) {
    test(`refuses the whole migration when PostgreSQL has ${name}, and writes nothing`, async () => {
      await setup();
      const before = await dump();
      const file = createLegacyDb(newFile(), legacyData());

      for (const run of [preview, apply]) {
        const report = await run(file);
        assert.equal(report.status, 'conflicts');
        assert.equal(report.saved, false);
        assert.ok(report.conflictCount >= 1);
        assert.match(described(report), expected);
        assert.deepEqual(await dump(), before, 'not even the records without a conflict were written');
      }
    });
  }

  test('a transaction id with different data is a conflict', async () => {
    const data = legacyData();
    await apply(createLegacyDb(newFile(), data));
    await db.query("UPDATE transactions SET amount_minor = 2 WHERE id = 'txn-a'");
    const before = await dump();
    const report = await apply(createLegacyDb(newFile(), data));
    assert.equal(report.status, 'conflicts');
    assert.match(described(report), /transaction txn-a/);
    assert.deepEqual(await dump(), before);
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  test('a database failure in the middle of the copy leaves nothing behind (preview and apply)', async () => {
    await db.query(`
      CREATE FUNCTION boom_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'boom: simulated failure'; END $$ LANGUAGE plpgsql`);
    await db.query(`
      CREATE TRIGGER boom BEFORE INSERT ON transactions
      FOR EACH ROW WHEN (NEW.description = 'Pay') EXECUTE FUNCTION boom_fail()`);
    const file = createLegacyDb(newFile(), legacyData());

    for (const run of [preview, apply]) {
      await assert.rejects(run(file), /boom: simulated failure/);
      assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 }, 'accounts and categories were rolled back too');
    }

    await db.query('DROP TRIGGER boom ON transactions');
    await db.query('DROP FUNCTION boom_fail()');
    assert.equal((await apply(file)).status, 'migrated', 'works once the problem is gone');
  });

  test('data that only PostgreSQL rejects (a date of the wrong shape) rolls everything back', async () => {
    // SQLite's CHECK can be switched off; PostgreSQL's cannot. Build a file with one odd date.
    const { DatabaseSync } = require('node:sqlite');
    const file = createLegacyDb(newFile(), legacyData());
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA ignore_check_constraints = ON');
    raw.exec("UPDATE transactions SET date = '2024-2-9' WHERE id = 'txn-c'");
    raw.close();

    for (const run of [preview, apply]) {
      await assert.rejects(run(file), error => !(error instanceof MigrationError));
      assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation of the source
// ---------------------------------------------------------------------------

describe('source validation', () => {
  const refuses = async (sourcePath, pattern) => {
    await assert.rejects(preview(sourcePath), error => {
      assert.ok(error instanceof MigrationError, `expected a MigrationError, got ${error}`);
      assert.match(error.message, pattern);
      return true;
    });
    assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 });
  };

  test('a missing source is refused and no file is created', async () => {
    const missing = path.join(tmp, 'does-not-exist.db');
    await refuses(missing, /does not exist/);
    assert.equal(fs.existsSync(missing), false);
    await refuses(undefined, /No source given/);
    await refuses('', /No source given/);
  });

  test('a folder, a text file and a random binary file are refused', async () => {
    await refuses(tmp, /not a file/);
    const text = path.join(tmp, 'notes.txt');
    fs.writeFileSync(text, 'this is not a database');
    await refuses(text, /not a valid SQLite database|Cannot open/);
    const binary = path.join(tmp, 'random.bin');
    fs.writeFileSync(binary, crypto.randomBytes(4096));
    await refuses(binary, /not a valid SQLite database|Cannot open/);
    assert.equal(fs.readFileSync(text, 'utf8'), 'this is not a database', 'untouched');
  });

  test('a SQLite file of another schema version, or without the financial tables, is refused', async () => {
    await refuses(createLegacyDb(newFile(), { userVersion: 1 }), /no financial tables/);
    await refuses(createLegacyDb(newFile(), { userVersion: 3 }), /newer than this tool understands/);

    const { DatabaseSync } = require('node:sqlite');
    const other = newFile();
    const raw = new DatabaseSync(other);
    raw.exec('CREATE TABLE something_else (a INTEGER)');
    raw.close();
    await refuses(other, /no financial tables/);
  });

  test('a source with broken references is refused rather than guessed at', async () => {
    const data = legacyData();
    data.transactions[0].account_id = 'acc-missing';
    await refuses(createLegacyDb(newFile(), { ...data, foreignKeys: false }), /broken reference/);
  });
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

describe('command line', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env }
  });
  const withDatabase = () => ({ DATABASE_URL: testSchema.url });

  test('--help prints the usage and needs no database', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--source/);
    assert.match(result.stdout, /--apply/);
  });

  test('it refuses to guess: no --source, no DATABASE_URL, unknown option', () => {
    assert.match(run([], withDatabase()).stderr, /No source given/);
    assert.equal(run([], withDatabase()).status, 1);
    const file = createLegacyDb(newFile(), legacyData());
    const noUrl = run(['--source', file]);
    assert.equal(noUrl.status, 1);
    assert.match(noUrl.stderr, /DATABASE_URL is not set/);
    assert.match(run(['--source', file, '--wipe'], withDatabase()).stderr, /Unknown option/);
  });

  test('default is a preview; --apply saves; a second --apply reports "nothing to do"; the password is never printed', async () => {
    const file = createLegacyDb(newFile(), legacyData());
    const hash = sha(file);
    const env = withDatabase();
    const secret = new URL(TEST_URL).password;

    const previewRun = run(['--source', file], env);
    assert.equal(previewRun.status, 0, previewRun.stderr);
    assert.match(previewRun.stdout, /Mode:\s+preview/);
    assert.match(previewRun.stdout, /PREVIEW OK/);
    assert.deepEqual(await counts(), { accounts: 0, categories: 0, transactions: 0 });

    const applied = run(['--source', file, '--apply'], env);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /DONE/);
    assert.deepEqual(await counts(), { accounts: 3, categories: 3, transactions: 5 });

    const again = run(['--source', file, '--apply'], env);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Nothing to do/);

    for (const result of [previewRun, applied, again]) {
      if (secret) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), 'password not printed');
    }
    assert.equal(sha(file), hash);
  });

  test('conflicts exit with code 2 and an explanation', async () => {
    await db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('acc-cash', 'Cash', 'cash', 999)");
    const file = createLegacyDb(newFile(), legacyData());
    const result = run(['--source', file, '--apply'], withDatabase());
    assert.equal(result.status, 2);
    assert.match(result.stdout, /REFUSED/);
    assert.match(result.stdout, /account acc-cash/);
    assert.equal((await counts()).accounts, 1, 'nothing written');
  });

  test('a wrong source path exits with code 1 before touching PostgreSQL', () => {
    const result = run(['--source', path.join(tmp, 'nope.db')], { DATABASE_URL: 'postgres://nobody:secret-pw@127.0.0.1:1/none' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist/);
    assert.ok(!result.stdout.includes('secret-pw') && !result.stderr.includes('secret-pw'));
  });

  test('an unreachable PostgreSQL is a clear error without the password', () => {
    const file = createLegacyDb(newFile(), legacyData());
    const result = run(['--source', file], { DATABASE_URL: 'postgres://nobody:secret-pw@127.0.0.1:1/none' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot start PostgreSQL/);
    assert.ok(!result.stdout.includes('secret-pw') && !result.stderr.includes('secret-pw'));
  });
});
