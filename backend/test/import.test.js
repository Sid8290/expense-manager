'use strict';

// Automated checks for the Stage 4 import/export API:
//   POST /api/import/preview, POST /api/import, GET /api/export.
// Run with:  npm test
//
// Like api.test.js, this runs the real HTTP server inside the test process on
// a random port, connected to a throw-away SQLite file in the OS temp folder.
// Your real database and your browser's localStorage are never touched.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../db');
const { createServer } = require('../server');
const { MAX_RECORDS } = require('../api/importer');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-import-test-'));
let server;
let port;

before(async () => {
  db.initDatabase(path.join(tmpRoot, 'import.db'));
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.getDb().exec('DROP TRIGGER IF EXISTS boom;');
  db.getDb().exec('DELETE FROM transactions; DELETE FROM categories; DELETE FROM accounts; DELETE FROM sqlite_sequence;');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function call(method, urlPath, body, { raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
    const sendHeaders = { ...headers };
    if (payload !== undefined) {
      if (!Object.keys(sendHeaders).some(name => name.toLowerCase() === 'content-type')) {
        sendHeaders['Content-Type'] = 'application/json';
      }
      sendHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: sendHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = /^application\/json/.test(res.headers['content-type'] || '');
        resolve({ status: res.statusCode, headers: res.headers, text, json: isJson && text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const backup = ({ accounts = [], categories = [], transactions = [] } = {}) => ({
  format: 'expense-manager-legacy-backup',
  version: 1,
  exportedAt: '2026-10-19T00:00:00.000Z',
  data: { accounts, categories, transactions }
});

// Realistic legacy records (same shapes the old app stored).
const acc = (overrides = {}) => ({ id: 'acc-1', name: 'Wallet', type: 'cash', balance: 100, ...overrides });
const cat = (name, type = 'expense') => ({ name, type });
const txn = (overrides = {}) => ({
  id: 'txn-1', type: 'expense', description: 'Tea', category: 'Food', accountId: 'acc-1',
  amount: 12.5, note: '', date: '2025-01-10', createdAt: 1736500000000, ...overrides
});

// One valid account + category + transaction.
const simple = () => backup({ accounts: [acc()], categories: [cat('Food')], transactions: [txn()] });

const preview = payload => call('POST', '/api/import/preview', payload);
const importNow = payload => call('POST', '/api/import', { ...payload, confirm: true });

const counts = () => {
  const n = table => db.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { accounts: n('accounts'), categories: n('categories'), transactions: n('transactions') };
};
const snapshot = async () => (await call('GET', '/api/export')).json.data.data;
const sequences = () => db.getDb().prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();

function assertError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, code, response.text);
  assert.doesNotMatch(response.text, /node_modules|\.js:\d|\bat .*\(|expense-import-test|SQLITE|sqlite|boom/i, 'nothing internal leaked');
}

// `items` is the list from the report, e.g. report.items.accounts.
const find = (items, outcome) => items.filter(item => item.outcome === outcome);

// ---------------------------------------------------------------------------
// Preview and confirmation
// ---------------------------------------------------------------------------

describe('preview', () => {
  test('reports what would happen and changes nothing at all', async () => {
    await call('POST', '/api/accounts', { name: 'Existing', type: 'bank', balance: 5 });
    const before = { counts: counts(), data: await snapshot(), sequences: sequences() };

    const response = await preview(simple());
    assert.equal(response.status, 200, response.text);
    const report = response.json.data;
    assert.equal(report.mode, 'preview');
    assert.equal(report.complete, true);
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.categories.imported, 1);
    assert.equal(report.counts.transactions.imported, 1);
    assert.deepEqual(report.databaseBefore, { accounts: 1, categories: 0, transactions: 0 });
    assert.deepEqual(report.databaseAfter, { accounts: 2, categories: 1, transactions: 1 }, 'what it WOULD be');

    assert.deepEqual(counts(), before.counts);
    assert.deepEqual(await snapshot(), before.data);
    assert.deepEqual(sequences(), before.sequences, 'not even the id counters moved');
  });

  test('is repeatable and gives the same answer each time', async () => {
    const first = (await preview(simple())).json.data;
    const second = (await preview(simple())).json.data;
    assert.deepEqual(second, first);
  });
});

describe('confirmation', () => {
  test('the real import requires "confirm": true', async () => {
    for (const confirm of [undefined, false, 'true', 1, null]) {
      const response = await call('POST', '/api/import', { ...simple(), confirm });
      assertError(response, 400, 'CONFIRMATION_REQUIRED');
    }
    assert.deepEqual(counts(), { accounts: 0, categories: 0, transactions: 0 });
  });

  test('only POST is allowed on the import routes; export is GET only', async () => {
    for (const [method, urlPath, allow] of [
      ['GET', '/api/import', 'POST'], ['PUT', '/api/import', 'POST'], ['DELETE', '/api/import', 'POST'],
      ['GET', '/api/import/preview', 'POST'], ['POST', '/api/export', 'GET'], ['DELETE', '/api/export', 'GET']
    ]) {
      const response = await call(method, urlPath, method === 'GET' || method === 'DELETE' ? undefined : {});
      assertError(response, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(response.headers.allow, allow);
    }
  });
});

// ---------------------------------------------------------------------------
// Valid imports
// ---------------------------------------------------------------------------

describe('importing valid data', () => {
  test('imports accounts, categories and transactions with ids, timestamps and values preserved', async () => {
    const payload = backup({
      accounts: [acc({ id: 'acc-1', name: 'Wallet', balance: 1234.56 }), acc({ id: 'acc-2', name: 'HDFC', type: 'bank', balance: 0 })],
      categories: [cat('Food'), cat('Salary', 'income')],
      transactions: [
        txn({ id: 'txn-a', amount: 12.5, note: 'with milk', createdAt: 1736500000123 }),
        txn({ id: 'txn-b', type: 'income', category: 'Salary', accountId: 'acc-2', amount: 52000, date: '2025-02-01', createdAt: 1738400000000 })
      ]
    });
    const response = await importNow(payload);
    assert.equal(response.status, 200, response.text);
    const report = response.json.data;
    assert.equal(report.mode, 'import');
    assert.equal(report.complete, true);
    assert.equal(report.counts.accounts.imported, 2);
    assert.equal(report.counts.categories.imported, 2);
    assert.equal(report.counts.transactions.imported, 2);
    assert.deepEqual(report.verification, { recordsChecked: 6, recordsMatching: 6 });
    assert.deepEqual(report.databaseBefore, { accounts: 0, categories: 0, transactions: 0 });
    assert.deepEqual(report.databaseAfter, { accounts: 2, categories: 2, transactions: 2 });

    const stored = await snapshot();
    assert.deepEqual(stored.accounts.map(a => [a.id, a.name, a.type, a.balance]), [['acc-1', 'Wallet', 'cash', 1234.56], ['acc-2', 'HDFC', 'bank', 0]]);
    const food = stored.categories.find(c => c.name === 'Food');
    const a = stored.transactions.find(t => t.id === 'txn-a');
    assert.equal(a.categoryId, food.id, 'category name was resolved to the database id');
    assert.equal(a.category, 'Food');
    assert.equal(a.accountId, 'acc-1');
    assert.equal(a.amount, 12.5);
    assert.equal(a.note, 'with milk');
    assert.equal(a.date, '2025-01-10');
    assert.equal(a.createdAt, 1736500000123);
    assert.equal(stored.transactions.find(t => t.id === 'txn-b').amount, 52000);
  });

  test('a preview that is followed by an import predicts the import exactly', async () => {
    const payload = backup({
      accounts: [acc(), acc({ id: 'acc-9', name: '' })],
      categories: [cat('Food'), cat('')],
      transactions: [txn(), txn({ id: 'txn-2', amount: -1 }), txn({ id: 'txn-3', accountId: 'acc-nope' })]
    });
    const previewed = (await preview(payload)).json.data;
    const imported = (await importNow(payload)).json.data;
    const strip = ({ mode, databaseAfter, verification, ...rest }) => rest;
    assert.deepEqual(strip(imported), strip(previewed));
  });

  test('money values stay exact (no floating point drift)', async () => {
    const amounts = [0.01, 0.07, 0.1, 0.2, 1.15, 4.35, 19.99, 1000000000];
    const payload = backup({
      accounts: [acc({ balance: 1234.56 })],
      categories: [cat('Food')],
      transactions: amounts.map((amount, i) => txn({ id: `txn-${i}`, amount }))
    });
    const report = (await importNow(payload)).json.data;
    assert.equal(report.counts.transactions.imported, amounts.length);
    const stored = (await snapshot()).transactions;
    for (const [i, amount] of amounts.entries()) {
      assert.equal(stored.find(t => t.id === `txn-${i}`).amount, amount, `amount ${amount}`);
      const row = db.getDb().prepare('SELECT amount_minor FROM transactions WHERE id = ?').get(`txn-${i}`);
      assert.equal(row.amount_minor, Math.round(amount * 100));
    }
  });

  test('category names resolve ignoring case, and income/expense are kept apart', async () => {
    const payload = backup({
      accounts: [acc()],
      categories: [cat('Other', 'expense'), cat('Other', 'income')],
      transactions: [
        txn({ id: 't1', category: 'other' }),
        txn({ id: 't2', type: 'income', category: 'Other' })
      ]
    });
    const report = (await importNow(payload)).json.data;
    assert.equal(report.counts.categories.imported, 2);
    const stored = await snapshot();
    const expense = stored.categories.find(c => c.type === 'expense').id;
    const income = stored.categories.find(c => c.type === 'income').id;
    assert.equal(stored.transactions.find(t => t.id === 't1').categoryId, expense);
    assert.equal(stored.transactions.find(t => t.id === 't2').categoryId, income);
  });

  test('a missing note becomes empty and a missing createdAt becomes 0 (as the old app sorted it)', async () => {
    const record = txn();
    delete record.note;
    delete record.createdAt;
    const report = (await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions: [record] }))).json.data;
    assert.equal(report.counts.transactions.imported, 1);
    const stored = (await snapshot()).transactions[0];
    assert.equal(stored.note, '');
    assert.equal(stored.createdAt, 0);
  });

  test('unknown extra fields on old records are ignored, not treated as errors', async () => {
    const report = (await importNow(backup({
      accounts: [{ ...acc(), color: 'red' }],
      categories: [{ ...cat('Food'), icon: 'x' }],
      transactions: [{ ...txn(), tags: ['a'] }]
    }))).json.data;
    assert.equal(report.complete, true);
    assert.deepEqual(counts(), { accounts: 1, categories: 1, transactions: 1 });
  });

  test('old defaults: unused ones are not imported, used ones are', async () => {
    const payload = backup({
      accounts: [
        { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
        { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 }
      ],
      categories: [cat('Groceries'), cat('Bills'), cat('Salary', 'income')],
      transactions: [txn({ id: 't1', category: 'Groceries', accountId: 'acc-cash' })]
    });
    const report = (await importNow(payload)).json.data;
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.accounts.oldDefaultNotImported, 1);
    assert.equal(report.counts.categories.imported, 1);
    assert.equal(report.counts.categories.oldDefaultNotImported, 2);
    assert.equal(report.complete, true, 'skipping unused defaults is not a failure');
    const stored = await snapshot();
    assert.deepEqual(stored.accounts.map(a => a.id), ['acc-cash']);
    assert.deepEqual(stored.categories.map(c => c.name), ['Groceries']);
  });

  test('a default that was changed by the user is user data and is imported', async () => {
    const report = (await importNow(backup({ accounts: [{ id: 'acc-cash', name: 'Cash', type: 'cash', balance: 250 }] }))).json.data;
    assert.equal(report.counts.accounts.imported, 1);
  });

  test('an empty backup is valid and imports nothing', async () => {
    const report = (await importNow(backup())).json.data;
    assert.equal(report.complete, true);
    assert.deepEqual(counts(), { accounts: 0, categories: 0, transactions: 0 });
  });

  test('a large import works (20,000 transactions, the documented limit) and is verified', async () => {
    const transactions = Array.from({ length: MAX_RECORDS.transactions }, (_, i) =>
      txn({ id: `txn-${i}`, amount: (i % 1000) + 0.25, date: '2025-03-01', createdAt: 1000 + i }));
    const started = Date.now();
    const response = await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions }));
    assert.equal(response.status, 200, response.text.slice(0, 300));
    assert.equal(response.json.data.counts.transactions.imported, MAX_RECORDS.transactions);
    assert.equal(response.json.data.verification.recordsChecked, MAX_RECORDS.transactions + 2);
    assert.equal(counts().transactions, MAX_RECORDS.transactions);
    assert.ok(Date.now() - started < 60000, 'finished in reasonable time');
  });
});

