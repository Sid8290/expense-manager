'use strict';

// Automated checks for the Stage 3 frontend/API integration. Run with:  npm test
//
// No browser is needed here. Three kinds of checks:
//   1. The API client (frontend/js/api.js) against the REAL server, in this
//      process, with a throw-away PostgreSQL schema (TEST_DATABASE_URL).
//   2. The REAL frontend/js/script.js loaded into a stubbed browser environment
//      (Node's `vm`), to test its data layer, legacy-data detection and form
//      guard without a DOM.
//   3. Source guards: rules that must never be broken by a later edit.
// Page-level behaviour in a real browser is covered by the optional
// backend/test/browser-check.js (see the README).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const db = require('../db');
const { createServer } = require('../server');
const { TEST_URL, createTestSchema } = require('./helpers/pg-test-db');
const { createClient, ApiError } = require('../../frontend/js/api.js');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const API_JS = fs.readFileSync(path.join(FRONTEND, 'js', 'api.js'), 'utf8');
const SCRIPT_JS = fs.readFileSync(path.join(FRONTEND, 'js', 'script.js'), 'utf8');

const PAGES = {
  'index.html': './js/',
  'pages/transactions.html': '../js/',
  'pages/accounts.html': '../js/',
  'pages/categories.html': '../js/',
  'pages/analytics.html': '../js/',
  'pages/settings.html': '../js/'
};

const plain = value => JSON.parse(JSON.stringify(value)); // drops the vm realm so deepEqual works

// ---------------------------------------------------------------------------
// Real server + temporary database for the client tests
// ---------------------------------------------------------------------------

let testSchema;
let server;
let origin;
let client;

before(async () => {
  testSchema = await createTestSchema();
  await db.initDatabase({ connectionString: TEST_URL, schema: testSchema.schema });
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  client = createClient((url, options) => fetch(url, options), origin);
});

after(async () => {
  await new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });
  await db.closeDatabase();
  await testSchema.drop();
});

beforeEach(async () => {
  await db.query('DELETE FROM transactions; DELETE FROM categories; DELETE FROM accounts;');
});

async function seed() {
  const account = await client.createAccount({ name: 'Cash', type: 'cash', balance: 100 });
  const category = await client.createCategory({ name: 'Food', type: 'expense' });
  return { account, category };
}

