'use strict';

// Automated checks for Part 4: server-side transaction filtering
// (GET /api/transactions?...) and the financial summary (GET /api/summary).
// Run with:  npm run test:filters   (or npm test)
//
// Like the other API tests, this runs the real HTTP server in the test process
// against a throw-away PostgreSQL schema inside TEST_DATABASE_URL.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const db = require('../db');
const { createServer } = require('../server');
const { TEST_URL, createTestSchema } = require('./helpers/pg-test-db');

let testSchema;
let server;
let port;

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, res => {
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

const qs = params => '?' + new URLSearchParams(params).toString();
const list = async params => {
  const response = await call('GET', '/api/transactions' + (params ? qs(params) : ''));
  assert.equal(response.status, 200, response.text);
  return response.json.data;
};
const summary = async params => {
  const response = await call('GET', '/api/summary' + (params ? qs(params) : ''));
  assert.equal(response.status, 200, response.text);
  return response.json.data;
};
const ids = rows => rows.map(row => row.id);

function assertError(response, status, code, field) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, code, response.text);
  assert.doesNotMatch(response.text, /node_modules|\.js:\d|\bat .*\(|em_test_|postgres|SQLSTATE|violates|pg_|syntax error/i, 'nothing internal leaked');
  if (field) assert.ok(response.json.error.details.some(d => d.field === field), `details mention ${field}: ${response.text}`);
}

// ---------------------------------------------------------------------------
// Test data (fixed dates in the past, so they are always allowed)
// ---------------------------------------------------------------------------

let cat = {}; // name -> id ("Other expense", "Other income" for the shared name)

before(async () => {
  testSchema = await createTestSchema();
  await db.initDatabase({ connectionString: TEST_URL, schema: testSchema.schema });
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  const post = async (url, body) => {
    const response = await call('POST', url, body);
    assert.equal(response.status, 201, response.text);
    return response.json.data;
  };
  await post('/api/accounts', { id: 'cash', name: 'Pocket Cash', type: 'cash', balance: 100 });
  await post('/api/accounts', { id: 'bank', name: 'Main Bank', type: 'bank', balance: 500 });
  await post('/api/accounts', { id: 'fixed', name: 'Gold', type: 'asset', balance: 0 });

  for (const [name, type, key] of [
    ['Food', 'expense', 'Food'], ['Rent', 'expense', 'Rent'], ['Salary', 'income', 'Salary'],
    ['Other', 'expense', 'Other expense'], ['Other', 'income', 'Other income']
  ]) {
    cat[key] = (await post('/api/categories', { name, type })).id;
  }

  const tx = (id, type, description, category, accountId, amount, date, note = '', createdAt) =>
    post('/api/transactions', { id, type, description, categoryId: cat[category], accountId, amount, date, note, createdAt });

  await tx('t01', 'expense', 'Tea and biscuits', 'Food', 'cash', 12.5, '2025-01-05', 'morning', 1001);
  await tx('t02', 'expense', 'Milk', 'Food', 'cash', 0.1, '2025-01-05', '', 1002);
  await tx('t03', 'expense', 'Bread', 'Food', 'bank', 0.2, '2025-01-31', 'from the bakery', 1003);
  await tx('t04', 'expense', 'January rent', 'Rent', 'bank', 300, '2025-01-31', '', 1004);
  await tx('t05', 'income', 'January salary', 'Salary', 'bank', 2000, '2025-02-01', '', 1005);
  await tx('t06', 'expense', 'Gift 100% real_deal', 'Other expense', 'cash', 40, '2025-02-14', 'percent % and under_score', 1006);
  await tx('t07', 'income', 'Refund', 'Other income', 'cash', 15.75, '2025-02-28', '', 1007);
  await tx('t08', 'expense', 'February rent', 'Rent', 'bank', 300, '2025-03-01', '', 1008);
  await tx('t09', 'income', 'March salary', 'Salary', 'bank', 2000, '2025-03-31', 'bonus included', 1009);
  await tx('t10', 'expense', 'Café au lait', 'Food', 'cash', 3, '2025-03-31', 'ÉCLAIR', 1010);
});

after(async () => {
  await new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await db.closeDatabase();
  await testSchema.drop();
});

