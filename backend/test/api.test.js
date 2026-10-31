'use strict';

// Automated checks for the API (accounts, categories, transactions).
// Run with:  npm test
//
// Unlike server.test.js, this file runs the real HTTP server INSIDE the test
// process (createServer from server.js) on a random port, connected to a
// throw-away PostgreSQL schema inside the TEST_DATABASE_URL database. Requests
// are real HTTP requests. Your real database and your browser's localStorage
// are never touched.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const db = require('../db');
const errors = require('../db-errors');
const { createServer, toApiError } = require('../server');
const { TEST_URL, createTestSchema, admin } = require('./helpers/pg-test-db');

// All tests in this file use one throw-away schema. The application_name lets a
// test drop THIS file's connections without touching other test files'.
let testSchema;
function connectionOptions(schema = testSchema) {
  const url = new URL(TEST_URL);
  url.searchParams.set('application_name', schema.schema);
  return { connectionString: url.toString(), schema: schema.schema };
}

let server;
let port;

function listen() {
  server = createServer();
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

function stopListening() {
  return new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

before(async () => {
  testSchema = await createTestSchema();
  await db.initDatabase(connectionOptions());
  await listen();
});

after(async () => {
  await stopListening();
  await db.closeDatabase();
  await testSchema.drop();
});

// Every test starts from empty tables (the schema itself stays).
beforeEach(async () => {
  await db.query('DELETE FROM transactions; DELETE FROM categories; DELETE FROM accounts;');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sends a request with the exact path/body/headers given. A body that is not a
// string is sent as JSON; `raw` sends a string untouched (for malformed JSON).
function call(method, urlPath, body, { headers = {}, raw } = {}) {
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

// Checks the standard error envelope and that nothing internal leaks out.
function assertError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, code, response.text);
  assert.equal(typeof response.json.error.message, 'string');
  assert.doesNotMatch(response.text, /node_modules|\.js:\d|\bat .*\(|expense-api-test|SQLITE|sqlite|postgres|SQLSTATE|violates|relation "|pg_/i, 'no internals leaked');
}

function fieldsOf(response) {
  return response.json.error.details.map(detail => detail.field).sort();
}

async function mkAccount(overrides = {}) {
  const response = await call('POST', '/api/accounts', { name: 'Cash', type: 'cash', balance: 0, ...overrides });
  assert.equal(response.status, 201, response.text);
  return response.json.data;
}

async function mkCategory(overrides = {}) {
  const response = await call('POST', '/api/categories', { name: 'Salary', type: 'income', ...overrides });
  assert.equal(response.status, 201, response.text);
  return response.json.data;
}

// Creates a transaction (and the account/category it needs unless given).
async function mkTransaction(overrides = {}) {
  const account = overrides.accountId ? null : await mkAccount();
  const category = overrides.categoryId ? null : await mkCategory();
  const response = await call('POST', '/api/transactions', {
    type: 'income',
    description: 'Pay',
    categoryId: category && category.id,
    accountId: account && account.id,
    amount: 10,
    date: '2025-01-15',
    ...overrides
  });
  assert.equal(response.status, 201, response.text);
  return { transaction: response.json.data, account, category };
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('accounts', () => {
  test('list is empty on a fresh database (nothing is seeded)', async () => {
    const response = await call('GET', '/api/accounts');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, data: [] });
  });

  test('create returns 201, a Location header and the stored account', async () => {
    const response = await call('POST', '/api/accounts', { name: '  Wallet ', type: 'cash', balance: 100.5 });
    assert.equal(response.status, 201);
    const account = response.json.data;
    assert.match(account.id, /^acc-/);
    assert.equal(response.headers.location, `/api/accounts/${account.id}`);
    assert.deepEqual(account, { id: account.id, name: 'Wallet', type: 'cash', balance: 100.5, currentBalance: 100.5 });
  });

  test('a client-supplied id is kept (needed to import existing records later)', async () => {
    const account = await mkAccount({ id: 'acc-cash', name: 'Cash' });
    assert.equal(account.id, 'acc-cash');
    assert.equal((await call('GET', '/api/accounts/acc-cash')).json.data.name, 'Cash');
  });

  test('all six account types are accepted; a zero balance is allowed', async () => {
    for (const type of ['cash', 'bank', 'online', 'asset', 'receivable', 'payable']) {
      const account = await mkAccount({ name: `A ${type}`, type, balance: 0 });
      assert.equal(account.type, type);
      assert.equal(account.balance, 0);
    }
  });

  test('list returns accounts in creation order', async () => {
    await mkAccount({ name: 'Zebra' });
    await mkAccount({ name: 'Apple' });
    await mkAccount({ name: 'Mango' });
    const names = (await call('GET', '/api/accounts')).json.data.map(account => account.name);
    assert.deepEqual(names, ['Zebra', 'Apple', 'Mango']);
  });

  test('get by id returns the account; unknown id is 404; malformed id is 400', async () => {
    const account = await mkAccount();
    assert.deepEqual((await call('GET', `/api/accounts/${account.id}`)).json.data, account);
    assertError(await call('GET', '/api/accounts/acc-nope'), 404, 'NOT_FOUND');
    assertError(await call('GET', '/api/accounts/a%20b'), 400, 'INVALID_ID');
    assertError(await call('GET', '/api/accounts/%E0%A4%A'), 400, 'INVALID_ID');
  });

  test('update (PUT) changes the account and persists it', async () => {
    const account = await mkAccount({ balance: 5 });
    const response = await call('PUT', `/api/accounts/${account.id}`, { name: 'Savings', type: 'bank', balance: 250.75 });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data, { id: account.id, name: 'Savings', type: 'bank', balance: 250.75, currentBalance: 250.75 });

    const again = await call('GET', `/api/accounts/${account.id}`);
    assert.deepEqual(again.json.data, response.json.data);
    const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [account.id]);
    assert.equal(rows[0].balance_minor, 25075, 'stored as whole paise');
  });

  test('update of a missing account is 404', async () => {
    assertError(await call('PUT', '/api/accounts/acc-nope', { name: 'X', type: 'cash', balance: 0 }), 404, 'NOT_FOUND');
  });

  test('delete removes an unused account', async () => {
    const account = await mkAccount();
    const response = await call('DELETE', `/api/accounts/${account.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, data: { id: account.id } });
    assertError(await call('GET', `/api/accounts/${account.id}`), 404, 'NOT_FOUND');
    assertError(await call('DELETE', `/api/accounts/${account.id}`), 404, 'NOT_FOUND');
  });

  test('missing required fields are all reported together', async () => {
    const response = await call('POST', '/api/accounts', {});
    assertError(response, 400, 'VALIDATION_ERROR');
    assert.deepEqual(fieldsOf(response), ['balance', 'name', 'type']);
  });

  test('wrong field types are rejected', async () => {
    const response = await call('POST', '/api/accounts', { name: 123, type: ['cash'], balance: '10' });
    assertError(response, 400, 'VALIDATION_ERROR');
    assert.deepEqual(fieldsOf(response), ['balance', 'name', 'type']);
  });

  test('invalid values are rejected', async () => {
    const bad = [
      [{ name: 'A', type: 'wallet', balance: 0 }, 'type'],
      [{ name: 'A', type: 'cash', balance: -1 }, 'balance'],
      [{ name: 'A', type: 'cash', balance: 1000000000.01 }, 'balance'],
      [{ name: 'A', type: 'cash', balance: 1.005 }, 'balance'],
      [{ name: '   ', type: 'cash', balance: 0 }, 'name'],
      [{ name: 'x'.repeat(41), type: 'cash', balance: 0 }, 'name'],
      [{ name: 'A', type: 'cash', balance: 0, color: 'red' }, 'color'],
      [{ id: 'bad id!', name: 'A', type: 'cash', balance: 0 }, 'id']
    ];
    for (const [body, field] of bad) {
      const response = await call('POST', '/api/accounts', body);
      assertError(response, 400, 'VALIDATION_ERROR');
      assert.ok(fieldsOf(response).includes(field), `${JSON.stringify(body)} should flag ${field}`);
    }
    assert.equal((await call('GET', '/api/accounts')).json.data.length, 0, 'nothing was stored');
  });

  test('the limits themselves are accepted (name 40 chars, balance 1,000,000,000)', async () => {
    const account = await mkAccount({ name: 'x'.repeat(40), balance: 1000000000 });
    assert.equal(account.balance, 1000000000);
  });

  test('duplicate names are refused ignoring case, also for non-English letters', async () => {
    await mkAccount({ name: 'Bank Account', type: 'bank' });
    assertError(await call('POST', '/api/accounts', { name: 'bank ACCOUNT', type: 'cash', balance: 0 }), 409, 'CONFLICT');

    await mkAccount({ name: 'Épargne', type: 'bank' });
    assertError(await call('POST', '/api/accounts', { name: 'épargne', type: 'bank', balance: 0 }), 409, 'CONFLICT');
  });

  test('a duplicate id is refused', async () => {
    await mkAccount({ id: 'acc-1', name: 'One' });
    assertError(await call('POST', '/api/accounts', { id: 'acc-1', name: 'Two', type: 'cash', balance: 0 }), 409, 'CONFLICT');
  });

  test('renaming to another account\'s name is refused; keeping your own name is fine', async () => {
    const one = await mkAccount({ name: 'One' });
    await mkAccount({ name: 'Two' });
    assertError(await call('PUT', `/api/accounts/${one.id}`, { name: 'TWO', type: 'cash', balance: 0 }), 409, 'CONFLICT');
    const same = await call('PUT', `/api/accounts/${one.id}`, { name: 'one', type: 'cash', balance: 1 });
    assert.equal(same.status, 200);
  });

  test('currentBalance = initial balance + income - expense, exact to the paisa', async () => {
    const account = await mkAccount({ balance: 100 });
    const income = await mkCategory({ name: 'Salary', type: 'income' });
    const expense = await mkCategory({ name: 'Food', type: 'expense' });
    await mkTransaction({ type: 'income', categoryId: income.id, accountId: account.id, amount: 50.25 });
    await mkTransaction({ type: 'expense', categoryId: expense.id, accountId: account.id, amount: 20.1 });
    await mkTransaction({ type: 'expense', categoryId: expense.id, accountId: account.id, amount: 0.1 });
    await mkTransaction({ type: 'expense', categoryId: expense.id, accountId: account.id, amount: 0.2 });

    const fetched = (await call('GET', `/api/accounts/${account.id}`)).json.data;
    assert.equal(fetched.balance, 100, 'the stored initial balance does not change');
    assert.equal(fetched.currentBalance, 129.85);
    assert.equal((await call('GET', '/api/accounts')).json.data[0].currentBalance, 129.85);
  });

  test('an account used by transactions cannot be deleted, and nothing is lost', async () => {
    const { account, transaction } = await mkTransaction();
    const response = await call('DELETE', `/api/accounts/${account.id}`);
    assertError(response, 409, 'IN_USE');
    assert.match(response.json.error.message, /1 transaction/);
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).status, 200);
    assert.equal((await call('GET', `/api/transactions/${transaction.id}`)).status, 200);
  });

  test('an account with transactions cannot change to a type that cannot hold them', async () => {
    const { account } = await mkTransaction();
    assertError(await call('PUT', `/api/accounts/${account.id}`, { name: 'Cash', type: 'asset', balance: 0 }), 409, 'IN_USE');
    assert.equal((await call('PUT', `/api/accounts/${account.id}`, { name: 'Cash', type: 'bank', balance: 0 })).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe('categories', () => {
  test('list is empty on a fresh database (nothing is seeded)', async () => {
    assert.deepEqual((await call('GET', '/api/categories')).json, { ok: true, data: [] });
  });

  test('create returns 201, a Location header and the stored category', async () => {
    const response = await call('POST', '/api/categories', { name: ' Groceries ', type: 'expense' });
    assert.equal(response.status, 201);
    assert.deepEqual(response.json.data, { id: response.json.data.id, name: 'Groceries', type: 'expense' });
    assert.equal(typeof response.json.data.id, 'number');
    assert.equal(response.headers.location, `/api/categories/${response.json.data.id}`);
  });

  test('list is in creation order; get by id works; unknown id is 404; bad id is 400', async () => {
    const b = await mkCategory({ name: 'B', type: 'expense' });
    const a = await mkCategory({ name: 'A', type: 'income' });
    assert.deepEqual((await call('GET', '/api/categories')).json.data, [b, a]);
    assert.deepEqual((await call('GET', `/api/categories/${a.id}`)).json.data, a);
    assertError(await call('GET', '/api/categories/9999'), 404, 'NOT_FOUND');
    assertError(await call('GET', '/api/categories/abc'), 400, 'INVALID_ID');
    assertError(await call('GET', '/api/categories/0'), 400, 'INVALID_ID');
    assertError(await call('GET', '/api/categories/1.5'), 400, 'INVALID_ID');
  });

  test('update (PUT) renames and persists', async () => {
    const category = await mkCategory({ name: 'Food', type: 'expense' });
    const response = await call('PUT', `/api/categories/${category.id}`, { name: 'Dining', type: 'expense' });
    assert.equal(response.status, 200);
    assert.deepEqual((await call('GET', `/api/categories/${category.id}`)).json.data, { id: category.id, name: 'Dining', type: 'expense' });
    assertError(await call('PUT', '/api/categories/9999', { name: 'X', type: 'expense' }), 404, 'NOT_FOUND');
  });

  test('delete removes an unused category', async () => {
    const category = await mkCategory();
    assert.equal((await call('DELETE', `/api/categories/${category.id}`)).status, 200);
    assertError(await call('GET', `/api/categories/${category.id}`), 404, 'NOT_FOUND');
    assertError(await call('DELETE', `/api/categories/${category.id}`), 404, 'NOT_FOUND');
  });

  test('missing fields, wrong types and bad values are rejected', async () => {
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', {})), ['name', 'type']);
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', { name: 5, type: true })), ['name', 'type']);
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', { name: 'x'.repeat(31), type: 'expense' })), ['name']);
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', { name: 'A', type: 'other' })), ['type']);
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', { name: ' ', type: 'income' })), ['name']);
    assert.deepEqual(fieldsOf(await call('POST', '/api/categories', { name: 'A', type: 'income', id: 3 })), ['id']);
    assert.equal((await mkCategory({ name: 'x'.repeat(30) })).name.length, 30);
  });

  test('names are unique per type ignoring case; the same name may exist under the other type', async () => {
    await mkCategory({ name: 'Other', type: 'expense' });
    assertError(await call('POST', '/api/categories', { name: 'OTHER', type: 'expense' }), 409, 'CONFLICT');
    const income = await mkCategory({ name: 'Other', type: 'income' });
    assert.equal(income.type, 'income');

    const second = await mkCategory({ name: 'Second', type: 'expense' });
    assertError(await call('PUT', `/api/categories/${second.id}`, { name: 'other', type: 'expense' }), 409, 'CONFLICT');
  });

  test('a category used by transactions cannot be deleted', async () => {
    const { category, transaction } = await mkTransaction();
    const response = await call('DELETE', `/api/categories/${category.id}`);
    assertError(response, 409, 'IN_USE');
    assert.equal((await call('GET', `/api/categories/${category.id}`)).status, 200);
    assert.equal((await call('GET', `/api/transactions/${transaction.id}`)).status, 200);
  });

  test('renaming a used category is allowed and transactions show the new name', async () => {
    const { category, transaction } = await mkTransaction();
    await call('PUT', `/api/categories/${category.id}`, { name: 'Wages', type: 'income' });
    assert.equal((await call('GET', `/api/transactions/${transaction.id}`)).json.data.category, 'Wages');
  });

  test('changing the type of a used category is refused; of an unused one it is allowed', async () => {
    const { category } = await mkTransaction();
    assertError(await call('PUT', `/api/categories/${category.id}`, { name: 'Salary', type: 'expense' }), 409, 'IN_USE');
    assert.equal((await call('GET', `/api/categories/${category.id}`)).json.data.type, 'income');

    const unused = await mkCategory({ name: 'Spare', type: 'income' });
    assert.equal((await call('PUT', `/api/categories/${unused.id}`, { name: 'Spare', type: 'expense' })).json.data.type, 'expense');
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('transactions', () => {
  test('list is empty on a fresh database', async () => {
    assert.deepEqual((await call('GET', '/api/transactions')).json, { ok: true, data: [] });
  });

  test('create returns 201, a Location header and the stored transaction (with the category name)', async () => {
    const account = await mkAccount();
    const category = await mkCategory({ name: 'Groceries', type: 'expense' });
    const response = await call('POST', '/api/transactions', {
      type: 'expense',
      description: '  Milk  ',
      categoryId: category.id,
      accountId: account.id,
      amount: 19.99,
      note: ' for tea ',
      date: '2025-03-04'
    });
    assert.equal(response.status, 201);
    const txn = response.json.data;
    assert.match(txn.id, /^txn-/);
    assert.equal(response.headers.location, `/api/transactions/${txn.id}`);
    assert.deepEqual(txn, {
      id: txn.id,
      type: 'expense',
      description: 'Milk',
      categoryId: category.id,
      category: 'Groceries',
      accountId: account.id,
      amount: 19.99,
      note: 'for tea',
      date: '2025-03-04',
      createdAt: txn.createdAt
    });
    assert.ok(Math.abs(txn.createdAt - Date.now()) < 60000, 'createdAt defaults to now');
  });

  test('note defaults to an empty string; a client id and createdAt are kept; today is a valid date', async () => {
    const { transaction } = await mkTransaction({ id: 'txn-old-1', createdAt: 1700000000000, date: todayISO() });
    assert.equal(transaction.id, 'txn-old-1');
    assert.equal(transaction.createdAt, 1700000000000);
    assert.equal(transaction.note, '');
    assert.equal(transaction.date, todayISO());
  });

  test('amounts round-trip exactly and are stored as whole paise', async () => {
    const account = await mkAccount();
    const category = await mkCategory();
    for (const amount of [0.01, 0.07, 1.15, 19.99, 4.35, 1000000000]) {
      const response = await call('POST', '/api/transactions', {
        type: 'income', description: 'x', categoryId: category.id, accountId: account.id, amount, date: '2025-01-01'
      });
      assert.equal(response.json.data.amount, amount, `amount ${amount}`);
      const { rows } = await db.query('SELECT amount_minor FROM transactions WHERE id = $1', [response.json.data.id]);
      assert.equal(rows[0].amount_minor, Math.round(amount * 100));
    }
  });

  test('list is newest date first, then newest created; ties keep insertion order', async () => {
    const account = await mkAccount();
    const category = await mkCategory();
    const make = (description, date, createdAt) =>
      call('POST', '/api/transactions', { type: 'income', description, categoryId: category.id, accountId: account.id, amount: 1, date, createdAt });
    await make('old', '2025-01-01', 5);
    await make('new-early', '2025-02-01', 1);
    await make('new-late', '2025-02-01', 9);
    await make('tie-a', '2025-01-15', 7);
    await make('tie-b', '2025-01-15', 7);
    const order = (await call('GET', '/api/transactions')).json.data.map(txn => txn.description);
    assert.deepEqual(order, ['new-late', 'new-early', 'tie-a', 'tie-b', 'old']);
  });

  test('get by id; unknown id is 404; malformed id is 400', async () => {
    const { transaction } = await mkTransaction();
    assert.deepEqual((await call('GET', `/api/transactions/${transaction.id}`)).json.data, transaction);
    assertError(await call('GET', '/api/transactions/txn-nope'), 404, 'NOT_FOUND');
    assertError(await call('GET', '/api/transactions/a%2Fb'), 400, 'INVALID_ID');
  });

  test('update (PUT) changes every editable field and persists; id and createdAt stay', async () => {
    const { transaction, account } = await mkTransaction({ createdAt: 1700000000000 });
    const bank = await mkAccount({ name: 'Bank', type: 'bank' });
    const expense = await mkCategory({ name: 'Food', type: 'expense' });

    const response = await call('PUT', `/api/transactions/${transaction.id}`, {
      type: 'expense', description: 'Lunch', categoryId: expense.id, accountId: bank.id, amount: 12.5, note: 'n', date: '2025-02-02'
    });
    assert.equal(response.status, 200, response.text);
    const expected = {
      id: transaction.id, type: 'expense', description: 'Lunch', categoryId: expense.id, category: 'Food',
      accountId: bank.id, amount: 12.5, note: 'n', date: '2025-02-02', createdAt: 1700000000000
    };
    assert.deepEqual(response.json.data, expected);
    assert.deepEqual((await call('GET', `/api/transactions/${transaction.id}`)).json.data, expected);
    assert.notEqual(account.id, bank.id);
  });

  test('update: missing record is 404; id/createdAt cannot be sent; bad data and bad references are refused', async () => {
    const { transaction, account, category } = await mkTransaction();
    const valid = { type: 'income', description: 'd', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01' };

    assertError(await call('PUT', '/api/transactions/txn-nope', valid), 404, 'NOT_FOUND');
    assert.deepEqual(fieldsOf(await call('PUT', `/api/transactions/${transaction.id}`, { ...valid, id: 'x' })), ['id']);
    assert.deepEqual(fieldsOf(await call('PUT', `/api/transactions/${transaction.id}`, { ...valid, amount: 0 })), ['amount']);
    assert.deepEqual(fieldsOf(await call('PUT', `/api/transactions/${transaction.id}`, { ...valid, categoryId: 999 })), ['categoryId']);
    assert.deepEqual(fieldsOf(await call('PUT', `/api/transactions/${transaction.id}`, { ...valid, accountId: 'acc-nope' })), ['accountId']);
    assert.deepEqual(fieldsOf(await call('PUT', `/api/transactions/${transaction.id}`, { ...valid, type: 'expense' })), ['categoryId']);

    const unchanged = (await call('GET', `/api/transactions/${transaction.id}`)).json.data;
    assert.equal(unchanged.amount, 10, 'failed updates changed nothing');
    assert.equal(unchanged.type, 'income');
  });

  test('delete removes the transaction and frees its account and category for deletion', async () => {
    const { transaction, account, category } = await mkTransaction();
    const response = await call('DELETE', `/api/transactions/${transaction.id}`);
    assert.deepEqual(response.json, { ok: true, data: { id: transaction.id } });
    assertError(await call('GET', `/api/transactions/${transaction.id}`), 404, 'NOT_FOUND');
    assertError(await call('DELETE', `/api/transactions/${transaction.id}`), 404, 'NOT_FOUND');
    assert.equal((await call('DELETE', `/api/accounts/${account.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/categories/${category.id}`)).status, 200);
  });

  test('missing required fields are all reported together (note is optional)', async () => {
    const response = await call('POST', '/api/transactions', {});
    assertError(response, 400, 'VALIDATION_ERROR');
    assert.deepEqual(fieldsOf(response), ['accountId', 'amount', 'categoryId', 'date', 'description', 'type']);
  });

  test('wrong field types are rejected', async () => {
    const response = await call('POST', '/api/transactions', {
      type: 1, description: 2, categoryId: '1', accountId: 3, amount: '10', note: 4, date: 20250101
    });
    assertError(response, 400, 'VALIDATION_ERROR');
    assert.deepEqual(fieldsOf(response), ['accountId', 'amount', 'categoryId', 'date', 'description', 'note', 'type']);
  });

  test('invalid values are rejected', async () => {
    const account = await mkAccount();
    const category = await mkCategory();
    const base = { type: 'income', description: 'd', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01' };
    const bad = [
      [{ amount: 0 }, 'amount'],
      [{ amount: -5 }, 'amount'],
      [{ amount: 1000000000.01 }, 'amount'],
      [{ amount: 1.001 }, 'amount'],
      [{ amount: null }, 'amount'],
      [{ description: '   ' }, 'description'],
      [{ description: 'x'.repeat(101) }, 'description'],
      [{ note: 'x'.repeat(201) }, 'note'],
      [{ type: 'transfer' }, 'type'],
      [{ date: '2025-1-1' }, 'date'],
      [{ date: '2025-02-30' }, 'date'],
      [{ date: '2025-13-01' }, 'date'],
      [{ date: '1850-01-01' }, 'date'],
      [{ date: '2999-01-01' }, 'date'],
      [{ categoryId: 0 }, 'categoryId'],
      [{ categoryId: 1.5 }, 'categoryId'],
      [{ createdAt: -1 }, 'createdAt'],
      [{ createdAt: 'now' }, 'createdAt'],
      [{ category: 'Salary' }, 'category']
    ];
    for (const [change, field] of bad) {
      const response = await call('POST', '/api/transactions', { ...base, ...change });
      assertError(response, 400, 'VALIDATION_ERROR');
      assert.ok(fieldsOf(response).includes(field), `${JSON.stringify(change)} should flag ${field}: ${response.text}`);
    }
    assert.equal((await call('GET', '/api/transactions')).json.data.length, 0, 'nothing was stored');

    // The limits themselves are accepted.
    const ok = await call('POST', '/api/transactions', {
      ...base, description: 'x'.repeat(100), note: 'y'.repeat(200), amount: 1000000000
    });
    assert.equal(ok.status, 201, ok.text);
  });

  test('invalid references are refused with the offending field named', async () => {
    const account = await mkAccount();
    const income = await mkCategory({ name: 'Pay', type: 'income' });
    const asset = await mkAccount({ name: 'House', type: 'asset' });
    const base = { type: 'income', description: 'd', categoryId: income.id, accountId: account.id, amount: 1, date: '2025-01-01' };

    const noCategory = await call('POST', '/api/transactions', { ...base, categoryId: 12345 });
    assertError(noCategory, 400, 'VALIDATION_ERROR');
    assert.deepEqual(noCategory.json.error.details, [{ field: 'categoryId', message: 'No category with this id.' }]);

    const noAccount = await call('POST', '/api/transactions', { ...base, accountId: 'acc-ghost' });
    assert.deepEqual(noAccount.json.error.details, [{ field: 'accountId', message: 'No account with this id.' }]);

    const wrongType = await call('POST', '/api/transactions', { ...base, type: 'expense' });
    assert.deepEqual(fieldsOf(wrongType), ['categoryId']);
    assert.match(wrongType.json.error.details[0].message, /income category/);

    const notMoney = await call('POST', '/api/transactions', { ...base, accountId: asset.id });
    assert.deepEqual(fieldsOf(notMoney), ['accountId']);

    assert.equal((await call('GET', '/api/transactions')).json.data.length, 0, 'nothing was stored');
  });

  test('a duplicate id is refused', async () => {
    const { account, category } = await mkTransaction({ id: 'txn-1' });
    const response = await call('POST', '/api/transactions', {
      id: 'txn-1', type: 'income', description: 'again', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01'
    });
    assertError(response, 409, 'CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Request handling: malformed input, methods, routes, safety
// ---------------------------------------------------------------------------

describe('request handling', () => {
  test('malformed JSON is 400 INVALID_JSON and nothing is stored', async () => {
    assertError(await call('POST', '/api/accounts', undefined, { raw: '{"name": "A", ' }), 400, 'INVALID_JSON');
    assertError(await call('POST', '/api/accounts', undefined, { raw: "{'name': 'A'}" }), 400, 'INVALID_JSON');
    assertError(await call('PUT', '/api/accounts/x', undefined, { raw: 'not json' }), 400, 'INVALID_JSON');
    assert.equal((await call('GET', '/api/accounts')).json.data.length, 0);
  });

  test('an empty body is 400 INVALID_JSON', async () => {
    assertError(await call('POST', '/api/accounts', undefined, { raw: '' }), 400, 'INVALID_JSON');
    assertError(await call('POST', '/api/accounts', undefined, { headers: { 'Content-Type': 'application/json' } }), 400, 'INVALID_JSON');
  });

  test('a body that is valid JSON but not an object is 400 INVALID_BODY', async () => {
    for (const raw of ['[]', '[{"name":"A"}]', 'null', '"text"', '42', 'true']) {
      assertError(await call('POST', '/api/accounts', undefined, { raw }), 400, 'INVALID_BODY');
    }
  });

  test('a body that is not sent as JSON is 415', async () => {
    const body = '{"name":"A","type":"cash","balance":0}';
    assertError(await call('POST', '/api/accounts', undefined, { raw: body, headers: { 'Content-Type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    assertError(await call('POST', '/api/accounts', undefined, { raw: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal((await call('GET', '/api/accounts')).json.data.length, 0);
  });

  test('application/json with a charset is accepted', async () => {
    const response = await call('POST', '/api/accounts', { name: 'A', type: 'cash', balance: 0 }, { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } });
    assert.equal(response.status, 201);
  });

  test('an oversized body is 413 and the server keeps working', async () => {
    const big = JSON.stringify({ name: 'A', type: 'cash', balance: 0, padding: 'x'.repeat(100000) });
    assertError(await call('POST', '/api/accounts', undefined, { raw: big }), 413, 'PAYLOAD_TOO_LARGE');
    assert.equal((await call('GET', '/api/health')).status, 200);
    assert.equal((await call('GET', '/api/accounts')).json.data.length, 0);
  });

  test('unsupported methods are 405 with an Allow header', async () => {
    const cases = [
      ['PATCH', '/api/accounts', 'GET, POST'],
      ['DELETE', '/api/accounts', 'GET, POST'],
      ['PUT', '/api/categories', 'GET, POST'],
      ['POST', '/api/accounts/acc-1', 'GET, PUT, DELETE'],
      ['PATCH', '/api/transactions/txn-1', 'GET, PUT, DELETE'],
      ['POST', '/api/categories/1', 'GET, PUT, DELETE'],
      ['PUT', '/api/health', 'GET'],
      ['DELETE', '/api/health', 'GET']
    ];
    for (const [method, urlPath, allow] of cases) {
      const response = await call(method, urlPath, method === 'PATCH' || method === 'POST' || method === 'PUT' ? {} : undefined);
      assertError(response, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(response.headers.allow, allow, `${method} ${urlPath}`);
    }
  });

  test('unknown API routes are 404 JSON', async () => {
    for (const urlPath of ['/api/unknown', '/api/accounts/a/b', '/api/accounts/', '/api/transactions/x/y', '/api/accountsx']) {
      assertError(await call('GET', urlPath), 404, 'NOT_FOUND');
    }
  });

  test('HEAD works like GET without a body', async () => {
    await mkAccount();
    const response = await call('HEAD', '/api/accounts');
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
  });

  test('a DELETE with a body, and query strings, are tolerated', async () => {
    const account = await mkAccount();
    assert.equal((await call('GET', `/api/accounts/${account.id}?x=1`)).status, 200);
    const response = await call('DELETE', `/api/accounts/${account.id}`, { ignored: true });
    assert.equal(response.status, 200);
  });

  test('ids such as __proto__ or constructor are just unknown ids, not crashes', async () => {
    assertError(await call('GET', '/api/accounts/__proto__'), 404, 'NOT_FOUND');
    assertError(await call('GET', '/api/transactions/constructor'), 404, 'NOT_FOUND');
    assertError(await call('POST', '/api/accounts', { __proto__: null, name: 'A', type: 'cash', balance: 0, constructor: 1 }), 400, 'VALIDATION_ERROR');
    assert.equal((await call('GET', '/api/health')).status, 200);
  });

  test('SQL injection attempts are stored as plain text or rejected; tables survive', async () => {
    const evil = "x'); DROP TABLE accounts; --";
    const account = await mkAccount({ name: evil });
    assert.equal(account.name, evil);
    assert.equal((await call('GET', `/api/accounts/${encodeURIComponent("x' OR '1'='1")}`)).status, 400);
    assertError(await call('GET', `/api/accounts/${encodeURIComponent("acc-1' OR '1'='1")}`), 400, 'INVALID_ID');
    assert.equal((await call('GET', '/api/accounts')).json.data.length, 1);
    const tables = await db.query(`SELECT to_regclass('accounts') AS accounts`);
    assert.ok(tables.rows[0].accounts, 'the accounts table still exists');
  });

  test('unicode text round-trips', async () => {
    const category = await mkCategory({ name: 'किराना 🛒', type: 'expense' });
    assert.equal((await call('GET', `/api/categories/${category.id}`)).json.data.name, 'किराना 🛒');
  });

  test('the server stays healthy after a burst of bad requests', async () => {
    for (let i = 0; i < 20; i += 1) {
      await call('POST', '/api/transactions', undefined, { raw: '{{{' });
      await call('POST', '/api/accounts', {});
      await call('GET', '/api/accounts/%');
    }
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.data.database.ready, true);
  });
});

// ---------------------------------------------------------------------------
// Database constraints (talking to PostgreSQL directly, bypassing the API checks)
// ---------------------------------------------------------------------------

describe('database constraints', () => {
  const insertAccount = () =>
    db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a1', 'Cash', 'cash', 0)");
  const insertCategory = async type =>
    (await db.query('INSERT INTO categories (name, type) VALUES ($1, $2) RETURNING id', [`c-${type}`, type])).rows[0].id;
  const insertTxn = (overrides = {}) => {
    const row = { id: 't1', type: 'income', description: 'd', category_id: 0, account_id: 'a1', amount_minor: 100, note: '', date: '2025-01-01', created_at: 1, ...overrides };
    return db.query(
      'INSERT INTO transactions (id, type, description, category_id, account_id, amount_minor, note, date, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [row.id, row.type, row.description, row.category_id, row.account_id, row.amount_minor, row.note, row.date, row.created_at]
    );
  };
  // Asserts that the database refuses with the given SQLSTATE code.
  const refuses = (promise, code) => assert.rejects(promise, error => error.code === code);

  test('foreign keys are declared and enforced by the database', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = 'transactions'::regclass`
    );
    assert.equal(rows[0].n, 2, 'one foreign key to accounts, one to categories');
  });

  test('a transaction cannot reference a missing account or category', async () => {
    await insertAccount();
    const category = await insertCategory('income');
    await refuses(insertTxn({ category_id: category, account_id: 'ghost' }), '23503');
    await refuses(insertTxn({ category_id: 9999 }), '23503');
    await insertTxn({ category_id: category });
  });

  test('the category type must match the transaction type (composite foreign key)', async () => {
    await insertAccount();
    const expense = await insertCategory('expense');
    await refuses(insertTxn({ type: 'income', category_id: expense }), '23503');
    await insertTxn({ type: 'expense', category_id: expense });
  });

  test('referenced accounts and categories cannot be deleted, and a used category cannot change type', async () => {
    await insertAccount();
    const category = await insertCategory('income');
    await insertTxn({ category_id: category });
    await refuses(db.query("DELETE FROM accounts WHERE id = 'a1'"), '23503');
    await refuses(db.query('DELETE FROM categories WHERE id = $1', [category]), '23503');
    await refuses(db.query(`UPDATE categories SET type = 'expense' WHERE id = $1`, [category]), '23503');
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM accounts')).rows[0].n, 1);
  });

  test('CHECK and UNIQUE constraints reject bad rows even without the API', async () => {
    await insertAccount();
    const category = await insertCategory('income');
    await refuses(insertTxn({ category_id: category, amount_minor: 0 }), '23514');
    await refuses(insertTxn({ category_id: category, amount_minor: -5 }), '23514');
    await refuses(insertTxn({ category_id: category, date: 'yesterday' }), '23514');
    await refuses(insertTxn({ category_id: category, description: '' }), '23514');
    await refuses(db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a2', 'x', 'wallet', 0)"), '23514');
    await refuses(db.query("INSERT INTO accounts (id, name, type, balance_minor) VALUES ('a2', 'CASH', 'cash', 0)"), '23505');
    await refuses(db.query("INSERT INTO categories (name, type) VALUES ('C-INCOME', 'income')"), '23505');
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL-specific behaviour of the API
// ---------------------------------------------------------------------------

describe('PostgreSQL behaviour', () => {
  test('concurrent creates of the same account: exactly one wins, the rest are 409', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () =>
      call('POST', '/api/accounts', { name: 'Race', type: 'cash', balance: 1 })
    ));
    const statuses = responses.map(response => response.status).sort();
    assert.equal(statuses.filter(status => status === 201).length, 1, statuses.join());
    for (const response of responses.filter(item => item.status !== 201)) {
      assertError(response, 409, 'CONFLICT'); // from the pre-check or from the unique index
    }
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM accounts')).rows[0].n, 1);
  });

  test('concurrent creates with the same transaction id: exactly one wins', async () => {
    const account = await mkAccount();
    const category = await mkCategory();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      call('POST', '/api/transactions', { id: 'txn-same', type: 'income', description: 'x', categoryId: category.id, accountId: account.id, amount: 5, date: '2025-01-01' })
    ));
    assert.equal(responses.filter(response => response.status === 201).length, 1);
    for (const response of responses.filter(item => item.status !== 201)) assertError(response, 409, 'CONFLICT');
    assert.equal((await db.query('SELECT COUNT(*) AS n FROM transactions')).rows[0].n, 1);
  });

  test('account balances stay consistent with the transactions, including very large amounts', async () => {
    const wallet = await mkAccount({ name: 'Wallet', balance: 100.1 });
    const bank = await mkAccount({ name: 'Bank', type: 'bank', balance: 0 });
    const salary = await mkCategory();
    const food = await mkCategory({ name: 'Food', type: 'expense' });
    const plan = [
      ['income', salary, wallet, 1000000000], ['income', salary, wallet, 1000000000], ['income', salary, bank, 1000000000],
      ['expense', food, wallet, 0.1], ['expense', food, wallet, 0.2], ['expense', food, bank, 999999999.99], ['income', salary, bank, 19.99]
    ];
    for (const [type, category, account, amount] of plan) {
      const response = await call('POST', '/api/transactions', { type, description: 'x', categoryId: category.id, accountId: account.id, amount, date: '2025-01-01' });
      assert.equal(response.status, 201, response.text);
    }

    // Expected values worked out independently, in whole paise.
    const paise = value => Math.round(value * 100);
    const expected = account => plan.reduce(
      (sum, [type, , owner, amount]) => (owner.id === account.id ? sum + (type === 'income' ? paise(amount) : -paise(amount)) : sum),
      paise(account.balance)
    ) / 100;

    for (const account of [wallet, bank]) {
      const response = await call('GET', `/api/accounts/${account.id}`);
      assert.equal(response.json.data.currentBalance, expected(account), account.name);
    }
    const list = (await call('GET', '/api/accounts')).json.data;
    assert.deepEqual(list.map(item => item.currentBalance), [expected(wallet), expected(bank)]);
    assert.equal(wallet.balance, 100.1, 'the opening balance is not changed by transactions');
  });

  test('deleting and editing transactions moves the balance the same way', async () => {
    const { transaction, account, category } = await mkTransaction({ amount: 50, type: 'income' });
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).json.data.currentBalance, 50);
    const edited = await call('PUT', `/api/transactions/${transaction.id}`, {
      type: 'income', description: 'Pay', categoryId: category.id, accountId: account.id, amount: 70.25, note: '', date: '2025-01-15'
    });
    assert.equal(edited.status, 200);
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).json.data.currentBalance, 70.25);
    assert.equal((await call('DELETE', `/api/transactions/${transaction.id}`)).status, 200);
    assert.equal((await call('GET', `/api/accounts/${account.id}`)).json.data.currentBalance, 0);
  });

  test('ids beyond the 32-bit category column are "not found" / invalid, never a 500', async () => {
    assertError(await call('GET', '/api/categories/99999999999'), 404, 'NOT_FOUND');
    assertError(await call('PUT', '/api/categories/99999999999', { name: 'X', type: 'income' }), 404, 'NOT_FOUND');
    assertError(await call('DELETE', '/api/categories/99999999999'), 404, 'NOT_FOUND');
    const account = await mkAccount();
    const response = await call('POST', '/api/transactions', {
      type: 'income', description: 'x', categoryId: 99999999999, accountId: account.id, amount: 1, date: '2025-01-01'
    });
    assertError(response, 400, 'VALIDATION_ERROR');
    assert.deepEqual(fieldsOf(response), ['categoryId']);
  });

  describe('a write that fails inside the database', () => {
    // A trigger makes every insert into the table fail with an unexpected error.
    const arm = table => db.query(`
      CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom-secret-detail'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER boom_trigger BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION boom();
    `);
    const disarm = table => db.query(`DROP TRIGGER IF EXISTS boom_trigger ON ${table}`);

    test('is a generic 500, saves nothing, leaks nothing, and does not use up the connection pool', async () => {
      const account = await mkAccount();
      const category = await mkCategory();
      await arm('transactions');
      const originalConsoleError = console.error;
      console.error = () => {}; // the server logs each unexpected error; keep the test output readable
      try {
        // More failures than the pool has connections (10): every one must give its connection back.
        for (let round = 0; round < 25; round += 1) {
          const response = await call('POST', '/api/transactions', {
            type: 'income', description: 'x', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01'
          });
          assertError(response, 500, 'INTERNAL_ERROR');
          assert.doesNotMatch(response.text, /boom/);
        }
        assert.equal((await db.query('SELECT COUNT(*) AS n FROM transactions')).rows[0].n, 0);
      } finally {
        console.error = originalConsoleError;
        await disarm('transactions');
      }
      const pool = db.getPool();
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount, 'every connection was given back');
      assert.equal((await call('GET', '/api/transactions')).status, 200, 'the API still works afterwards');
      assert.equal((await mkTransaction({ accountId: account.id, categoryId: category.id })).transaction.amount, 10);
    });

    test('a failing category create leaves no category behind', async () => {
      await arm('categories');
      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        assertError(await call('POST', '/api/categories', { name: 'Ghost', type: 'income' }), 500, 'INTERNAL_ERROR');
      } finally {
        console.error = originalConsoleError;
        await disarm('categories');
      }
      assert.equal((await call('GET', '/api/categories')).json.data.length, 0);
    });
  });

  test('the API recovers when PostgreSQL drops its connections', async () => {
    await mkAccount();
    // Disconnect every connection this test file's pool has open (matched by application_name).
    const originalConsoleError = console.error;
    console.error = () => {}; // the pool logs each dropped connection; keep the test output readable
    let response;
    try {
      await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${testSchema.schema}' AND pid <> pg_backend_pid()`);
      await new Promise(resolve => setTimeout(resolve, 200));
      response = await call('GET', '/api/accounts');
      if (response.status !== 200) response = await call('GET', '/api/accounts'); // at most one request may meet a dead connection
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.data.length, 1);
  });

  test('database errors are mapped to the documented API answers', () => {
    const asPlain = error => ({ status: error.status, code: error.code, message: error.message });
    assert.deepEqual(asPlain(toApiError({ code: '23505' })), { status: 409, code: 'CONFLICT', message: 'That value already exists.' });
    assert.deepEqual(asPlain(toApiError({ code: '23503' })), { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'The record is linked to other records.' });
    assert.deepEqual(asPlain(toApiError({ code: '23514' })), { status: 400, code: 'VALIDATION_ERROR', message: 'The request contains invalid data.' });
    assert.equal(toApiError({ code: '42P01', message: 'relation "x" does not exist' }), null, 'anything else stays an unexpected error');
    assert.equal(toApiError(new Error('boom')), null);
    assert.equal(errors.isUniqueViolation({ code: '23505' }), true);
  });
});