// ---------------------------------------------------------------------------
// Invalid records and unresolved references
// ---------------------------------------------------------------------------

describe('invalid records', () => {
  test('invalid accounts are rejected with reasons; valid ones are still imported (partial)', async () => {
    const payload = backup({
      accounts: [
        acc({ id: 'ok-1', name: 'Good' }),
        acc({ id: 'bad-type', name: 'A', type: 'wallet' }),
        acc({ id: 'neg', name: 'B', balance: -5 }),
        acc({ id: 'dec', name: 'C', balance: 1.005 }),
        acc({ id: 'str', name: 'D', balance: '10' }),
        acc({ id: 'long', name: 'x'.repeat(41) }),
        acc({ id: 'bad id!', name: 'E' }),
        { name: 'No id', type: 'cash', balance: 1 },
        'not an object',
        null
      ]
    });
    const report = (await importNow(payload)).json.data;
    assert.equal(report.complete, false);
    assert.equal(report.counts.accounts.received, 10);
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.accounts.rejected, 9);
    assert.equal(find(report.items.accounts, 'rejected').length, 9);
    for (const item of find(report.items.accounts, 'rejected')) assert.equal(typeof item.reason, 'string');
    assert.deepEqual((await snapshot()).accounts.map(a => a.id), ['ok-1']);
  });

  test('invalid categories are rejected', async () => {
    const report = (await importNow(backup({
      categories: [cat('Fine'), cat(''), cat('x'.repeat(31)), { name: 'T', type: 'other' }, { type: 'income' }, 7]
    }))).json.data;
    assert.equal(report.counts.categories.imported, 1);
    assert.equal(report.counts.categories.rejected, 5);
  });

  test('invalid transactions are rejected with the API\'s own rules', async () => {
    const bad = [
      txn({ id: 'zero', amount: 0 }),
      txn({ id: 'neg', amount: -3 }),
      txn({ id: 'dec', amount: 1.234 }),
      txn({ id: 'big', amount: 1000000001 }),
      txn({ id: 'str', amount: '5' }),
      txn({ id: 'future', date: '2999-01-01' }),
      txn({ id: 'baddate', date: '2025-02-30' }),
      txn({ id: 'fmt', date: '10/01/2025' }),
      txn({ id: 'desc', description: '' }),
      txn({ id: 'longdesc', description: 'x'.repeat(101) }),
      txn({ id: 'note', note: 'y'.repeat(201) }),
      txn({ id: 'type', type: 'transfer' }),
      txn({ id: 'time', createdAt: -1 }),
      { ...txn({ id: 'noid' }), id: undefined },
      'junk'
    ];
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food')], transactions: [txn({ id: 'good' }), ...bad]
    }))).json.data;
    assert.equal(report.counts.transactions.imported, 1);
    const t = report.counts.transactions;
    assert.equal(t.rejected + t.unresolvedReferences, bad.length);
    assert.deepEqual((await snapshot()).transactions.map(x => x.id), ['good']);
  });

  test('a transaction on a non-money account (asset, receivable, payable) is rejected', async () => {
    const report = (await importNow(backup({
      accounts: [acc({ id: 'house', name: 'House', type: 'asset' })],
      categories: [cat('Food')],
      transactions: [txn({ accountId: 'house' })]
    }))).json.data;
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.transactions.rejected, 1);
    assert.match(report.items.transactions[0].reason, /cash, bank or online/);
  });
});