// The rules the frontend used to apply in the browser (getFilteredTransactions),
// written independently in JavaScript. The server must agree with them.
function expectedBrowserFilter(all, { type, category, accountId, search, from, to }) {
  const accounts = new Map([['cash', 'Pocket Cash'], ['bank', 'Main Bank'], ['fixed', 'Gold']]);
  const needle = (search || '').trim().toLowerCase();
  return all.filter(item => {
    if (type && item.type !== type) return false;
    if (category && item.category !== category) return false;
    if (accountId && item.accountId !== accountId) return false;
    if (from && item.date < from) return false;
    if (to && item.date > to) return false;
    if (needle) {
      const text = [item.description, item.category, item.note || '', accounts.get(item.accountId), String(item.amount)].join(' ').toLowerCase();
      return text.includes(needle);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('GET /api/transactions filters', () => {
  test('without a query string it returns the complete list in the usual order (unchanged contract)', async () => {
    const all = await list();
    assert.equal(all.length, 10);
    assert.deepEqual(ids(all), ['t10', 't09', 't08', 't07', 't06', 't05', 't04', 't03', 't02', 't01'],
      'newest date first, then newest createdAt');
    assert.deepEqual(Object.keys(all[0]).sort(), ['accountId', 'amount', 'category', 'categoryId', 'createdAt', 'date', 'description', 'id', 'note', 'type']);
    assert.deepEqual(await list({}), all);
    assert.deepEqual(await list({ type: '', search: '', from: '' }), all, 'empty values count as absent');
  });

  test('type', async () => {
    assert.deepEqual(ids(await list({ type: 'income' })), ['t09', 't07', 't05']);
    assert.equal((await list({ type: 'expense' })).length, 7);
  });

  test('account', async () => {
    assert.deepEqual(ids(await list({ accountId: 'bank' })), ['t09', 't08', 't05', 't04', 't03']);
    assert.deepEqual(await list({ accountId: 'fixed' }), []);
    assert.deepEqual(await list({ accountId: 'nobody' }), [], 'an unknown account is an empty result, not an error');
  });

  test('category by id and by name (a shared name matches both types, like the old dropdown)', async () => {
    assert.deepEqual(ids(await list({ categoryId: cat.Rent })), ['t08', 't04']);
    assert.deepEqual(ids(await list({ category: 'Rent' })), ['t08', 't04']);
    assert.deepEqual(ids(await list({ category: 'Other' })), ['t07', 't06']);
    assert.deepEqual(ids(await list({ categoryId: cat['Other income'] })), ['t07']);
    assert.deepEqual(await list({ category: 'rent' }), [], 'names match exactly, as in the dropdown');
    assert.deepEqual(await list({ categoryId: '999999' }), []);
  });

  test('date range is inclusive at both ends, and works with only one end', async () => {
    assert.deepEqual(ids(await list({ from: '2025-01-31', to: '2025-02-01' })), ['t05', 't04', 't03']);
    assert.deepEqual(ids(await list({ from: '2025-03-31' })), ['t10', 't09']);
    assert.deepEqual(ids(await list({ to: '2025-01-05' })), ['t02', 't01']);
    assert.deepEqual(ids(await list({ from: '2025-02-14', to: '2025-02-14' })), ['t06'], 'a single day');
    assert.deepEqual(await list({ from: '2030-01-01' }), [], 'a future range is allowed and empty');
  });

  test('search ignores case and looks at description, category, note, account name and amount', async () => {
    assert.deepEqual(ids(await list({ search: 'TEA' })), ['t01']);
    assert.deepEqual(ids(await list({ search: 'bakery' })), ['t03'], 'note');
    assert.deepEqual(ids(await list({ search: 'main bank' })).length, 5, 'account name');
    assert.deepEqual(ids(await list({ search: 'salary' })), ['t09', 't05'], 'category and description');
    assert.deepEqual(ids(await list({ search: '12.5' })), ['t01'], 'amount, written like JavaScript writes it');
    assert.deepEqual(ids(await list({ search: '2000' })), ['t09', 't05']);
    assert.deepEqual(ids(await list({ search: '  milk  ' })), ['t02'], 'trimmed');
    assert.deepEqual(ids(await list({ search: 'biscuits food' })), ['t01'], 'words can span fields (description then category), as before');
    assert.deepEqual(ids(await list({ search: 'café' })), ['t10']);
    assert.deepEqual(ids(await list({ search: 'éclair' })), ['t10'], 'non-ASCII case folding');
    assert.deepEqual(await list({ search: 'no such thing' }), []);
  });

  test('% and _ in the search text are ordinary characters, not wildcards', async () => {
    assert.deepEqual(ids(await list({ search: '100%' })), ['t06']);
    assert.deepEqual(ids(await list({ search: 'real_deal' })), ['t06']);
    assert.deepEqual(await list({ search: '%' }).then(ids), ['t06'], 'only the one row that contains a percent sign');
    assert.deepEqual(await list({ search: 'real%deal' }), [], '% does not mean "anything"');
    assert.deepEqual(await list({ search: 'real_deaL' }).then(ids), ['t06'], 'only case is ignored');
    assert.deepEqual(await list({ search: 'r_al' }), [], '_ does not mean "any one character"');
  });

  test('filters combine with AND', async () => {
    assert.deepEqual(ids(await list({ type: 'expense', accountId: 'bank', from: '2025-01-31', to: '2025-03-01' })), ['t08', 't04', 't03']);
    assert.deepEqual(ids(await list({ type: 'expense', category: 'Food', accountId: 'cash', search: 'milk' })), ['t02']);
    assert.deepEqual(await list({ type: 'income', category: 'Rent' }), []);
  });

  test('the server gives exactly the answers the browser code used to give (many combinations)', async () => {
    const all = await list();
    const combos = [
      {}, { type: 'expense' }, { category: 'Other' }, { accountId: 'cash' }, { search: 'a' }, { search: 'e' },
      { search: '0' }, { type: 'income', search: 'sal' }, { accountId: 'bank', search: 'rent' },
      { from: '2025-02-01', to: '2025-03-01' }, { type: 'expense', accountId: 'cash', from: '2025-01-05', to: '2025-02-14' },
      { search: 'MAIN' }, { search: '.' }, { search: ' ' }, { category: 'Food', search: 'pocket' }
    ];
    for (const params of combos) {
      assert.deepEqual(ids(await list(params)), ids(expectedBrowserFilter(all, params)), JSON.stringify(params));
    }
  });

  test('SQL-injection attempts are plain text', async () => {
    for (const evil of ["'; DROP TABLE transactions; --", "' OR '1'='1", '" OR 1=1 --', '\\', "%' OR t.id LIKE '%"]) {
      for (const field of ['search', 'category']) {
        assert.deepEqual(await list({ [field]: evil }), [], `${field}: ${evil}`);
      }
      assertError(await call('GET', '/api/transactions' + qs({ accountId: evil })), 400, 'VALIDATION_ERROR', 'accountId');
      assertError(await call('GET', '/api/transactions' + qs({ categoryId: evil })), 400, 'VALIDATION_ERROR', 'categoryId');
      assertError(await call('GET', '/api/transactions' + qs({ from: evil })), 400, 'VALIDATION_ERROR', 'from');
    }
    assert.equal((await list()).length, 10, 'the table is intact');
  });

  test('paging: limit and offset walk the same ordered list without gaps or overlap', async () => {
    const all = ids(await list());
    assert.deepEqual(ids(await list({ limit: 3 })), all.slice(0, 3));
    assert.deepEqual(ids(await list({ limit: 3, offset: 3 })), all.slice(3, 6));
    assert.deepEqual(ids(await list({ offset: 8 })), all.slice(8), 'offset alone');
    assert.deepEqual(await list({ limit: 5, offset: 10 }), [], 'beyond the end');
    const walked = [];
    for (let offset = 0; offset < 10; offset += 4) walked.push(...ids(await list({ limit: 4, offset })));
    assert.deepEqual(walked, all);
    assert.deepEqual(ids(await list({ type: 'expense', limit: 2, offset: 1 })), ids(await list({ type: 'expense' })).slice(1, 3), 'with a filter');
  });

  test('invalid filters are rejected with every problem listed (400 VALIDATION_ERROR)', async () => {
    const bad = [
      [{ type: 'transfer' }, 'type'], [{ categoryId: '0' }, 'categoryId'], [{ categoryId: '-1' }, 'categoryId'],
      [{ categoryId: '1.5' }, 'categoryId'], [{ categoryId: '99999999999' }, 'categoryId'],
      [{ categoryId: '2147483648' }, 'categoryId'], [{ accountId: 'has space' }, 'accountId'],
      [{ accountId: 'x'.repeat(65) }, 'accountId'], [{ from: '2025-02-30' }, 'from'], [{ from: '01/02/2025' }, 'from'],
      [{ to: '2025-13-01' }, 'to'], [{ from: '1800-01-01' }, 'from'], [{ from: '2025-03-01', to: '2025-02-01' }, 'to'],
      [{ search: 'x'.repeat(101) }, 'search'], [{ category: 'x'.repeat(101) }, 'category'],
      [{ limit: '0' }, 'limit'], [{ limit: '501' }, 'limit'], [{ limit: 'ten' }, 'limit'], [{ limit: '1.5' }, 'limit'],
      [{ offset: '-1' }, 'offset'], [{ offset: 'x' }, 'offset'], [{ colour: 'red' }, 'colour']
    ];
    for (const [params, field] of bad) {
      assertError(await call('GET', '/api/transactions' + qs(params)), 400, 'VALIDATION_ERROR', field);
    }
    const many = await call('GET', '/api/transactions' + qs({ type: 'x', from: 'y', limit: '0', nonsense: '1' }));
    assertError(many, 400, 'VALIDATION_ERROR');
    assert.deepEqual(many.json.error.details.map(d => d.field).sort(), ['from', 'limit', 'nonsense', 'type']);
  });

  test('a parameter given twice, or in array form, is rejected', async () => {
    assertError(await call('GET', '/api/transactions?type=income&type=expense'), 400, 'VALIDATION_ERROR', 'type');
    assertError(await call('GET', '/api/transactions?search=a&search=b'), 400, 'VALIDATION_ERROR', 'search');
    assertError(await call('GET', '/api/transactions?type[]=income'), 400, 'VALIDATION_ERROR', 'type[]');
  });

  test('other methods and the single-record route are unaffected', async () => {
    assert.equal((await call('GET', '/api/transactions/t01?type=income')).status, 200, 'query strings are ignored on /:id');
    assert.equal((await call('GET', '/api/transactions/t01')).json.data.description, 'Tea and biscuits');
    assertError(await call('GET', '/api/transactions/nope'), 404, 'NOT_FOUND');
    assertError(await call('PATCH', '/api/transactions'), 405, 'METHOD_NOT_ALLOWED');
    const head = await call('HEAD', '/api/transactions?type=income');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('GET /api/summary', () => {
  test('totals, categories and months for everything', async () => {
    const data = await summary();
    assert.deepEqual(data.filters, {});
    // income 2000 + 15.75 + 2000, expense 12.5 + 0.1 + 0.2 + 300 + 40 + 300 + 3
    assert.deepEqual(data.totals, { count: 10, income: 4015.75, expense: 655.8, balance: 3359.95 });

    assert.deepEqual(data.byCategory, [
      { categoryId: cat.Salary, category: 'Salary', type: 'income', total: 4000, count: 2 },
      { categoryId: cat.Rent, category: 'Rent', type: 'expense', total: 600, count: 2 },
      { categoryId: cat['Other expense'], category: 'Other', type: 'expense', total: 40, count: 1 },
      { categoryId: cat.Food, category: 'Food', type: 'expense', total: 15.8, count: 4 },
      { categoryId: cat['Other income'], category: 'Other', type: 'income', total: 15.75, count: 1 }
    ]);

    assert.deepEqual(data.byMonth, [
      { month: '2025-01', income: 0, expense: 312.8, balance: -312.8, count: 4 },
      { month: '2025-02', income: 2015.75, expense: 40, balance: 1975.75, count: 3 },
      { month: '2025-03', income: 2000, expense: 303, balance: 1697, count: 3 }
    ]);
  });

  test('the parts always add up to the totals', async () => {
    for (const params of [{}, { type: 'expense' }, { accountId: 'bank' }, { search: 'a' }, { from: '2025-02-01' }]) {
      const data = await summary(params);
      const sum = (rows, key) => Math.round(rows.reduce((total, row) => total + row[key], 0) * 100) / 100;
      assert.equal(sum(data.byCategory, 'count'), data.totals.count, JSON.stringify(params));
      assert.equal(sum(data.byMonth, 'count'), data.totals.count);
      assert.equal(sum(data.byMonth, 'income'), data.totals.income);
      assert.equal(sum(data.byMonth, 'expense'), data.totals.expense);
      assert.equal(sum(data.byCategory.filter(r => r.type === 'income'), 'total'), data.totals.income);
      assert.equal(sum(data.byCategory.filter(r => r.type === 'expense'), 'total'), data.totals.expense);
    }
  });

  test('uses the same filters as the list, and agrees with it for every combination', async () => {
    const all = await list();
    const combos = [
      { type: 'expense' }, { type: 'income' }, { category: 'Other' }, { accountId: 'cash' }, { search: 'rent' },
      { from: '2025-01-31', to: '2025-02-28' }, { type: 'expense', accountId: 'bank' }, { search: '%' }, { search: 'zzz' }
    ];
    for (const params of combos) {
      const rows = await list(params);
      const data = await summary(params);
      const cents = type => rows.filter(r => r.type === type).reduce((total, r) => total + Math.round(r.amount * 100), 0);
      assert.deepEqual(data.filters, params);
      assert.equal(data.totals.count, rows.length, JSON.stringify(params));
      assert.equal(data.totals.income, cents('income') / 100);
      assert.equal(data.totals.expense, cents('expense') / 100);
      assert.equal(data.totals.balance, (cents('income') - cents('expense')) / 100);
    }
    assert.ok(all.length > 0);
  });

  test('an empty result is zeros and empty lists, not an error', async () => {
    assert.deepEqual(await summary({ search: 'nothing matches this' }), {
      filters: { search: 'nothing matches this' },
      totals: { count: 0, income: 0, expense: 0, balance: 0 },
      byCategory: [],
      byMonth: []
    });
  });

  test('filters are validated like the list (but paging is not allowed)', async () => {
    assertError(await call('GET', '/api/summary?type=bad'), 400, 'VALIDATION_ERROR', 'type');
    assertError(await call('GET', '/api/summary?from=2025-03-01&to=2025-01-01'), 400, 'VALIDATION_ERROR', 'to');
    assertError(await call('GET', '/api/summary?limit=5'), 400, 'VALIDATION_ERROR', 'limit');
    assertError(await call('GET', '/api/summary?offset=1'), 400, 'VALIDATION_ERROR', 'offset');
    assertError(await call('GET', '/api/summary?unknown=1'), 400, 'VALIDATION_ERROR', 'unknown');
    assertError(await call('POST', '/api/summary', {}), 405, 'METHOD_NOT_ALLOWED');
    assert.match((await call('POST', '/api/summary', {})).headers.allow, /GET/);
    for (const evil of ["'; DROP TABLE transactions; --", "' OR '1'='1"]) {
      assert.equal((await summary({ search: evil })).totals.count, 0);
    }
    assert.equal((await summary()).totals.count, 10);
  });

  test('money stays exact (no floating point drift) with fractions and very large amounts', async () => {
    const before = await summary();
    for (let i = 0; i < 3; i += 1) {
      const r = await call('POST', '/api/transactions', {
        id: `big${i}`, type: 'income', description: 'Huge', categoryId: cat.Salary, accountId: 'bank', amount: 1000000000, date: '2025-04-01', createdAt: 5000 + i
      });
      assert.equal(r.status, 201, r.text);
    }
    for (const [i, amount] of [0.1, 0.2, 0.7].entries()) {
      await call('POST', '/api/transactions', {
        id: `frac${i}`, type: 'expense', description: 'Fraction', categoryId: cat.Food, accountId: 'bank', amount, date: '2025-04-02', createdAt: 6000 + i
      });
    }
    const april = (await summary({ from: '2025-04-01' }));
    assert.deepEqual(april.totals, { count: 6, income: 3000000000, expense: 1, balance: 2999999999 });
    assert.deepEqual(april.byMonth, [{ month: '2025-04', income: 3000000000, expense: 1, balance: 2999999999, count: 6 }]);
    for (const id of ['big0', 'big1', 'big2', 'frac0', 'frac1', 'frac2']) await call('DELETE', `/api/transactions/${id}`);
    assert.deepEqual(await summary(), before, 'deleting them restores the summary');
  });

  test('follows edits and deletes immediately (it is calculated on every request)', async () => {
    const before = (await summary({ accountId: 'cash' })).totals;
    const edit = await call('PUT', '/api/transactions/t01', {
      type: 'expense', description: 'Tea and biscuits', categoryId: cat.Food, accountId: 'cash', amount: 20, note: 'morning', date: '2025-01-05'
    });
    assert.equal(edit.status, 200, edit.text);
    assert.equal((await summary({ accountId: 'cash' })).totals.expense, before.expense + 7.5);
    await call('PUT', '/api/transactions/t01', {
      type: 'expense', description: 'Tea and biscuits', categoryId: cat.Food, accountId: 'cash', amount: 12.5, note: 'morning', date: '2025-01-05'
    });
    assert.deepEqual((await summary({ accountId: 'cash' })).totals, before);
  });

  test('stays consistent while transactions are being added at the same time', async () => {
    const writers = Array.from({ length: 30 }, (_, i) => call('POST', '/api/transactions', {
      id: `race${i}`, type: i % 2 ? 'income' : 'expense', description: 'Race', categoryId: i % 2 ? cat.Salary : cat.Food,
      accountId: 'cash', amount: 1.1, date: '2025-05-01', createdAt: 9000 + i
    }));
    const readers = Array.from({ length: 15 }, () => summary({ from: '2025-05-01' }));
    const results = await Promise.all([...readers, ...writers]);
    for (const data of results.slice(0, 15)) {
      const sum = key => data.byMonth.reduce((total, row) => total + row[key], 0);
      assert.equal(sum('count'), data.totals.count, 'month counts agree with the total count');
      assert.equal(data.byCategory.reduce((total, row) => total + row.count, 0), data.totals.count);
      assert.equal(Math.round(data.totals.balance * 100), Math.round((data.totals.income - data.totals.expense) * 100));
    }
    const final = await summary({ from: '2025-05-01' });
    assert.equal(final.totals.count, 30);
    assert.deepEqual(final.totals, { count: 30, income: 16.5, expense: 16.5, balance: 0 });
    for (let i = 0; i < 30; i += 1) await call('DELETE', `/api/transactions/race${i}`);
  });
});

// ---------------------------------------------------------------------------
// Larger data and failure behaviour
// ---------------------------------------------------------------------------

describe('larger data', () => {
  test('5,000 rows: filtered pages and the summary are correct and quick', async () => {
    await db.query(`
      INSERT INTO transactions (id, type, description, category_id, account_id, amount_minor, note, date, created_at)
      SELECT 'bulk' || n, 'expense', 'Bulk item ' || n, $1, 'cash', 100 + n % 50, '', '2024-06-' || lpad(((n % 28) + 1)::text, 2, '0'), n
      FROM generate_series(1, 5000) AS n`, [cat.Food]);

    const started = Date.now();
    const page = await list({ search: 'bulk item 49', limit: 25, offset: 25 });
    assert.equal(page.length, 25);
    assert.ok(page.every(row => /bulk item 49/i.test(row.description)));
    const june = await summary({ from: '2024-06-01', to: '2024-06-30', type: 'expense' });
    assert.equal(june.totals.count, 5000);
    assert.equal(june.byMonth.length, 1);
    assert.ok(Date.now() - started < 5000, 'well under the time a user would notice');

    assert.equal((await list()).length, 5010, 'the unfiltered list still returns everything');
    await db.query("DELETE FROM transactions WHERE id LIKE 'bulk%'");
  });
});

describe('database failure', () => {
  test('a database error is a generic 500 with nothing leaked, and the server recovers', async () => {
    await db.closeDatabase();
    const quiet = console.error;
    console.error = () => {};
    try {
      assertError(await call('GET', '/api/transactions?type=income'), 500, 'INTERNAL_ERROR');
      assertError(await call('GET', '/api/summary'), 500, 'INTERNAL_ERROR');
    } finally {
      console.error = quiet;
      await db.initDatabase({ connectionString: TEST_URL, schema: testSchema.schema });
    }
    assert.equal((await list({ type: 'income' })).length, 3);
    assert.equal((await summary()).totals.count, 10);
  });
});