// ---------------------------------------------------------------------------
// Schema migration and persistence
// ---------------------------------------------------------------------------

describe('migration and persistence', () => {
  test('a version 1 database upgrades to the latest version and keeps its data', async () => {
    const old = await createTestSchema();
    try {
      await admin(`
        CREATE TABLE ${old.schema}.app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO ${old.schema}.app_meta (key, value) VALUES ('created_at', '2020-01-01T00:00:00Z');
        CREATE TABLE ${old.schema}.schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
        INSERT INTO ${old.schema}.schema_migrations (version) VALUES (1);
      `);

      await stopListening();
      await db.closeDatabase();
      try {
        await db.initDatabase(connectionOptions(old));
        const status = await db.getStatus();
        assert.equal(status.schemaVersion, db.LATEST_VERSION);
        assert.equal((await db.query("SELECT value FROM app_meta WHERE key = 'created_at'")).rows[0].value, '2020-01-01T00:00:00Z');
        for (const table of ['accounts', 'categories', 'transactions']) {
          assert.equal((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n, 0);
        }
      } finally {
        await db.closeDatabase();
        await db.initDatabase(connectionOptions()); // back to the normal test schema
        await listen();
      }
    } finally {
      await old.drop();
    }
  });

  test('records created through the API survive a restart of the database connection and server', async () => {
    const { transaction, account, category } = await mkTransaction({ amount: 42.42, note: 'kept' });

    await stopListening();
    await db.closeDatabase();
    await db.initDatabase(connectionOptions());
    await listen();

    assert.deepEqual((await call('GET', '/api/accounts')).json.data.map(item => item.id), [account.id]);
    assert.deepEqual((await call('GET', '/api/categories')).json.data.map(item => item.id), [category.id]);
    const again = (await call('GET', `/api/transactions/${transaction.id}`)).json.data;
    assert.equal(again.amount, 42.42);
    assert.equal(again.note, 'kept');
    assert.equal(again.category, 'Salary');
  });
});

// ---------------------------------------------------------------------------
// Earlier behaviour still works while the API is in use
// ---------------------------------------------------------------------------

describe('server regression (in the same process as the API)', () => {
  test('health reports the real schema version and database engine', async () => {
    const response = await call('GET', '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.json.data.status, 'ok');
    assert.equal(response.json.data.database.engine, 'postgresql');
    assert.equal(response.json.data.database.schemaVersion, db.LATEST_VERSION);
    assert.equal(typeof response.json.data.database.serverVersion, 'string');
  });

  test('the dashboard, a page, CSS and JS are still served', async () => {
    for (const [urlPath, type] of [
      ['/', /text\/html/],
      ['/pages/transactions.html', /text\/html/],
      ['/css/style.css', /text\/css/],
      ['/js/script.js', /text\/javascript/]
    ]) {
      const response = await call('GET', urlPath);
      assert.equal(response.status, 200, urlPath);
      assert.match(response.headers['content-type'], type);
    }
  });

  test('static files still reject traversal, hidden files and POST', async () => {
    assert.equal((await call('GET', '/../package.json')).status, 400);
    assert.equal((await call('GET', '/%2e%2e/package.json')).status, 400);
    assert.equal((await call('GET', '/.git/config')).status, 404);
    const post = await call('POST', '/index.html', { a: 1 });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
  });

  test('a POST body to a static path is drained and the connection stays usable', async () => {
    assert.equal((await call('POST', '/apixyz', { a: 1 })).status, 405, 'static paths only allow GET and HEAD');
    assert.equal((await call('GET', '/api/health')).status, 200);
  });

  test('the import and export endpoints are registered (Part 3) with the usual method rules', async () => {
    assert.equal((await call('GET', '/api/export')).status, 200);
    const wrongMethod = await call('POST', '/api/export', {});
    assertError(wrongMethod, 405, 'METHOD_NOT_ALLOWED');
    assert.match(wrongMethod.headers.allow, /GET/);
    assertError(await call('GET', '/api/import'), 405, 'METHOD_NOT_ALLOWED');
    assertError(await call('POST', '/api/import', { format: 'x' }), 400, 'CONFIRMATION_REQUIRED');
    assertError(await call('POST', '/api/import', { format: 'x', confirm: true }), 400, 'UNSUPPORTED_FORMAT');
    assertError(await call('POST', '/api/import/preview', { format: 'x' }), 400, 'UNSUPPORTED_FORMAT');
  });

});

// ---------------------------------------------------------------------------
// Database failure while the server is running (keep this block LAST: it
// closes the connection pool on purpose and then reopens a fresh one)
// ---------------------------------------------------------------------------

describe('database failure at runtime', () => {
  test('API calls return a generic 500 without internals, and health honestly reports 503', async () => {
    await db.closeDatabase();
    try {
      const response = await call('GET', '/api/accounts');
      assertError(response, 500, 'INTERNAL_ERROR');
      assert.equal(response.json.error.message, 'Something went wrong on the server.');
      assert.equal(response.json.error.details, undefined);

      const health = await call('GET', '/api/health');
      assert.equal(health.status, 503);
      assert.equal(health.json.ok, false);
      assert.equal(health.json.data.database.ready, false);
      assert.equal(health.json.error.code, 'DATABASE_NOT_READY');
    } finally {
      await db.initDatabase(connectionOptions());
    }
    assert.equal((await call('GET', '/api/accounts')).status, 200, 'server recovers once the database is back');
  });
});