describe('unresolved references (never guessed)', () => {
  test('a transaction whose account is not in the import is unresolved', async () => {
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food')], transactions: [txn({ accountId: 'acc-ghost' })]
    }))).json.data;
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
    assert.equal(report.counts.transactions.imported, 0);
    assert.equal(report.complete, false);
  });

  test('a transaction whose category is not in the import is unresolved', async () => {
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food')], transactions: [txn({ category: 'Missing' })]
    }))).json.data;
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
    assert.match(report.items.transactions[0].reason, /Missing/);
  });

  test('the category must match by TYPE too (an income transaction cannot use an expense category)', async () => {
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food', 'expense')], transactions: [txn({ type: 'income', category: 'Food' })]
    }))).json.data;
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
  });

  test('a category that exists only in the database is NOT used to resolve a legacy reference', async () => {
    await call('POST', '/api/categories', { name: 'Food', type: 'expense' });
    const report = (await importNow(backup({ accounts: [acc()], transactions: [txn()] }))).json.data;
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
  });

  test('transactions of a rejected account are unresolved, with the reason', async () => {
    const report = (await importNow(backup({
      accounts: [acc({ balance: -1 })], categories: [cat('Food')], transactions: [txn()]
    }))).json.data;
    assert.equal(report.counts.accounts.rejected, 1);
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
    assert.match(report.items.transactions[0].reason, /was not imported/);
    assert.deepEqual(counts(), { accounts: 0, categories: 1, transactions: 0 });
  });

  test('a transaction with a non-text category or a bad type is rejected, not crashed on', async () => {
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food')],
      transactions: [txn({ id: 'a', category: 5 }), txn({ id: 'b', category: null }), txn({ id: 'c', type: 'x' }), txn({ id: 'd', accountId: 7 })]
    }))).json.data;
    const t = report.counts.transactions;
    assert.equal(t.imported, 0);
    assert.equal(t.rejected + t.unresolvedReferences, 4);
  });
});