// A fake fetch that returns a canned response (or throws), and records the call.
function stubFetch(responder) {
  const calls = [];
  const fetchStub = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  fetchStub.calls = calls;
  return fetchStub;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------------
// 1. API client
// ---------------------------------------------------------------------------

describe('api client against the real server', () => {
  test('lists are empty on a fresh database', async () => {
    assert.deepEqual(await client.listAccounts(), []);
    assert.deepEqual(await client.listCategories(), []);
    assert.deepEqual(await client.listTransactions(), []);
  });

  test('create and list accounts, categories and transactions return the real API shapes', async () => {
    const { account, category } = await seed();
    assert.match(account.id, /^acc-/);
    assert.equal(account.balance, 100);
    assert.equal(typeof category.id, 'number');

    const created = await client.createTransaction({
      type: 'expense', description: 'Milk', categoryId: category.id, accountId: account.id, amount: 45.5, note: '', date: '2025-03-04'
    });
    assert.equal(created.category, 'Food');
    assert.equal(created.categoryId, category.id);

    assert.deepEqual(await client.listTransactions(), [created]);
    assert.equal((await client.listAccounts())[0].currentBalance, 54.5);
  });

  test('delete removes records', async () => {
    const { account, category } = await seed();
    const txn = await client.createTransaction({ type: 'expense', description: 'x', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01' });
    await client.deleteTransaction(txn.id);
    await client.deleteCategory(category.id);
    await client.deleteAccount(account.id);
    assert.deepEqual(await client.listAccounts(), []);
    assert.deepEqual(await client.listCategories(), []);
  });

  test('validation errors become readable messages with field labels', async () => {
    const { account, category } = await seed();
    await assert.rejects(
      client.createTransaction({ type: 'expense', description: 'x', categoryId: category.id, accountId: account.id, amount: 1.234, date: '2025-01-01' }),
      error => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, 'request');
        assert.equal(error.status, 400);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.message, 'Amount: Must have at most 2 decimal places.');
        return true;
      }
    );
  });

  test('several validation problems are joined into one message', async () => {
    await assert.rejects(client.createAccount({}), error => {
      assert.match(error.message, /Name: This field is required\./);
      assert.match(error.message, /Balance: This field is required\./);
      return true;
    });
  });

  test('listTransactions(filters) and getSummary(filters) send the filters and leave empty ones out', async () => {
    const { account, category } = await seed();
    await client.createTransaction({ type: 'expense', description: 'Tea', categoryId: category.id, accountId: account.id, amount: 2.5, date: '2025-01-01' });
    await client.createTransaction({ type: 'expense', description: 'Milk', categoryId: category.id, accountId: account.id, amount: 1.5, date: '2025-01-02' });

    assert.equal((await client.listTransactions({ search: 'tea', type: '', category: '', accountId: '' })).length, 1);
    assert.equal((await client.listTransactions({ accountId: account.id, from: '2025-01-02' })).length, 1);
    assert.equal((await client.listTransactions({})).length, 2);
    assert.equal((await client.listTransactions(undefined)).length, 2);

    const data = await client.getSummary({ type: 'expense', search: 'milk' });
    assert.deepEqual(plain(data.totals), { count: 1, income: 0, expense: 1.5, balance: -1.5 });
    assert.equal((await client.getSummary()).totals.count, 2);

    await assert.rejects(client.listTransactions({ from: '2025-02-30' }), error => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /^From: /, 'the field is shown with a friendly label');
      return true;
    });
  });

  test('"in use" and "duplicate" conflicts keep the server message and status 409', async () => {
    const { account, category } = await seed();
    await client.createTransaction({ type: 'expense', description: 'x', categoryId: category.id, accountId: account.id, amount: 1, date: '2025-01-01' });
    await assert.rejects(client.deleteAccount(account.id), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'IN_USE');
      assert.match(error.message, /is used by 1 transaction and cannot be deleted/);
      return true;
    });
    await assert.rejects(client.createCategory({ name: 'FOOD', type: 'expense' }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'CONFLICT');
      return true;
    });
  });

  test('a missing record is a 404 ApiError', async () => {
    await assert.rejects(client.deleteTransaction('txn-nope'), error => error.status === 404 && error.code === 'NOT_FOUND');
  });

  test('ids are URL-encoded', async () => {
    const stub = stubFetch(() => jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'No such record.' } }));
    const encoded = createClient(stub, '');
    await assert.rejects(encoded.deleteTransaction('a b/c'));
    assert.equal(stub.calls[0].url, '/api/transactions/a%20b%2Fc');
  });

  test('requests use relative /api paths, JSON headers and only send a body when given one', async () => {
    const stub = stubFetch(() => jsonResponse(200, { ok: true, data: [] }));
    const relative = createClient(stub);
    await relative.listAccounts();
    await relative.createAccount({ name: 'A', type: 'cash', balance: 0 });
    assert.equal(stub.calls[0].url, '/api/accounts');
    assert.equal(stub.calls[0].options.method, 'GET');
    assert.equal(stub.calls[0].options.body, undefined);
    assert.equal(stub.calls[0].options.headers['Content-Type'], undefined);
    assert.equal(stub.calls[1].options.method, 'POST');
    assert.equal(stub.calls[1].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(stub.calls[1].options.body), { name: 'A', type: 'cash', balance: 0 });
  });

  test('an unreachable server is a network error with advice, not a raw exception', async () => {
    const failing = createClient(stubFetch(() => { throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:1'); }));
    await assert.rejects(failing.listAccounts(), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'network');
      assert.match(error.message, /Cannot reach the server/);
      assert.doesNotMatch(error.message, /ECONNREFUSED|127\.0\.0\.1/);
      return true;
    });
  });

  test('a real connection refusal (nothing is listening) is handled the same way', async () => {
    const closed = await new Promise(resolve => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const refused = createClient((url, options) => fetch(url, options), `http://127.0.0.1:${closed}`);
    await assert.rejects(refused.listAccounts(), error => error.kind === 'network' && /Cannot reach the server/.test(error.message));
  });

  test('server errors never show server text (stack traces, SQL, paths)', async () => {
    const leaky = createClient(stubFetch(() => jsonResponse(500, {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'SQLITE_ERROR: no such table at C:\\app\\backend\\db.js:12' }
    })));
    await assert.rejects(leaky.listTransactions(), error => {
      assert.equal(error.kind, 'server');
      assert.equal(error.message, 'The server had a problem. Please try again.');
      return true;
    });
  });

  test('503 (database not ready) gets its own plain message', async () => {
    const unavailable = createClient(stubFetch(() => jsonResponse(503, { ok: false, error: { code: 'DATABASE_NOT_READY', message: 'x' } })));
    await assert.rejects(unavailable.health(), error => error.status === 503 && /database is not available/.test(error.message));
  });

  test('a non-JSON response (for example an HTML error page) is handled', async () => {
    const html = createClient(stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })));
    await assert.rejects(html.listAccounts(), error => error.kind === 'server' && !/html/i.test(error.message));
    const notFound = createClient(stubFetch(() => new Response('404 Not Found', { status: 404 })));
    await assert.rejects(notFound.listAccounts(), error => error.status === 404 && /Unexpected response/.test(error.message));
  });

  test('a 200 response that is not the {ok:true} envelope is rejected, not trusted', async () => {
    const odd = createClient(stubFetch(() => jsonResponse(200, { hello: 'world' })));
    await assert.rejects(odd.listAccounts(), error => error instanceof ApiError);
  });
});

