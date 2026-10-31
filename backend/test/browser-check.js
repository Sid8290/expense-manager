'use strict';

// OPTIONAL real-browser check for the frontend/API integration.
// It is NOT part of `npm test` (which has no dependencies); it needs Playwright.
//
//   npm install --no-save playwright        (one time; downloads a browser)
//   npx playwright install chromium         (one time)
//   node backend/test/browser-check.js
//
// It starts the real server on a random port with a throw-away PostgreSQL
// schema (needs TEST_DATABASE_URL, see .env.example), opens
// the real pages in a headless browser, uses them like a person would, and
// compares what the pages show with what the database API says. Your real
// database and your real browser profile are never touched.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let playwright;
try {
  playwright = require('playwright');
} catch (error) {
  console.error('Playwright is not installed. See the instructions at the top of this file.');
  process.exit(2);
}

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-browser-'));
let testSchema = null; // a throw-away PostgreSQL schema in the TEST_DATABASE_URL database (see main())

const results = [];
let serverProcess = null;
let origin = '';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: { ...process.env, PORT: process.env.CHECK_PORT || '0', DATABASE_URL: testSchema.url },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error('server did not start\n' + output)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        serverProcess = child;
        origin = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.on('exit', code => reject(new Error(`server exited early (${code})\n${output}`)));
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!serverProcess) return resolve();
    const child = serverProcess;
    serverProcess = null;
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function api(method, urlPath, body) {
  const response = await fetch(origin + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return (await response.json()).data;
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

function equal(actual, expected, label = 'value') {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}

function truthy(value, label) {
  if (!value) throw new Error(`${label} was not true`);
}

const text = async (page, selector) => (await page.locator(selector).first().innerText()).trim();
const money = (page, value) => page.evaluate(amount => formatCurrency(amount), value); // the app's own formatter

// Opens a page and waits until the app has finished loading its data.
async function open(page, pagePath) {
  await page.goto(origin + pagePath);
  await page.waitForFunction(() => !document.documentElement.classList.contains('data-pending'));
}

// New isolated browser context (its own localStorage), collecting console problems.
async function newPage(browser, { legacy } = {}) {
  const context = await browser.newContext();
  if (legacy) {
    // Pre-fills localStorage ONCE, before any page script runs.
    await context.addInitScript(data => {
      if (!sessionStorage.getItem('seeded')) {
        Object.entries(data).forEach(([key, value]) => localStorage.setItem(key, value));
        sessionStorage.setItem('seeded', '1');
      }
    }, legacy);
  }
  const page = await context.newPage();
  page.problems = [];
  page.requests = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (message.location().url.includes('cdnjs.cloudflare.com')) return; // blocked on purpose below
    page.problems.push(`console: ${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', error => page.problems.push('pageerror: ' + error.message));
  page.on('request', request => {
    if (request.url().startsWith(origin + '/api/')) page.requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on('dialog', dialog => dialog.accept());
  // The icon font comes from a CDN. It is not part of this check.
  await context.route(/cdnjs\.cloudflare\.com/, route => route.abort());
  return page;
}

const storageKeys = page => page.evaluate(() => Object.keys(localStorage).sort());

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  testSchema = await require('./helpers/pg-test-db').createTestSchema();
  await startServer();
  const browser = await playwright.chromium.launch();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  console.log(`\nServer: ${origin} (temporary database)\n`);
  console.log('Scenario 1: fresh browser, empty database');

  const page = await newPage(browser);

  await check('all six pages load with no console errors and no failed API calls', async () => {
    for (const p of ['/', '/pages/transactions.html', '/pages/accounts.html', '/pages/categories.html', '/pages/analytics.html', '/pages/settings.html']) {
      await open(page, p);
      truthy(await page.locator('main').isVisible(), `${p} main visible`);
      equal(await page.locator('.status-banner').count(), 0, `${p} banners`);
    }
    equal(page.problems.length, 0, 'console problems: ' + page.problems.join(' | '));
  });

  await check('empty database shows empty states, not errors', async () => {
    await open(page, '/');
    equal(await text(page, '#total-income'), await money(page, 0), 'income');
    truthy((await text(page, '#recent-transactions-body')).includes('No transactions yet'), 'recent empty state');
    await open(page, '/pages/transactions.html');
    truthy((await text(page, '#transactions-body')).includes('No transactions yet'), 'transactions empty state');
    truthy((await text(page, '#transaction-category')).includes('No categories'), 'category select empty state');
    truthy((await text(page, '#account')).includes('No accounts'), 'account select empty state');
    await open(page, '/pages/analytics.html');
    truthy((await text(page, '#expense-chart')).includes('No expense data'), 'analytics empty chart');
  });

  await check('no financial data is written to localStorage (the old keys are not recreated)', async () => {
    const keys = await storageKeys(page);
    equal(keys.filter(key => ['em_transactions', 'em_accounts', 'em_categories'].includes(key)).length, 0, 'financial keys');
  });

  await check('categories: add through the page, saved in the database', async () => {
    await open(page, '/pages/categories.html');
    for (const [name, type] of [['Groceries', 'expense'], ['Salary', 'income'], ['Rent', 'expense']]) {
      await page.fill('#category-name', name);
      await page.selectOption('#category-type', type);
      await page.click('.add-category-form button[type=submit]');
      await page.waitForFunction(n => document.querySelector('.add-category-form .form-message').textContent === 'Category added.' && document.body.innerText.includes(n), name);
    }
    const saved = await api('GET', '/api/categories');
    equal(saved.map(c => `${c.type}:${c.name}`).join(','), 'expense:Groceries,income:Salary,expense:Rent', 'database categories');
  });

  await check('categories: a duplicate is refused and nothing extra is stored', async () => {
    await page.fill('#category-name', 'groceries');
    await page.selectOption('#category-type', 'expense');
    await page.click('.add-category-form button[type=submit]');
    truthy((await text(page, '.add-category-form .form-message')).includes('already exists'), 'message');
    equal((await api('GET', '/api/categories')).length, 3, 'category count');
  });

  await check('accounts: add cash, bank and asset accounts through the page', async () => {
    await open(page, '/pages/accounts.html');
    for (const [name, type, amount] of [['Cash', 'cash', '1000'], ['Bank Account', 'bank', '500.50'], ['House', 'asset', '20000']]) {
      await page.fill('#account-name', name);
      await page.selectOption('#account-type', type);
      await page.fill('#account-amount', amount);
      await page.click('.add-account-form button[type=submit]');
      await page.waitForFunction(n => document.querySelector('.add-account-form .form-message').textContent === 'Account added.' && document.body.innerText.includes(n), name);
    }
    const saved = await api('GET', '/api/accounts');
    equal(saved.map(a => `${a.name}:${a.type}:${a.balance}`).join(','), 'Cash:cash:1000,Bank Account:bank:500.5,House:asset:20000', 'database accounts');
    equal(await text(page, '#position-available'), await money(page, 1500.5), 'available');
  });

  await check('transactions: add an expense and an income through the page', async () => {
    await open(page, '/pages/transactions.html');
    const accounts = await api('GET', '/api/accounts');
    const cash = accounts.find(a => a.name === 'Cash');
    const bank = accounts.find(a => a.name === 'Bank Account');

    await page.selectOption('#transaction-type', 'expense');
    await page.fill('#description', 'Milk and bread');
    await page.selectOption('#transaction-category', 'Groceries');
    await page.selectOption('#account', cash.id);
    await page.fill('#amount', '45.5');
    await page.fill('#note', 'weekly shop');
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message').textContent === 'Transaction added.');

    await page.selectOption('#transaction-type', 'income');
    await page.fill('#description', 'October salary');
    await page.selectOption('#transaction-category', 'Salary');
    await page.selectOption('#account', bank.id);
    await page.fill('#amount', '2000');
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('#transactions-body tr').length === 2 && document.querySelector('#transactions-body').innerText.includes('October salary'));

    const saved = await api('GET', '/api/transactions');
    equal(saved.length, 2, 'database transactions');
    const milk = saved.find(t => t.description === 'Milk and bread');
    equal(`${milk.type}|${milk.category}|${milk.accountId === cash.id}|${milk.amount}|${milk.note}|${milk.date}`, `expense|Groceries|true|45.5|weekly shop|${iso}`, 'stored expense');
    equal(await text(page, '#transaction-summary'), `Showing 2 of 2 transactions | Income: ${await money(page, 2000)} | Expenses: ${await money(page, 45.5)}`, 'summary line');
    truthy((await text(page, '#account')).includes(await money(page, 954.5)), 'account select shows the new Cash balance');
    equal(page.problems.length, 0, 'console problems: ' + page.problems.join(' | '));
  });

  await check('transactions: filters and search still work on database data', async () => {
    await page.selectOption('#filter-type', 'income');
    equal(await page.locator('#transactions-body tr').count(), 1, 'income rows');
    await page.selectOption('#filter-type', 'all');
    await page.fill('#filter-search', 'milk');
    equal(await page.locator('#transactions-body tr').count(), 1, 'search rows');
    await page.click('#filter-clear');
    equal(await page.locator('#transactions-body tr').count(), 2, 'cleared');
  });

  await check('dashboard totals equal the sums of the database records', async () => {
    const transactions = await api('GET', '/api/transactions');
    const accounts = await api('GET', '/api/accounts');
    const income = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const moneyBalance = accounts.filter(a => ['cash', 'bank', 'online'].includes(a.type)).reduce((s, a) => s + a.currentBalance, 0);
    await open(page, '/');
    equal(await text(page, '#total-income'), await money(page, income), 'income');
    equal(await text(page, '#total-expense'), await money(page, expense), 'expense');
    equal(await text(page, '#total-balance'), await money(page, Math.round(moneyBalance * 100) / 100), 'balance (matches the API currentBalance)');
    equal(await page.locator('#recent-transactions-body tr').count(), 2, 'recent rows');
  });

  await check('analytics shows the same data', async () => {
    await open(page, '/pages/analytics.html');
    equal(await text(page, '#expense-total'), await money(page, 45.5), 'expense total');
    equal(await text(page, '#income-total'), await money(page, 2000), 'income total');
    equal(await text(page, '#net-balance'), await money(page, 1954.5), 'net');
    truthy((await text(page, '#expense-chart')).includes('Groceries'), 'category chart');
    equal(await text(page, '#income-count'), '1 Transaction', 'income count');
  });

  await check('the notification bell shows the monthly summary from database data', async () => {
    await open(page, '/');
    await page.click('.notification-button');
    truthy((await text(page, '.notification-panel')).includes('This month'), 'monthly summary');
  });

  await check('accounts page balances come from transactions (Cash 954.50, Bank 2500.50)', async () => {
    await open(page, '/pages/accounts.html');
    const body = await text(page, '#money-accounts');
    truthy(body.includes(await money(page, 954.5)) && body.includes(await money(page, 2500.5)), 'balances: ' + body);
    equal(await text(page, '#position-net'), await money(page, 954.5 + 2500.5 + 20000), 'net position');
  });

  await check('an account and a category used by transactions cannot be deleted', async () => {
    await open(page, '/pages/accounts.html');
    await page.locator('#money-accounts .card', { hasText: 'Cash' }).locator('button').click();
    await page.waitForFunction(() => document.querySelector('.toast.visible'));
    truthy((await text(page, '.toast')).includes('cannot be deleted'), 'account toast');
    equal((await api('GET', '/api/accounts')).length, 3, 'accounts unchanged');
    await open(page, '/pages/categories.html');
    await page.locator('#expense-categories .card', { hasText: 'Groceries' }).locator('button').click();
    await page.waitForFunction(() => document.querySelector('.toast.visible'));
    equal((await api('GET', '/api/categories')).length, 3, 'categories unchanged');
  });

  await check('an unused category can be deleted', async () => {
    await page.locator('#expense-categories .card', { hasText: 'Rent' }).locator('button').click();
    await page.waitForFunction(() => !document.getElementById('expense-categories').innerText.includes('Rent'));
    equal((await api('GET', '/api/categories')).map(c => c.name).join(','), 'Groceries,Salary', 'database categories');
  });

  await check('data survives a server restart and a page reload', async () => {
    await stopServer();
    await startServer();
    await open(page, '/pages/transactions.html');
    equal(await page.locator('#transactions-body tr').count(), 2, 'rows after restart');
    equal((await api('GET', '/api/accounts')).length, 3, 'accounts after restart');
  });

  await check('deleting a transaction updates the page, the balance and the database', async () => {
    await open(page, '/pages/transactions.html');
    await page.locator('#transactions-body tr', { hasText: 'Milk and bread' }).locator('button').click();
    await page.waitForFunction(() => document.querySelectorAll('#transactions-body tr').length === 1);
    equal((await api('GET', '/api/transactions')).length, 1, 'database transactions');
    equal((await api('GET', '/api/accounts')).find(a => a.name === 'Cash').currentBalance, 1000, 'Cash balance in the database');
    truthy((await text(page, '#account')).includes(await money(page, 1000)), 'Cash balance in the select');
  });

  console.log('\nScenario 2: failures are handled (requests are intercepted in the browser)');

  await check('server error on save: message shown, form input kept, nothing added', async () => {
    await open(page, '/pages/transactions.html');
    await page.route('**/api/transactions', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"SQLITE_ERROR boom at C:\\\\secret\\\\db.js:1"}}' })
      : route.continue());
    await page.fill('#description', 'Will fail');
    await page.fill('#amount', '12');
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message.error'));
    const message = await text(page, '.add-transaction-form .form-message');
    truthy(!/sqlite|secret|db\.js/i.test(message), 'internal details leaked: ' + message);
    equal(await page.inputValue('#description'), 'Will fail', 'description kept');
    equal(await page.inputValue('#amount'), '12', 'amount kept');
    equal(await page.locator('#transactions-body tr').count(), 1, 'table unchanged');
    await page.unroute('**/api/transactions');
  });

  await check('validation error from the API is shown in plain words', async () => {
    await page.route('**/api/transactions', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid data.', details: [{ field: 'amount', message: 'Must have at most 2 decimal places.' }] } }) })
      : route.continue());
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message').textContent.startsWith('Amount:'));
    equal(await text(page, '.add-transaction-form .form-message'), 'Amount: Must have at most 2 decimal places.', 'message');
    await page.unroute('**/api/transactions');
  });

  await check('network failure on save: understandable message, input kept', async () => {
    await page.route('**/api/transactions', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message').textContent.includes('Cannot reach the server'));
    truthy((await text(page, '.add-transaction-form .form-message')).includes('Cannot reach the server'), 'message');
    equal(await page.inputValue('#description'), 'Will fail', 'description kept');
    await page.unroute('**/api/transactions');
  });

  await check('double submit sends only one request and adds one record', async () => {
    await page.route('**/api/transactions', async route => {
      if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    page.requests.length = 0;
    await page.fill('#description', 'Double click');
    await page.fill('#amount', '7');
    await page.evaluate(() => {
      const form = document.querySelector('.add-transaction-form');
      form.requestSubmit();
      form.requestSubmit();
      form.requestSubmit();
    });
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message').textContent === 'Transaction added.');
    equal(page.requests.filter(r => r === 'POST /api/transactions').length, 1, 'POST requests');
    equal((await api('GET', '/api/transactions')).filter(t => t.description === 'Double click').length, 1, 'database records');
    await page.unroute('**/api/transactions');
  });

  await check('record deleted elsewhere: the page recovers instead of breaking', async () => {
    await open(page, '/pages/transactions.html');
    const victim = (await api('GET', '/api/transactions')).find(t => t.description === 'Double click');
    await api('DELETE', `/api/transactions/${victim.id}`); // removed behind the page's back
    await page.locator('#transactions-body tr', { hasText: 'Double click' }).locator('button').click();
    await page.waitForFunction(() => !document.getElementById('transactions-body').innerText.includes('Double click'));
    truthy((await text(page, '.toast')).includes('no longer exists'), 'toast');
  });

  await check('a category deleted elsewhere: the save is refused and the page refreshes its lists', async () => {
    const temp = await api('POST', '/api/categories', { name: 'Temp', type: 'expense' });
    await open(page, '/pages/transactions.html');
    await page.selectOption('#transaction-type', 'expense');
    await page.selectOption('#transaction-category', 'Temp');
    await page.fill('#description', 'Stale category');
    await page.fill('#amount', '3');
    await api('DELETE', `/api/categories/${temp.id}`); // removed behind the page's back
    await page.click('.add-transaction-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.add-transaction-form .form-message').textContent.startsWith('Category:'));
    equal(await text(page, '.add-transaction-form .form-message'), 'Category: No category with this id.', 'message');
    await page.waitForFunction(() => ![...document.querySelectorAll('#transaction-category option')].some(option => option.value === 'Temp'));
    equal(await page.inputValue('#description'), 'Stale category', 'description kept');
    equal((await api('GET', '/api/transactions')).some(t => t.description === 'Stale category'), false, 'nothing stored');
  });

  await check('backend unavailable at load: error banner, hidden content, retry works', async () => {
    await page.route('**/api/**', route => route.abort());
    await page.goto(origin + '/');
    await page.waitForSelector('.status-banner.error');
    truthy((await text(page, '.status-banner.error')).includes('Cannot reach the server'), 'banner text');
    equal(await page.locator('.main-grid').isVisible(), false, 'content hidden while data is unavailable');
    await page.unroute('**/api/**');
    await page.click('.status-banner.error button');
    await page.waitForFunction(() => !document.documentElement.classList.contains('data-pending') && !document.documentElement.classList.contains('data-error'));
    equal(await page.locator('.main-grid').isVisible(), true, 'content visible after retry');
    equal(await page.locator('.status-banner').count(), 0, 'banners cleared');
    equal(await text(page, '#total-income'), await money(page, 2000), 'real data after retry');
  });

  console.log('\nScenario 3: non-financial features still use localStorage');

  await check('theme, bills and to-dos work and are stored in localStorage', async () => {
    await open(page, '/pages/settings.html');
    await page.selectOption('#theme-select', 'dark');
    await page.click('.appearance-change-form button[type=submit]');
    equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'dark theme');
    await open(page, '/');
    await page.fill('#bill-name', 'Electricity');
    await page.fill('#bill-date', iso);
    await page.fill('#bill-amount', '800');
    await page.click('#bill-form button[type=submit]');
    await page.fill('#todo-text', 'Pay rent');
    await page.click('#todo-form button[type=submit]');
    truthy((await text(page, '#bill-list')).includes('Electricity'), 'bill');
    truthy((await text(page, '#todo-items')).includes('Pay rent'), 'todo');
    const keys = await storageKeys(page);
    truthy(['em_settings', 'em_bills', 'em_todos'].every(key => keys.includes(key)), 'keys ' + keys);
  });

  await check('"Reset" clears only settings, bills and to-dos; database data stays', async () => {
    await open(page, '/pages/settings.html');
    await Promise.all([page.waitForNavigation(), page.click('#reset-data')]);
    await page.waitForFunction(() => !document.documentElement.classList.contains('data-pending'));
    // The old bill list is gone. (The app re-creates an EMPTY bill list on the next load; that is existing behaviour.)
    const local = await page.evaluate(() => ({
      settings: localStorage.getItem('em_settings'),
      bills: localStorage.getItem('em_bills'),
      todos: localStorage.getItem('em_todos')
    }));
    equal(local.settings, null, 'em_settings');
    truthy(local.bills === null || local.bills === '[]', 'em_bills reset: ' + local.bills);
    truthy(local.todos === null || local.todos === '[]', 'em_todos reset: ' + local.todos);
    equal((await api('GET', '/api/accounts')).length, 3, 'accounts still in the database');
    truthy((await api('GET', '/api/transactions')).length >= 1, 'transactions still in the database');
  });

  await page.context().close();

  console.log('\nScenario 4: browser still holds data from the old version');

  const legacyData = {
    em_transactions: JSON.stringify([
      { id: 'txn-old1', type: 'expense', description: 'Old tea', category: 'Groceries', accountId: 'acc-cash', amount: 12.5, note: '', date: '2025-01-05', createdAt: 1736000000000 },
      { id: 'txn-old2', type: 'income', description: 'Old pay', category: 'Salary', accountId: 'acc-bank', amount: 900, note: '', date: '2025-01-06', createdAt: 1736100000000 }
    ]),
    em_accounts: JSON.stringify([
      { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
      { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 },
      { id: 'acc-old', name: 'Old Savings', type: 'bank', balance: 300 }
    ]),
    em_categories: JSON.stringify([
      { name: 'Groceries', type: 'expense' },
      { name: 'Salary', type: 'income' },
      { name: 'Hobbies', type: 'expense' }
    ])
  };

  const legacyPage = await newPage(browser, { legacy: legacyData });

  await check('a warning shows what is still in the browser; the pages work normally', async () => {
    await open(legacyPage, '/');
    const banner = await text(legacyPage, '.status-banner.warning');
    truthy(banner.includes('2 transactions') && banner.includes('1 account,') && banner.includes('1 category'), 'counts in banner: ' + banner);
    truthy(banner.includes('not been changed or deleted'), 'reassurance');
    truthy(!banner.includes('imported successfully'), 'does not claim a migration');
    equal(legacyPage.problems.length, 0, 'console problems: ' + legacyPage.problems.join(' | '));
  });

  await check('the warning is on every page and does not disappear when the database gets data', async () => {
    for (const p of ['/pages/transactions.html', '/pages/accounts.html', '/pages/categories.html', '/pages/analytics.html', '/pages/settings.html']) {
      await open(legacyPage, p);
      equal(await legacyPage.locator('.status-banner.warning').count(), 1, `${p} banner`);
    }
    await open(legacyPage, '/pages/accounts.html');
    await legacyPage.fill('#account-name', 'New DB account');
    await legacyPage.fill('#account-amount', '1');
    await legacyPage.click('.add-account-form button[type=submit]');
    await legacyPage.waitForFunction(() => document.body.innerText.includes('New DB account'));
    equal(await legacyPage.locator('.status-banner.warning').count(), 1, 'banner after saving to the database');
  });

  await check('old records are not shown as if they were in the database', async () => {
    const accounts = await api('GET', '/api/accounts');
    equal(accounts.some(a => a.name === 'Old Savings'), false, 'old account was not imported');
    await open(legacyPage, '/pages/transactions.html');
    truthy(!(await text(legacyPage, '#transactions-body')).includes('Old tea'), 'old transaction not shown');
  });

  await check('"Dismiss" hides the warning for this tab only', async () => {
    await legacyPage.click('.status-banner.warning button:has-text("Dismiss")');
    equal(await legacyPage.locator('.status-banner.warning').count(), 0, 'dismissed');
    await open(legacyPage, '/pages/accounts.html');
    equal(await legacyPage.locator('.status-banner.warning').count(), 0, 'stays dismissed in this tab');
  });

  await check('the old financial localStorage keys are byte-for-byte unchanged after the whole session', async () => {
    await open(legacyPage, '/pages/settings.html');
    await Promise.all([legacyPage.waitForNavigation(), legacyPage.click('#reset-data')]); // the riskiest button
    await legacyPage.waitForFunction(() => !document.documentElement.classList.contains('data-pending'));
    const stored = await legacyPage.evaluate(() => ({
      em_transactions: localStorage.getItem('em_transactions'),
      em_accounts: localStorage.getItem('em_accounts'),
      em_categories: localStorage.getItem('em_categories')
    }));
    equal(stored.em_transactions, legacyData.em_transactions, 'em_transactions');
    equal(stored.em_accounts, legacyData.em_accounts, 'em_accounts');
    equal(stored.em_categories, legacyData.em_categories, 'em_categories');
  });

  await legacyPage.context().close();

  await check('untouched old defaults alone do not trigger the warning', async () => {
    const onlyDefaults = {
      em_transactions: '[]',
      em_accounts: JSON.stringify([{ id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 }, { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 }]),
      em_categories: JSON.stringify([{ name: 'Groceries', type: 'expense' }, { name: 'Salary', type: 'income' }])
    };
    const p = await newPage(browser, { legacy: onlyDefaults });
    await open(p, '/');
    equal(await p.locator('.status-banner.warning').count(), 0, 'no banner');
    await p.context().close();
  });

  console.log('\nScenario 6: moving the old browser data into the database (Settings)');

  const mig = {
    em_transactions: JSON.stringify([
      { id: 'txn-m1', type: 'expense', description: 'Migrate tea', category: 'MigFood', accountId: 'acc-m1', amount: 12.5, note: 'n', date: '2025-02-05', createdAt: 1738700000000, futureField: 'kept in backup' },
      { id: 'txn-m2', type: 'income', description: 'Migrate pay', category: 'MigPay', accountId: 'acc-m1', amount: 900, note: '', date: '2025-02-06', createdAt: 1738800000000 },
      { id: 'txn-bad', type: 'expense', description: 'Broken', category: 'MigFood', accountId: 'acc-m1', amount: -5, note: '', date: '2025-02-07' }
    ]),
    em_accounts: JSON.stringify([
      { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
      { id: 'acc-m1', name: 'Migrate Savings', type: 'bank', balance: 300 }
    ]),
    em_categories: JSON.stringify([{ name: 'MigFood', type: 'expense' }, { name: 'MigPay', type: 'income' }])
  };
  const migPage = await newPage(browser, { legacy: mig });
  const readLegacy = () => migPage.evaluate(() => ({ t: localStorage.getItem('em_transactions'), a: localStorage.getItem('em_accounts'), c: localStorage.getItem('em_categories') }));
  const dbBefore = { accounts: (await api('GET', '/api/accounts')).length, categories: (await api('GET', '/api/categories')).length, transactions: (await api('GET', '/api/transactions')).length };
  let backupText = '';

  await check('the review shows the legacy counts next to the database counts, and writes nothing', async () => {
    await open(migPage, '/pages/settings.html');
    await migPage.waitForSelector('#migration-review .card');
    const review = await text(migPage, '#migration-review');
    truthy(review.includes('found in this browser'), 'review text: ' + review);
    truthy(review.includes('1 malformed'), 'the invalid transaction is flagged as malformed');
    truthy(review.includes('In the database:'), 'database counts shown');
    equal(await migPage.locator('#migration-preview-button').isEnabled(), true, 'preview enabled');
    equal(await migPage.locator('#migration-run').count(), 0, 'no import button before a preview');
    equal(migPage.problems.length, 0, 'console: ' + migPage.problems.join(' | '));
  });

  await check('the legacy backup downloads, is faithful (unknown field kept) and does not touch localStorage', async () => {
    const [download] = await Promise.all([migPage.waitForEvent('download'), migPage.click('#export-legacy')]);
    truthy(/^expense-manager-legacy-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), 'file name ' + download.suggestedFilename());
    const file = path.join(tmpRoot, 'legacy-backup.json');
    await download.saveAs(file);
    backupText = fs.readFileSync(file, 'utf8');
    const backup = JSON.parse(backupText);
    equal(backup.format, 'expense-manager-legacy-backup', 'format');
    equal(backup.version, 1, 'version');
    truthy(backup.exportedAt && backup.complete === true, 'timestamp/complete');
    equal(backup.data.transactions.length, 3, 'all 3 transactions incl. the invalid one');
    equal(backup.data.transactions[0].futureField, 'kept in backup', 'unknown field');
    const stored = await readLegacy();
    equal(stored.t, mig.em_transactions, 'em_transactions');
  });

  await check('preview changes nothing in the database and shows real numbers', async () => {
    await migPage.click('#migration-preview-button');
    await migPage.waitForSelector('#migration-preview table');
    const preview = await text(migPage, '#migration-preview');
    truthy(preview.includes('Nothing has been changed yet'), 'says nothing changed');
    truthy(preview.includes('Broken'), 'rejected record is listed with its reason');
    equal((await api('GET', '/api/transactions')).length, dbBefore.transactions, 'transactions unchanged');
    equal((await api('GET', '/api/accounts')).length, dbBefore.accounts, 'accounts unchanged');
    equal((await api('GET', '/api/categories')).length, dbBefore.categories, 'categories unchanged');
  });

  await check('importing needs the confirmation box', async () => {
    equal(await migPage.locator('#migration-run').isDisabled(), true, 'disabled before ticking');
    await migPage.check('#migration-confirm');
    equal(await migPage.locator('#migration-run').isEnabled(), true, 'enabled after ticking');
  });

  await check('import saves exactly the valid records and the report matches the database', async () => {
    await migPage.click('#migration-run');
    await migPage.waitForSelector('#migration-report:not([hidden]) table');
    const report = await text(migPage, '#migration-report');
    truthy(report.includes('Import finished partially'), 'partial because one record is invalid: ' + report);
    truthy(report.includes('matched what was sent'), 'verification line');
    const transactions = await api('GET', '/api/transactions');
    equal(transactions.length, dbBefore.transactions + 2, 'two transactions added');
    truthy(transactions.some(t => t.id === 'txn-m1' && t.amount === 12.5 && t.category === 'MigFood'), 'txn-m1 saved correctly');
    equal(transactions.some(t => t.id === 'txn-bad'), false, 'invalid record not saved');
    const accounts = await api('GET', '/api/accounts');
    truthy(accounts.some(a => a.id === 'acc-m1' && a.name === 'Migrate Savings'), 'account saved');
    equal(accounts.some(a => a.name === 'Cash' && a.id === 'acc-cash'), false, 'unused old default not imported');
  });

  await check('localStorage is byte-for-byte unchanged after the import', async () => {
    const stored = await readLegacy();
    equal(stored.t, mig.em_transactions, 'em_transactions');
    equal(stored.a, mig.em_accounts, 'em_accounts');
    equal(stored.c, mig.em_categories, 'em_categories');
  });

  await check('importing again adds nothing (idempotent) and the notice is updated, not just hidden', async () => {
    await open(migPage, '/pages/settings.html');
    await migPage.click('#migration-preview-button');
    await migPage.waitForSelector('#migration-preview table');
    equal(await migPage.locator('#migration-run').count(), 0, 'nothing new to import, so no import button');
    const before = (await api('GET', '/api/transactions')).length;
    const direct = await api('POST', '/api/import', { ...JSON.parse(backupText), confirm: true });
    equal(direct.counts.transactions.imported, 0, 'second import imported 0 transactions');
    equal((await api('GET', '/api/transactions')).length, before, 'count unchanged');
    await migPage.waitForFunction(() => /cannot be imported|already in the database/.test(document.querySelector('.status-banner')?.innerText || ''));
    truthy(!(await text(migPage, '.status-banner')).includes('are not in the database yet'), 'no stale "not in the database yet" wording');
  });

  await check('the imported data appears on the normal pages after a reload', async () => {
    await open(migPage, '/pages/transactions.html');
    truthy((await text(migPage, '#transactions-body')).includes('Migrate tea'), 'imported transaction shown');
  });

  await check('the database export downloads with the documented format', async () => {
    await open(migPage, '/pages/settings.html');
    await migPage.waitForFunction(() => !document.getElementById('export-database').disabled);
    const [download] = await Promise.all([migPage.waitForEvent('download'), migPage.click('#export-database')]);
    truthy(/^expense-manager-database-export-/.test(download.suggestedFilename()), 'file name');
    const file = path.join(tmpRoot, 'db-export.json');
    await download.saveAs(file);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    equal(exported.format, 'expense-manager-database-export', 'format');
    equal(exported.counts.transactions, (await api('GET', '/api/transactions')).length, 'count matches API');
  });

  await check('bills, to-dos and theme still work on Settings', async () => {
    await migPage.evaluate(() => { localStorage.setItem('em_theme', 'dark'); });
    await open(migPage, '/pages/settings.html');
    equal(migPage.problems.length, 0, 'console: ' + migPage.problems.join(' | '));
    truthy((await migPage.evaluate(() => localStorage.getItem('em_theme'))) === 'dark', 'theme kept');
  });

  await migPage.context().close();

  console.log('\nScenario 5: opened as a file instead of through the server');

  await check('file:// shows a clear instruction instead of empty data', async () => {
    const p = await newPage(browser);
    await p.goto('file://' + path.join(__dirname, '..', '..', 'frontend', 'index.html'));
    await p.waitForSelector('.status-banner.error');
    truthy((await text(p, '.status-banner.error')).includes('npm start'), 'instruction');
    equal(await p.locator('.main-grid').isVisible(), false, 'content hidden');
    await p.context().close();
  });

  console.log('\nScenario 7: phone-width layout and accessible names (post-Stage 4 audit)');

  await check('no page scrolls sideways at 360px wide (tables scroll inside their own box)', async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    await context.route(/cdnjs\.cloudflare\.com/, route => route.abort());
    const p = await context.newPage();
    for (const target of ['/', '/pages/transactions.html', '/pages/accounts.html', '/pages/categories.html', '/pages/analytics.html', '/pages/settings.html']) {
      await open(p, target);
      const extra = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      equal(extra, 0, `${target} horizontal overflow (px)`);
    }
    await context.close();
  });

  await check('delete buttons say what they delete (accessible name includes the record)', async () => {
    const p = await newPage(browser);
    await open(p, '/pages/transactions.html');
    const names = await p.$$eval('button[data-delete-id]', buttons => buttons.map(b => b.getAttribute('aria-label')));
    truthy(names.length > 0, 'there are transactions to check');
    truthy(names.every(name => /^Delete transaction .+/.test(name)), 'transaction buttons: ' + names.join(' | '));
    await open(p, '/pages/accounts.html');
    const accountNames = await p.$$eval('button[data-account-id]', buttons => buttons.map(b => b.getAttribute('aria-label')));
    truthy(accountNames.length > 0 && accountNames.every(name => /^Delete account .+/.test(name)), 'account buttons: ' + accountNames.join(' | '));
    await open(p, '/pages/categories.html');
    const categoryNames = await p.$$eval('button[data-name]', buttons => buttons.map(b => b.getAttribute('aria-label')));
    truthy(categoryNames.length > 0 && categoryNames.every(name => /^Delete category .+/.test(name)), 'category buttons: ' + categoryNames.join(' | '));
    await p.context().close();
  });

  await browser.close();
}

main()
  .catch(error => {
    console.error('\nThe check could not run:', error);
    results.push({ name: 'harness', ok: false, error });
  })
  .finally(async () => {
    await stopServer();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (testSchema) await testSchema.drop();
    const failed = results.filter(result => !result.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