// ---------------------------------------------------------------------------
// Duplicates and conflicts
// ---------------------------------------------------------------------------

describe('duplicates inside the import', () => {
  test('the same record twice is imported once; the repeat is reported as a duplicate', async () => {
    const report = (await importNow(backup({
      accounts: [acc(), acc()],
      categories: [cat('Food'), cat('food')],
      transactions: [txn(), txn()]
    }))).json.data;
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.accounts.duplicateInFile, 1);
    assert.equal(report.counts.categories.imported, 1);
    assert.equal(report.counts.categories.duplicateInFile, 1);
    assert.equal(report.counts.transactions.imported, 1);
    assert.equal(report.counts.transactions.duplicateInFile, 1);
    assert.equal(report.complete, true);
    assert.deepEqual(counts(), { accounts: 1, categories: 1, transactions: 1 });
  });

  test('the same id with DIFFERENT data is ambiguous: all of them are rejected, nothing is guessed', async () => {
    const report = (await importNow(backup({
      accounts: [acc({ name: 'One' }), acc({ name: 'Two' })],
      categories: [cat('Food')],
      transactions: [txn({ amount: 5 }), txn({ amount: 6 })]
    }))).json.data;
    assert.equal(report.counts.accounts.rejected, 2);
    assert.equal(report.counts.accounts.conflicts, 2);
    assert.equal(report.counts.transactions.imported, 0);
    assert.deepEqual(counts(), { accounts: 0, categories: 1, transactions: 0 });
  });

  test('two genuine transactions that look identical but have different ids are BOTH imported', async () => {
    const report = (await importNow(backup({
      accounts: [acc()], categories: [cat('Food')],
      transactions: [txn({ id: 'txn-x' }), txn({ id: 'txn-y' })]
    }))).json.data;
    assert.equal(report.counts.transactions.imported, 2);
    assert.equal(report.counts.transactions.duplicateInFile, 0);
    assert.equal(counts().transactions, 2);
  });

  test('two accounts with the same name but different ids: the second is a conflict', async () => {
    const report = (await importNow(backup({
      accounts: [acc({ id: 'a1', name: 'Wallet' }), acc({ id: 'a2', name: 'WALLET' })]
    }))).json.data;
    assert.equal(report.counts.accounts.imported, 1);
    assert.equal(report.counts.accounts.conflicts, 1);
  });
});