// ---------------------------------------------------------------------------
// 2. script.js in a stubbed browser environment
// ---------------------------------------------------------------------------

// Loads the real api.js and script.js into a fresh sandbox. `local` is the
// initial localStorage content. Every write/remove is recorded.
function loadFrontend({ local = {}, page = 'dashboard' } = {}) {
  const storage = new Map(Object.entries(local));
  const writes = [];
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { writes.push(['set', key]); storage.set(key, String(value)); },
    removeItem: key => { writes.push(['remove', key]); storage.delete(key); },
    clear: () => { writes.push(['clear']); storage.clear(); }
  };
  const classes = new Set();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    localStorage,
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { protocol: 'http:', search: '' },
    document: {
      documentElement: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) }, setAttribute() {} },
      body: { dataset: { page } },
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    fetch: () => { throw new Error('fetch must not be called by script.js directly'); }
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.createContext(sandbox);
  vm.runInContext(API_JS, sandbox, { filename: 'api.js' });
  vm.runInContext(SCRIPT_JS, sandbox, { filename: 'script.js' });
  return {
    sandbox,
    writes,
    storage,
    classes,
    run: code => vm.runInContext(code, sandbox)
  };
}

describe('script.js data layer (stubbed browser)', () => {
  test('loading the script writes nothing to localStorage and hides content until data arrives', () => {
    const app = loadFrontend({ local: { em_transactions: '[{"x":1}]' } });
    assert.deepEqual(app.writes, [], 'no writes, no removals');
    assert.equal(app.classes.has('data-pending'), true);
  });

  test('the data getters come from the store, not from localStorage', () => {
    const app = loadFrontend({
      local: {
        em_transactions: JSON.stringify([{ id: 't', type: 'expense', description: 'old', category: 'c', accountId: 'a', amount: 1, date: '2025-01-01' }]),
        em_accounts: JSON.stringify([{ id: 'acc-old', name: 'Old', type: 'cash', balance: 5 }]),
        em_categories: JSON.stringify([{ name: 'Old', type: 'expense' }])
      }
    });
    assert.deepEqual(plain(app.run('[getTransactions(), getAccounts(), getCategories()]')), [[], [], []]);
    assert.deepEqual(app.writes, []);
  });

  test('with nothing stored, reading the data does not create default records in localStorage', () => {
    const app = loadFrontend();
    app.run('getTransactions(); getAccounts(); getCategories(); getMoneyAccounts(); getTotalBalance();');
    assert.equal(app.storage.has('em_accounts'), false);
    assert.equal(app.storage.has('em_categories'), false);
    assert.equal(app.storage.has('em_transactions'), false);
    assert.deepEqual(app.writes, []);
  });

  test('loadFinancialData fills only the requested lists', async () => {
    const app = loadFrontend();
    app.sandbox.Api = {
      listAccounts: async () => [{ id: 'a1', name: 'Cash', type: 'cash', balance: 1 }],
      listCategories: async () => { throw new Error('must not be requested'); },
      listTransactions: async () => []
    };
    await app.run("loadFinancialData(['accounts', 'transactions'])");
    assert.equal(plain(app.run('getAccounts()'))[0].id, 'a1');
    assert.deepEqual(plain(app.run('getCategories()')), []);
  });

  test('if one request fails, the store is left exactly as it was', async () => {
    const app = loadFrontend();
    app.sandbox.Api = {
      listAccounts: async () => [{ id: 'new', name: 'N', type: 'cash', balance: 0 }],
      listCategories: async () => [],
      listTransactions: async () => { throw new Error('boom'); }
    };
    app.run("store.accounts = [{ id: 'kept', name: 'Kept', type: 'cash', balance: 0 }]");
    await assert.rejects(app.run("loadFinancialData(['accounts', 'transactions'])"));
    assert.equal(plain(app.run('getAccounts()'))[0].id, 'kept');
  });

  test('each page asks for only the lists it needs', () => {
    const app = loadFrontend();
    assert.deepEqual(plain(app.run('PAGE_DATA')), {
      dashboard: ['accounts', 'transactions'],
      transactions: ['accounts', 'categories', 'transactions'],
      accounts: ['accounts', 'transactions'],
      categories: ['categories', 'transactions'],
      analytics: ['transactions'],
      settings: ['accounts', 'categories', 'transactions']
    });
  });

  test('account balances and totals computed by the page equal the API\'s currentBalance (one set of numbers)', async () => {
    const app = loadFrontend();
    const bank = await client.createAccount({ name: 'Bank', type: 'bank', balance: 0.1 });
    const wallet = await client.createAccount({ name: 'Wallet', type: 'cash', balance: 100 });
    const income = await client.createCategory({ name: 'Pay', type: 'income' });
    const food = await client.createCategory({ name: 'Food', type: 'expense' });
    const add = (type, categoryId, accountId, amount) =>
      client.createTransaction({ type, description: 'd', categoryId, accountId, amount, date: '2025-02-01' });
    await add('income', income.id, bank.id, 0.2);
    await add('expense', food.id, bank.id, 0.1);
    await add('expense', food.id, bank.id, 19.99);
    await add('income', income.id, wallet.id, 1234.56);
    await add('expense', food.id, wallet.id, 0.07);

    const [accounts, transactions] = [await client.listAccounts(), await client.listTransactions()];
    app.sandbox.__data = { accounts, transactions };
    app.run('store.accounts = __data.accounts; store.transactions = __data.transactions;');

    for (const account of accounts) {
      app.sandbox.__id = account.id;
      assert.equal(app.run('getAccountBalance(getAccounts().find(a => a.id === __id), getTransactions())'), account.currentBalance, account.name);
    }
    const expectedTotal = Math.round(accounts.reduce((sum, account) => sum + account.currentBalance, 0) * 100) / 100;
    assert.equal(app.run('getTotalBalance()'), expectedTotal);
    assert.deepEqual(plain(app.run('getTotals(getTransactions())')), { income: 1234.76, expense: 20.16, balance: 1214.6 });
  });

  test('the page can group transactions by the category NAME the API returns', async () => {
    const app = loadFrontend();
    const { account, category } = await seed();
    await client.createTransaction({ type: 'expense', description: 'a', categoryId: category.id, accountId: account.id, amount: 10, date: '2025-01-01' });
    await client.createTransaction({ type: 'expense', description: 'b', categoryId: category.id, accountId: account.id, amount: 5.5, date: '2025-01-02' });
    app.sandbox.__data = await client.listTransactions();
    app.run('store.transactions = __data');
    assert.deepEqual(plain(app.run("getCategoryTotals(getTransactions(), 'expense')")), [{ name: 'Food', total: 15.5, count: 2 }]);
  });

  test('error helpers: user-safe text, "gone" and "stale data" detection', () => {
    const app = loadFrontend();
    const fromApi = status => app.run(`new ApiError({ kind: 'request', status: ${status}, message: 'Server said no.' })`);

    assert.equal(app.run("errorText(new ApiError({ kind: 'request', status: 409, message: 'Used.' }))"), 'Used.');
    const quiet = app.sandbox.console;
    app.sandbox.console = { error() {} }; // the next call logs on purpose
    assert.equal(app.run("errorText(new TypeError('x is not a function at script.js:99'))"), 'Something went wrong. Please try again.');
    app.sandbox.console = quiet;

    assert.equal(app.sandbox.isGone(fromApi(404)), true);
    assert.equal(app.sandbox.isGone(fromApi(409)), false);
    assert.equal(app.sandbox.needsResync(fromApi(404)), true);
    assert.equal(app.sandbox.needsResync(fromApi(409)), true);
    assert.equal(app.sandbox.needsResync(fromApi(400)), false, 'plain validation errors do not trigger a reload');
    assert.equal(
      app.run("needsResync(new ApiError({ kind: 'request', status: 400, message: 'm', details: [{ field: 'categoryId', message: 'No category with this id.' }] }))"),
      true,
      'a reference to a deleted category/account does'
    );
  });
});

describe('script.js form guard', () => {
  function fakeForm() {
    const buttons = [{ disabled: false }];
    return { buttons, dataset: {}, querySelectorAll: () => buttons };
  }

  test('a second submit while the first is running is ignored; buttons are disabled meanwhile', async () => {
    const app = loadFrontend();
    const form = fakeForm();
    let runs = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    app.sandbox.__form = form;
    app.sandbox.__task = async () => { runs += 1; await gate; };

    const first = app.run('submitWithBusy(__form, __task)');
    const second = app.run('submitWithBusy(__form, __task)');
    const third = app.run('submitWithBusy(__form, __task)');
    assert.equal(form.buttons[0].disabled, true, 'disabled while busy');
    release();
    await Promise.all([first, second, third]);

    assert.equal(runs, 1, 'the task ran once');
    assert.equal(form.buttons[0].disabled, false, 're-enabled afterwards');
    assert.equal(form.dataset.busy, undefined);
  });

  test('buttons are re-enabled and the form can be used again even if the task throws', async () => {
    const app = loadFrontend();
    const form = fakeForm();
    app.sandbox.__form = form;
    app.sandbox.__task = async () => { throw new Error('boom'); };
    await assert.rejects(app.run('submitWithBusy(__form, __task)'), /boom/);
    assert.equal(form.buttons[0].disabled, false);
    assert.equal(form.dataset.busy, undefined);
  });
});