describe('conflicts with what is already in the database', () => {
  test('an account id that exists with different data is a conflict; it is not changed; its transactions are unresolved', async () => {
    await call('POST', '/api/accounts', { id: 'acc-1', name: 'Different', type: 'bank', balance: 9 });
    const before = await snapshot();
    const report = (await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions: [txn()] }))).json.data;
    assert.equal(report.counts.accounts.conflicts, 1);
    assert.equal(report.counts.accounts.rejected, 1);
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
    assert.match(find(report.items.accounts, 'rejected')[0].reason, /different data/);
    const after = await snapshot();
    assert.deepEqual(after.accounts, before.accounts, 'the existing account is untouched');
    assert.equal(after.transactions.length, 0);
  });

  test('an account name already used by a different account is a conflict (names are not matched as identity)', async () => {
    await call('POST', '/api/accounts', { name: 'wallet', type: 'cash', balance: 1 });
    const report = (await importNow(backup({ accounts: [acc()] }))).json.data;
    assert.equal(report.counts.accounts.conflicts, 1);
    assert.match(report.items.accounts[0].reason, /Rename/);
    assert.equal(counts().accounts, 1);
  });

  test('a transaction id that exists with different data is a conflict; it is not changed', async () => {
    const first = (await importNow(simple())).json.data;
    assert.equal(first.counts.transactions.imported, 1);
    const before = await snapshot();
    const changed = backup({ accounts: [acc()], categories: [cat('Food')], transactions: [txn({ amount: 99 })] });
    const report = (await importNow(changed)).json.data;
    assert.equal(report.counts.transactions.conflicts, 1);
    assert.equal(report.counts.transactions.imported, 0);
    assert.deepEqual(await snapshot(), before);
  });

  test('a category that already exists (same type and name) is reused, not duplicated', async () => {
    const existing = (await call('POST', '/api/categories', { name: 'FOOD', type: 'expense' })).json.data;
    const report = (await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions: [txn()] }))).json.data;
    assert.equal(report.counts.categories.duplicateInDatabase, 1);
    assert.equal(report.counts.categories.imported, 0);
    assert.equal(report.counts.transactions.imported, 1);
    const stored = await snapshot();
    assert.equal(stored.categories.length, 1);
    assert.equal(stored.transactions[0].categoryId, existing.id);
  });

  test('importing into a database that already has records keeps them and adds the new ones', async () => {
    const a = (await call('POST', '/api/accounts', { name: 'Mine', type: 'bank', balance: 7 })).json.data;
    const c = (await call('POST', '/api/categories', { name: 'Rent', type: 'expense' })).json.data;
    const t = (await call('POST', '/api/transactions', { type: 'expense', description: 'June rent', categoryId: c.id, accountId: a.id, amount: 500, date: '2025-06-01' })).json.data;
    const report = (await importNow(simple())).json.data;
    assert.equal(report.complete, true);
    assert.deepEqual(counts(), { accounts: 2, categories: 2, transactions: 2 });
    const stored = await snapshot();
    assert.deepEqual(stored.accounts.find(x => x.id === a.id).balance, 7);
    assert.deepEqual(stored.transactions.find(x => x.id === t.id), t);
  });
});

// ---------------------------------------------------------------------------
// Repeating an import, partial imports, stale previews
// ---------------------------------------------------------------------------