describe('legacy browser data detection (read-only)', () => {
  const defaults = {
    em_accounts: JSON.stringify([
      { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
      { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 }
    ]),
    em_categories: JSON.stringify([{ name: 'Groceries', type: 'expense' }, { name: 'Salary', type: 'income' }, { name: 'Other Income', type: 'income' }])
  };
  const txn = (id, extra = {}) => ({ id, type: 'expense', description: 'd', category: 'Groceries', accountId: 'acc-cash', amount: 1, note: '', date: '2025-01-01', createdAt: 1, ...extra });

  test('nothing stored -> nothing reported', () => {
    assert.deepEqual(plain(loadFrontend().run('getLegacyFinancialSummary()')), { transactions: 0, accounts: 0, categories: 0 });
  });

  test('untouched defaults written by the old version are not reported as user data', () => {
    const app = loadFrontend({ local: defaults });
    assert.deepEqual(plain(app.run('getLegacyFinancialSummary()')), { transactions: 0, accounts: 0, categories: 0 });
  });

  test('transactions, custom accounts and custom categories are counted', () => {
    const app = loadFrontend({
      local: {
        em_transactions: JSON.stringify([txn('t1'), txn('t2'), { broken: true }]),
        em_accounts: JSON.stringify([
          { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
          { id: 'acc-1', name: 'Savings', type: 'bank', balance: 10 },
          { id: 'acc-cash2', name: 'Cash', type: 'cash', balance: 50 }
        ]),
        em_categories: JSON.stringify([{ name: 'Groceries', type: 'expense' }, { name: 'Hobbies', type: 'expense' }, { name: 'Groceries', type: 'income' }])
      }
    });
    assert.deepEqual(plain(app.run('getLegacyFinancialSummary()')), { transactions: 2, accounts: 2, categories: 2 });
  });

  test('garbage in localStorage does not throw', () => {
    const app = loadFrontend({ local: { em_transactions: '{not json', em_accounts: '"text"', em_categories: '42' } });
    assert.deepEqual(plain(app.run('getLegacyFinancialSummary()')), { transactions: 0, accounts: 0, categories: 0 });
  });

  test('detection only reads: no writes, no removals, values unchanged', () => {
    const local = { em_transactions: JSON.stringify([txn('t1')]), em_accounts: defaults.em_accounts, em_categories: defaults.em_categories };
    const app = loadFrontend({ local });
    app.run('getLegacyFinancialSummary(); getLegacyFinancialSummary();');
    assert.deepEqual(app.writes, []);
    for (const [key, value] of Object.entries(local)) assert.equal(app.storage.get(key), value, key);
  });

  test('"reset" is limited to settings, bills and to-dos', () => {
    const app = loadFrontend();
    assert.deepEqual(plain(app.run('LOCAL_ONLY_KEYS')), ['em_settings', 'em_bills', 'em_todos']);
  });
});

// ---------------------------------------------------------------------------
// 3. Source guards
// ---------------------------------------------------------------------------

describe('source guards', () => {
  test('every page loads api.js, then script.js, from a path that exists', () => {
    for (const [file, prefix] of Object.entries(PAGES)) {
      const html = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
      const apiAt = html.indexOf(`<script src="${prefix}api.js"></script>`);
      const scriptAt = html.indexOf(`<script src="${prefix}script.js"></script>`);
      assert.ok(apiAt > -1, `${file} loads api.js`);
      assert.ok(scriptAt > apiAt, `${file} loads api.js before script.js`);
      assert.ok(fs.existsSync(path.join(FRONTEND, 'js', 'api.js')));
    }
  });

  test('script.js never clears localStorage or touches the old financial keys', () => {
    assert.doesNotMatch(SCRIPT_JS, /localStorage\.clear/);
    assert.doesNotMatch(SCRIPT_JS, /writeStorage\(\s*STORAGE_KEYS\.(transactions|accounts|categories)/);
    assert.doesNotMatch(SCRIPT_JS, /loadList\(\s*STORAGE_KEYS\.(transactions|accounts|categories)/);
    assert.doesNotMatch(SCRIPT_JS, /localStorage\.setItem\([^)]*(transactions|accounts|categories)/);
    const removals = SCRIPT_JS.match(/\blocalStorage\.removeItem\(/g) || [];
    assert.equal(removals.length, 1, 'only the reset button removes anything from localStorage');
    assert.match(SCRIPT_JS, /LOCAL_ONLY_KEYS\.forEach\(key => localStorage\.removeItem\(key\)\)/);
  });

  test('all network access goes through api.js', () => {
    assert.doesNotMatch(SCRIPT_JS, /\bfetch\s*\(/);
    assert.doesNotMatch(SCRIPT_JS, /XMLHttpRequest/);
    assert.doesNotMatch(SCRIPT_JS, /['"`]\/api\//);
    // The only address allowed in api.js is the one in the "open it through the
    // server" hint shown when the page is opened as a file. It is text, not a request URL.
    const withoutHint = API_JS.replace('visit http://127.0.0.1:3000', '');
    assert.doesNotMatch(withoutHint, /https?:\/\/|localhost|127\.0\.0\.1/, 'no hard-coded host');
  });

  test('the server serves api.js as JavaScript', async () => {
    const response = await fetch(`${origin}/js/api.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
    assert.equal(await response.text(), API_JS);
  });
});

// ---------------------------------------------------------------------------
// Part 4: reading the old browser data, the backup document, import client calls
// ---------------------------------------------------------------------------

describe('legacy backup and review (read-only)', () => {
  const txn = { id: 'txn-1', type: 'expense', description: 'Tea', category: 'Food', accountId: 'acc-cash', amount: 5, date: '2025-01-01', extra: 'keep me' };
  const raw = JSON.stringify([txn, { broken: true }]);

  test('the backup keeps every stored entry verbatim, including malformed ones and unknown fields', () => {
    const app = loadFrontend({ local: { em_transactions: raw } });
    const backup = plain(app.run('buildLegacyBackup()'));
    assert.equal(backup.format, 'expense-manager-legacy-backup');
    assert.equal(backup.version, 1);
    assert.ok(!Number.isNaN(Date.parse(backup.exportedAt)));
    assert.equal(backup.complete, true);
    assert.deepEqual(backup.data.transactions, [txn, { broken: true }]);
    assert.deepEqual(backup.data.accounts, []);
    assert.deepEqual(app.writes, [], 'building a backup writes nothing');
  });

  test('unreadable values are reported and their raw text is kept, not treated as empty', () => {
    const app = loadFrontend({ local: { em_transactions: '{not json', em_accounts: '{"a":1}' } });
    const backup = plain(app.run('buildLegacyBackup()'));
    assert.equal(backup.complete, false);
    assert.deepEqual(backup.problems.map(p => p.kind).sort(), ['not-a-list', 'unreadable']);
    assert.equal(backup.unreadable.em_transactions, '{not json');
    assert.equal(backup.unreadable.em_accounts, '{"a":1}');
  });

  test('an inaccessible storage key is reported as such', () => {
    const app = loadFrontend({ local: {} });
    app.sandbox.localStorage.getItem = () => { throw new Error('blocked'); };
    const backup = plain(app.run('buildLegacyBackup()'));
    assert.equal(backup.complete, false);
    assert.ok(backup.problems.every(p => p.kind === 'inaccessible'));
  });

  test('the review separates user records, old defaults and malformed entries', () => {
    const app = loadFrontend({
      local: {
        em_transactions: raw,
        em_accounts: JSON.stringify([{ id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 }, { id: 'acc-9', name: 'Mine', type: 'bank', balance: 10 }])
      }
    });
    const review = plain(app.run('reviewLegacyData()'));
    assert.deepEqual(review.entities.transactions, { stored: 2, malformed: 1, defaults: 0, userRecords: 1 });
    assert.equal(review.entities.accounts.stored, 2);
    assert.equal(review.entities.accounts.userRecords, 1);
    assert.equal(review.entities.accounts.defaults, 1);
    assert.deepEqual(app.writes, []);
  });

  test('the api client has preview, import (always confirm:true) and export calls', async () => {
    const seen = [];
    const client = createClient(stubFetch((url, options) => {
      seen.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return jsonResponse(200, { ok: true, data: {} });
    }));
    await client.previewImport({ format: 'x', version: 1, data: {} });
    await client.importLegacy({ format: 'x', version: 1, data: {} });
    await client.exportDatabase();
    assert.match(seen[0].url, /\/api\/import\/preview$/);
    assert.equal(seen[0].body.confirm, undefined, 'preview never sends confirm');
    assert.match(seen[1].url, /\/api\/import$/);
    assert.equal(seen[1].body.confirm, true);
    assert.equal(seen[2].method, 'GET');
  });

  test('a failed import shows the safe "nothing was saved" message, other 500s stay generic', async () => {
    const failed = createClient(stubFetch(() => jsonResponse(500, { ok: false, error: { code: 'IMPORT_FAILED', message: 'The import failed. Nothing was saved.' } })));
    await assert.rejects(failed.importLegacy({}), error => /Nothing was saved/.test(error.message));
  });
});