describe('repeating an import', () => {
  test('a second import of the same data changes nothing and reports everything as already imported', async () => {
    const payload = backup({
      accounts: [acc(), acc({ id: 'acc-2', name: 'Bank', type: 'bank' })],
      categories: [cat('Food'), cat('Pay', 'income')],
      transactions: [txn(), txn({ id: 'txn-2', type: 'income', category: 'Pay', accountId: 'acc-2', amount: 1000 }), txn({ id: 'txn-3' })]
    });
    const first = (await importNow(payload)).json.data;
    assert.equal(first.counts.transactions.imported, 3);
    const before = { data: await snapshot(), sequences: sequences() };

    const second = (await importNow(payload)).json.data;
    assert.equal(second.complete, true);
    assert.equal(second.counts.accounts.imported, 0);
    assert.equal(second.counts.categories.imported, 0);
    assert.equal(second.counts.transactions.imported, 0);
    assert.equal(second.counts.accounts.duplicateInDatabase, 2);
    assert.equal(second.counts.categories.duplicateInDatabase, 2);
    assert.equal(second.counts.transactions.duplicateInDatabase, 3);
    assert.deepEqual((await snapshot()), before.data);
    assert.deepEqual(sequences(), before.sequences);

    const third = (await importNow(payload)).json.data;
    assert.equal(third.counts.transactions.duplicateInDatabase, 3);
    assert.deepEqual(counts(), { accounts: 2, categories: 2, transactions: 3 });
  });

  test('retry after a partial import: only what was missing is added', async () => {
    const goodTxn = txn({ id: 'txn-ok' });
    const badTxn = txn({ id: 'txn-late', date: '2999-12-31' });
    const first = (await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions: [goodTxn, badTxn] }))).json.data;
    assert.equal(first.complete, false);
    assert.equal(first.counts.transactions.imported, 1);
    assert.equal(first.counts.transactions.rejected, 1);

    const fixed = { ...badTxn, date: '2025-05-05' };
    const second = (await importNow(backup({ accounts: [acc()], categories: [cat('Food')], transactions: [goodTxn, fixed] }))).json.data;
    assert.equal(second.complete, true);
    assert.equal(second.counts.transactions.imported, 1);
    assert.equal(second.counts.transactions.duplicateInDatabase, 1);
    assert.deepEqual(counts(), { accounts: 1, categories: 1, transactions: 2 });
  });

  test('the import re-checks the CURRENT database: a stale preview is not trusted', async () => {
    const payload = simple();
    const previewed = (await preview(payload)).json.data;
    assert.equal(previewed.counts.accounts.imported, 1);

    // Between the preview and the import, someone creates a conflicting account.
    await call('POST', '/api/accounts', { name: 'Wallet', type: 'cash', balance: 1 });

    const report = (await importNow(payload)).json.data;
    assert.equal(report.counts.accounts.imported, 0, 'the preview said 1; the real answer is different');
    assert.equal(report.counts.accounts.conflicts, 1);
    assert.equal(report.counts.transactions.unresolvedReferences, 1);
    assert.equal(report.complete, false);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: failure during the import
// ---------------------------------------------------------------------------

describe('failure during the import', () => {
  const FAIL_TRIGGER = `
    CREATE TRIGGER boom BEFORE INSERT ON transactions WHEN NEW.description = 'BOOM'
    BEGIN SELECT RAISE(ABORT, 'boom: simulated disk failure'); END;
  `;
  const payloadWithBomb = () => backup({
    accounts: [acc()], categories: [cat('Food')],
    transactions: [txn({ id: 't1' }), txn({ id: 't2' }), txn({ id: 't3', description: 'BOOM' }), txn({ id: 't4' })]
  });

  test('a database error rolls back EVERYTHING, tells the truth, and leaks nothing', async () => {
    await call('POST', '/api/accounts', { name: 'Already here', type: 'bank', balance: 3 });
    const before = { counts: counts(), data: await snapshot(), sequences: sequences() };
    db.getDb().exec(FAIL_TRIGGER);

    const response = await importNow(payloadWithBomb());
    assertError(response, 500, 'IMPORT_FAILED');
    assert.match(response.json.error.message, /nothing was saved/i);

    assert.deepEqual(counts(), before.counts, 'the account, the category and t1/t2 were all rolled back');
    assert.deepEqual(await snapshot(), before.data);
    assert.deepEqual(sequences(), before.sequences);

    // The server is still healthy, and after the problem is gone the same import works.
    assert.equal((await call('GET', '/api/health')).status, 200);
    db.getDb().exec('DROP TRIGGER boom');
    const retry = (await importNow(payloadWithBomb())).json.data;
    assert.equal(retry.counts.transactions.imported, 4);
    assert.equal(counts().transactions, 4);
  });

  test('a preview that hits the same error reports it and changes nothing', async () => {
    db.getDb().exec(FAIL_TRIGGER);
    assertError(await preview(payloadWithBomb()), 500, 'PREVIEW_FAILED');
    assert.deepEqual(counts(), { accounts: 0, categories: 0, transactions: 0 });
  });
});

describe('runInTransaction (database helper)', () => {
  test('commits on success, rolls back on error, and a dry run never keeps anything', () => {
    const insert = () => db.getDb().prepare("INSERT INTO categories (name, type) VALUES ('T', 'income')").run();

    db.runInTransaction(insert);
    assert.equal(counts().categories, 1);

    assert.throws(() => db.runInTransaction(() => { insert2(); throw new Error('stop'); }), /stop/);
    function insert2() { db.getDb().prepare("INSERT INTO categories (name, type) VALUES ('U', 'income')").run(); }
    assert.equal(counts().categories, 1, 'rolled back');

    const returned = db.runInTransaction(() => { insert2(); return 'value'; }, { dryRun: true });
    assert.equal(returned, 'value');
    assert.equal(counts().categories, 1, 'dry run rolled back');

    db.runInTransaction(insert2);
    assert.equal(counts().categories, 2, 'the connection is still usable afterwards');
  });
});

// ---------------------------------------------------------------------------
// Bad input: format, version, size, malformed JSON
// ---------------------------------------------------------------------------

describe('bad import input', () => {
  const both = async (body, status, code) => {
    for (const make of [preview, importNow]) {
      assertError(await make(body), status, code);
    }
    assert.deepEqual(counts(), { accounts: 0, categories: 0, transactions: 0 });
  };

  test('malformed JSON, an empty body and a non-object body are refused', async () => {
    for (const url of ['/api/import/preview', '/api/import']) {
      assertError(await call('POST', url, undefined, { raw: '{"format": ' }), 400, 'INVALID_JSON');
      assertError(await call('POST', url, undefined, { raw: '' }), 400, 'INVALID_JSON');
      assertError(await call('POST', url, undefined, { raw: '[]' }), 400, 'INVALID_BODY');
      assertError(await call('POST', url, undefined, { raw: 'null' }), 400, 'INVALID_BODY');
    }
  });

  test('wrong content type is refused', async () => {
    assertError(await call('POST', '/api/import/preview', undefined, { raw: JSON.stringify(simple()), headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('an unknown or missing format is refused', async () => {
    await both({ ...simple(), format: 'something-else', confirm: true }, 400, 'UNSUPPORTED_FORMAT');
    const noFormat = simple();
    delete noFormat.format;
    await both({ ...noFormat, confirm: true }, 400, 'UNSUPPORTED_FORMAT');
  });

  test('a database export is recognised and refused with a clear message (it is not an import format)', async () => {
    const response = await preview({ ...simple(), format: 'expense-manager-database-export' });
    assertError(response, 400, 'UNSUPPORTED_FORMAT');
    assert.match(response.json.error.message, /database export/i);
  });

  test('unsupported versions are refused', async () => {
    for (const version of [0, 2, 99, '1', null, undefined]) {
      await both({ ...simple(), version, confirm: true }, 400, 'UNSUPPORTED_VERSION');
    }
  });

  test('a missing or malformed "data" section is refused', async () => {
    await both({ ...simple(), data: undefined, confirm: true }, 400, 'INVALID_BODY');
    await both({ ...simple(), data: [], confirm: true }, 400, 'INVALID_BODY');
    await both({ ...simple(), data: 'x', confirm: true }, 400, 'INVALID_BODY');
    await both({ ...simple(), data: { accounts: [], categories: [] }, confirm: true }, 400, 'INVALID_BODY');
    await both({ ...simple(), data: { accounts: {}, categories: [], transactions: [] }, confirm: true }, 400, 'INVALID_BODY');
  });

  test('entity types other than accounts, categories and transactions are refused (bills, to-dos, settings are not imported)', async () => {
    const body = simple();
    body.data.bills = [];
    const response = await preview(body);
    assertError(response, 400, 'UNSUPPORTED_ENTITY');
    assert.match(response.json.error.message, /bills/);
  });

  test('record-count limits are enforced before anything is processed', async () => {
    const tooManyAccounts = backup({ accounts: Array.from({ length: MAX_RECORDS.accounts + 1 }, (_, i) => acc({ id: `a${i}`, name: `A${i}` })) });
    await both({ ...tooManyAccounts, confirm: true }, 400, 'LIMIT_EXCEEDED');
    const tooManyCategories = backup({ categories: Array.from({ length: MAX_RECORDS.categories + 1 }, (_, i) => cat(`C${i}`)) });
    await both({ ...tooManyCategories, confirm: true }, 400, 'LIMIT_EXCEEDED');
    const tooManyTransactions = backup({ transactions: Array.from({ length: MAX_RECORDS.transactions + 1 }, () => ({})) });
    await both({ ...tooManyTransactions, confirm: true }, 400, 'LIMIT_EXCEEDED');
  });

  test('a body over the import size limit is refused with 413 and the server keeps working', async () => {
    const huge = JSON.stringify({ ...simple(), padding: 'x'.repeat(9 * 1024 * 1024) });
    assertError(await call('POST', '/api/import/preview', undefined, { raw: huge }), 413, 'PAYLOAD_TOO_LARGE');
    assert.equal((await call('GET', '/api/health')).status, 200);
  });

  test('the import route accepts bodies the normal 64 KB limit would refuse, other routes still do not', async () => {
    const mid = JSON.stringify({ ...simple(), padding: 'x'.repeat(200 * 1024) });
    assert.equal((await call('POST', '/api/import/preview', undefined, { raw: mid })).status, 200);
    assertError(await call('POST', '/api/accounts', undefined, { raw: JSON.stringify({ name: 'A', type: 'cash', balance: 0, padding: 'x'.repeat(100000) }) }), 413, 'PAYLOAD_TOO_LARGE');
  });

  test('hostile content is just data: it is stored as text and never executed', async () => {
    const evil = "x'); DROP TABLE accounts; --";
    const report = (await importNow(backup({
      accounts: [acc({ name: evil })], categories: [cat('<img src=x onerror=alert(1)>')], transactions: [txn({ category: '<img src=x onerror=alert(1)>', description: '${process.exit(1)}' })]
    }))).json.data;
    assert.equal(report.counts.transactions.imported, 1);
    const stored = await snapshot();
    assert.equal(stored.accounts[0].name, evil);
    assert.equal(stored.transactions[0].description, '${process.exit(1)}');
    assert.equal(counts().accounts, 1);
  });
});

// ---------------------------------------------------------------------------
// The report is bounded
// ---------------------------------------------------------------------------

describe('report size', () => {
  test('counts are always complete, but listed transaction problems are capped', async () => {
    const transactions = Array.from({ length: 500 }, (_, i) => txn({ id: `t${i}`, amount: -1 }));
    const report = (await preview(backup({ accounts: [acc()], categories: [cat('Food')], transactions }))).json.data;
    assert.equal(report.counts.transactions.rejected, 500);
    assert.equal(report.items.transactions.length, 200);
    assert.equal(report.items.transactionsTruncated, true);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('GET /api/export', () => {
  test('an empty database exports valid, empty, versioned data', async () => {
    const response = await call('GET', '/api/export');
    assert.equal(response.status, 200);
    const out = response.json.data;
    assert.equal(out.format, 'expense-manager-database-export');
    assert.equal(out.version, 1);
    assert.ok(!Number.isNaN(Date.parse(out.exportedAt)) && out.exportedAt.endsWith('Z'));
    assert.deepEqual(out.counts, { accounts: 0, categories: 0, transactions: 0 });
    assert.deepEqual(out.data, { accounts: [], categories: [], transactions: [] });
  });

  test('exports the real API records with their relationships and exact amounts', async () => {
    await importNow(backup({
      accounts: [acc({ balance: 100 })],
      categories: [cat('Food'), cat('Pay', 'income')],
      transactions: [txn({ amount: 19.99 }), txn({ id: 'txn-2', type: 'income', category: 'Pay', amount: 0.1 })]
    }));
    const out = (await call('GET', '/api/export')).json.data;
    assert.deepEqual(out.counts, { accounts: 1, categories: 2, transactions: 2 });

    // identical to what the normal list endpoints return
    assert.deepEqual(out.data.accounts, (await call('GET', '/api/accounts')).json.data);
    assert.deepEqual(out.data.categories, (await call('GET', '/api/categories')).json.data);
    assert.deepEqual(out.data.transactions, (await call('GET', '/api/transactions')).json.data);

    const categoryById = new Map(out.data.categories.map(c => [c.id, c]));
    for (const t of out.data.transactions) {
      assert.equal(categoryById.get(t.categoryId).name, t.category, 'categoryId and category name agree');
      assert.equal(categoryById.get(t.categoryId).type, t.type);
      assert.ok(out.data.accounts.some(a => a.id === t.accountId), 'the account exists in the export');
    }
    assert.equal(out.data.accounts[0].currentBalance, 80.11, '100 - 19.99 + 0.1');
  });

  test('is read-only and leaks no internals', async () => {
    await importNow(simple());
    const before = { counts: counts(), sequences: sequences() };
    const response = await call('GET', '/api/export');
    assert.deepEqual(counts(), before.counts);
    assert.deepEqual(sequences(), before.sequences);
    assert.doesNotMatch(response.text, /expense-import-test|node_modules|sqlite|balance_minor|amount_minor|\.db\b/i);
    assert.deepEqual(Object.keys(response.json.data).sort(), ['counts', 'data', 'exportedAt', 'format', 'version']);
  });

  test('fails honestly when the database is unavailable, then recovers', async () => {
    const path2 = path.join(tmpRoot, 'import-2.db');
    db.closeDatabase();
    try {
      assertError(await call('GET', '/api/export'), 500, 'INTERNAL_ERROR');
    } finally {
      db.initDatabase(path2);
    }
    assert.equal((await call('GET', '/api/export')).status, 200);
  });
});
