const STORAGE_KEYS = {
  transactions: 'em_transactions',
  accounts: 'em_accounts',
  categories: 'em_categories',
  settings: 'em_settings',
  bills: 'em_bills',
  todos: 'em_todos'
};

const STORAGE_ERROR = 'Could not save your data. Browser storage may be disabled or full.';
const MAX_AMOUNT = 1000000000;

const DEFAULT_SETTINGS = {
  theme: 'light',
  currency: 'INR',
  dateFormat: 'DD/MM/YYYY',
  defaultType: 'expense',
  transactionNotifications: true,
  billReminders: true,
  monthlySummary: true,
  name: 'Siddharth Jain',
  email: 'Sid@example.com'
};

const DEFAULT_CATEGORIES = [
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

const DEFAULT_ACCOUNTS = [
  { id: 'acc-cash', name: 'Cash', type: 'cash', balance: 0 },
  { id: 'acc-bank', name: 'Bank Account', type: 'bank', balance: 0 }
];

const ACCOUNT_TYPES = {
  cash: { label: 'Cash', group: 'money' },
  bank: { label: 'Bank Account', group: 'money' },
  online: { label: 'Online Account', group: 'money' },
  asset: { label: 'Asset', group: 'asset' },
  receivable: { label: 'Money to Receive', group: 'receivable' },
  payable: { label: 'Money to Give', group: 'payable' }
};

const ACCOUNT_TYPE_KEYS = Object.keys(ACCOUNT_TYPES);
const MONEY_TYPES = ['cash', 'bank', 'online'];

const CURRENCY_LOCALES = {
  INR: 'en-IN',
  USD: 'en-US',
  EUR: 'en-IE',
  GBP: 'en-GB',
  JPY: 'en-US'
};

const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY/MM/DD'];

// ---------------------------------------------------------------------------
// Where the data lives
//
// Transactions, accounts and categories are stored in the database and reached
// through the API (see js/api.js). Each page keeps a copy in `store` so the
// existing render and calculation code can stay synchronous. The store is
// filled when a page opens and changed only AFTER the server confirms a change.
//
// Settings, bills and to-dos are not financial records and stay in localStorage.
//
// The old localStorage keys em_transactions, em_accounts and em_categories are
// never written or deleted by this file. They are only READ, to warn the user
// about data that has not been imported into the database yet.
// ---------------------------------------------------------------------------

const LOCAL_ONLY_KEYS = [STORAGE_KEYS.settings, STORAGE_KEYS.bills, STORAGE_KEYS.todos];

// The lists each page needs from the API.
const PAGE_DATA = {
  dashboard: ['accounts', 'transactions'],
  transactions: ['accounts', 'categories', 'transactions'],
  accounts: ['accounts', 'transactions'],
  categories: ['categories', 'transactions'],
  analytics: ['transactions'],
  settings: ['accounts', 'categories', 'transactions'] // counts for the migration panel, and the bell's monthly summary
};

const store = { accounts: [], categories: [], transactions: [] };

let settings = getSettings();
let toastTimer = null;
let updateNotifications = function () {};

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

function loadList(key, defaults, isValid) {
  const data = readStorage(key, null);

  if (Array.isArray(data)) {
    return data.filter(isValid);
  }

  const fresh = defaults.map(item => ({ ...item }));
  writeStorage(key, fresh);
  return fresh;
}

function isValidTransaction(item) {
  return Boolean(item)
    && typeof item.id === 'string'
    && (item.type === 'income' || item.type === 'expense')
    && typeof item.description === 'string'
    && typeof item.category === 'string'
    && typeof item.accountId === 'string'
    && typeof item.date === 'string'
    && typeof item.amount === 'number'
    && isFinite(item.amount)
    && item.amount > 0;
}

function isValidAccount(item) {
  return Boolean(item)
    && typeof item.id === 'string'
    && typeof item.name === 'string'
    && ACCOUNT_TYPE_KEYS.includes(item.type)
    && typeof item.balance === 'number'
    && isFinite(item.balance);
}

function isValidCategory(item) {
  return Boolean(item)
    && typeof item.name === 'string'
    && (item.type === 'income' || item.type === 'expense');
}

function isValidBill(item) {
  return Boolean(item)
    && typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.date === 'string'
    && typeof item.amount === 'number'
    && isFinite(item.amount)
    && item.amount > 0;
}

function isValidTodo(item) {
  return Boolean(item)
    && typeof item.id === 'string'
    && typeof item.text === 'string'
    && typeof item.done === 'boolean';
}

function getTransactions() {
  return store.transactions;
}

function getAccounts() {
  return store.accounts;
}

function getCategories() {
  return store.categories;
}

function getBills() {
  return loadList(STORAGE_KEYS.bills, [], isValidBill);
}

function getTodos() {
  return loadList(STORAGE_KEYS.todos, [], isValidTodo);
}

function getMoneyAccounts() {
  return getAccounts().filter(account => MONEY_TYPES.includes(account.type));
}

function getSettings() {
  const stored = readStorage(STORAGE_KEYS.settings, {});
  const merged = { ...DEFAULT_SETTINGS };

  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
      if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) {
        merged[key] = stored[key];
      }
    });
  }

  if (!['light', 'dark', 'system'].includes(merged.theme)) {
    merged.theme = DEFAULT_SETTINGS.theme;
  }

  if (!Object.keys(CURRENCY_LOCALES).includes(merged.currency)) {
    merged.currency = DEFAULT_SETTINGS.currency;
  }

  if (!DATE_FORMATS.includes(merged.dateFormat)) {
    merged.dateFormat = DEFAULT_SETTINGS.dateFormat;
  }

  if (!['income', 'expense'].includes(merged.defaultType)) {
    merged.defaultType = DEFAULT_SETTINGS.defaultType;
  }

  return merged;
}

function updateSettings(changes) {
  settings = { ...settings, ...changes };
  return writeStorage(STORAGE_KEYS.settings, settings);
}

function applyTheme() {
  const prefersDark = Boolean(window.matchMedia)
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = settings.theme === 'dark' || (settings.theme === 'system' && prefersDark);

  document.documentElement.setAttribute('data-theme', useDark ? 'dark' : 'light');
}

function generateId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHTML(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, character => entities[character]);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function parseAmount(rawValue, allowZero) {
  if (String(rawValue).trim() === '') {
    return null;
  }

  const amount = roundMoney(Number(rawValue));

  if (!isFinite(amount) || amount > MAX_AMOUNT) {
    return null;
  }

  if (allowZero ? amount < 0 : amount <= 0) {
    return null;
  }

  return amount;
}

function pluralize(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function setText(id, text) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = text;
  }
}

function formatCurrency(amount) {
  const formatter = new Intl.NumberFormat(CURRENCY_LOCALES[settings.currency], {
    style: 'currency',
    currency: settings.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });

  return formatter.format(amount);
}

function toISODate(date) {
  return date.getFullYear()
    + '-' + String(date.getMonth() + 1).padStart(2, '0')
    + '-' + String(date.getDate()).padStart(2, '0');
}

function todayISO() {
  return toISODate(new Date());
}

function offsetDateISO(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function formatDate(isoDate) {
  const parts = String(isoDate).split('-');

  if (parts.length !== 3) {
    return isoDate;
  }

  const [year, month, day] = parts;

  if (settings.dateFormat === 'MM/DD/YYYY') {
    return month + '/' + day + '/' + year;
  }

  if (settings.dateFormat === 'YYYY/MM/DD') {
    return year + '/' + month + '/' + day;
  }

  return day + '/' + month + '/' + year;
}

function getMonthKey(isoDate) {
  return isoDate.slice(0, 7);
}

function getRecentMonths(count) {
  const months = [];
  const now = new Date();

  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    const label = date.toLocaleString('en-US', { month: 'short' }) + ' ' + String(date.getFullYear()).slice(2);

    months.push({ key, label });
  }

  return months;
}

function sumAmounts(list) {
  return roundMoney(list.reduce((sum, item) => sum + item.amount, 0));
}

function getTotals(transactions) {
  const income = sumAmounts(transactions.filter(item => item.type === 'income'));
  const expense = sumAmounts(transactions.filter(item => item.type === 'expense'));

  return { income, expense, balance: roundMoney(income - expense) };
}

function getAccountBalance(account, transactions) {
  let balance = account.balance;

  transactions.forEach(item => {
    if (item.accountId === account.id) {
      balance += item.type === 'income' ? item.amount : -item.amount;
    }
  });

  return roundMoney(balance);
}

function getTotalBalance() {
  const transactions = getTransactions();

  return roundMoney(
    getMoneyAccounts().reduce((sum, account) => sum + getAccountBalance(account, transactions), 0)
  );
}

function getAccountName(accounts, accountId) {
  const account = accounts.find(item => item.id === accountId);
  return account ? account.name : 'Unknown account';
}

function getCategoryTotals(transactions, type) {
  const totals = new Map();

  transactions.filter(item => item.type === type).forEach(item => {
    const entry = totals.get(item.category) || { name: item.category, total: 0, count: 0 };
    entry.total += item.amount;
    entry.count += 1;
    totals.set(item.category, entry);
  });

  return Array.from(totals.values())
    .map(entry => ({ ...entry, total: roundMoney(entry.total) }))
    .sort((a, b) => b.total - a.total);
}

function sortByNewest(list) {
  return list.slice().sort((a, b) => {
    return b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function showFormMessage(form, text, isError) {
  const element = form.querySelector('.form-message');

  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = 'form-message' + (text ? (isError ? ' error' : ' success') : '');
}

function showToast(message) {
  let toast = document.querySelector('.toast');

  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

function pageUrl(fileName) {
  return (document.body.dataset.page === 'dashboard' ? 'pages/' : '') + fileName;
}

function fillSelect(select, options, selectedValue) {
  select.innerHTML = options
    .map(option => `<option value="${escapeHTML(option.value)}">${escapeHTML(option.label)}</option>`)
    .join('');

  if (options.some(option => option.value === selectedValue)) {
    select.value = selectedValue;
  }
}

function showEmptyChart(container, message) {
  container.classList.remove('has-data');
  container.innerHTML = `<p class="empty-message">${escapeHTML(message)}</p>`;
}

function barHeight(value, max) {
  return value > 0 ? Math.max(Math.round(value / max * 100), 2) : 0;
}

function renderMonthlyChart(containerId, transactions) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  const data = getRecentMonths(6).map(month => {
    const totals = getTotals(transactions.filter(item => getMonthKey(item.date) === month.key));
    return { label: month.label, income: totals.income, expense: totals.expense };
  });

  const max = Math.max(...data.map(item => Math.max(item.income, item.expense)));

  if (max <= 0) {
    showEmptyChart(container, 'Add transactions to see income and expenses for the last 6 months.');
    return;
  }

  container.classList.add('has-data');
  container.innerHTML = `
    <div class="chart-legend">
      <span><i class="legend-swatch income-bar"></i>Income</span>
      <span><i class="legend-swatch expense-bar"></i>Expenses</span>
    </div>
    <div class="bar-chart">
      ${data.map(item => `
        <div class="bar-group">
          <div class="bar-pair">
            <div class="bar income-bar" style="height: ${barHeight(item.income, max)}%" title="Income: ${formatCurrency(item.income)}"></div>
            <div class="bar expense-bar" style="height: ${barHeight(item.expense, max)}%" title="Expenses: ${formatCurrency(item.expense)}"></div>
          </div>
          <span class="bar-label">${item.label}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCategoryChart(containerId, transactions, type) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  const items = getCategoryTotals(transactions, type);

  if (items.length === 0) {
    showEmptyChart(container, 'No ' + type + ' data to show yet.');
    return;
  }

  const sum = roundMoney(items.reduce((total, item) => total + item.total, 0));

  container.classList.add('has-data');
  container.innerHTML = '<div class="hbar-chart">' + items.map(item => `
    <div class="hbar-row">
      <span class="hbar-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span>
      <div class="hbar-track">
        <div class="hbar-fill ${type}-bar" style="width: ${Math.max(Math.round(item.total / items[0].total * 100), 2)}%"></div>
      </div>
      <span class="hbar-value">${formatCurrency(item.total)} (${Math.round(item.total / sum * 100)}%)</span>
    </div>
  `).join('') + '</div>';
}

function renderCategoryCards(container, type, manageable) {
  const totals = getCategoryTotals(getTransactions(), type);
  let items = totals;

  if (manageable) {
    const totalsByName = new Map(totals.map(item => [item.name, item]));

    items = getCategories()
      .filter(category => category.type === type)
      .map(category => totalsByName.get(category.name) || { name: category.name, total: 0, count: 0 });
  }

  if (items.length === 0) {
    container.innerHTML = `<p class="empty-message">No ${type} ${manageable ? 'categories' : 'transactions'} yet.</p>`;
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="card">
      <h3>${escapeHTML(item.name)}</h3>
      <p class="${type}">${formatCurrency(item.total)}</p>
      <p>${pluralize(item.count, 'transaction')}</p>
      ${manageable ? `<button type="button" class="btn-danger btn-small" data-name="${escapeHTML(item.name)}" data-type="${type}" aria-label="Delete category ${escapeHTML(item.name)}">Delete</button>` : ''}
    </div>
  `).join('');
}

function setupMenuToggle() {
  const button = document.querySelector('.menu-toggle');

  if (!button) {
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'menu-backdrop';
  document.body.appendChild(backdrop);

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    button.setAttribute('aria-expanded', String(open));
  }

  button.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
  backdrop.addEventListener('click', () => setMenu(false));

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      setMenu(false);
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      setMenu(false);
    }
  });
}

function setupNavbarSearch() {
  const form = document.querySelector('.navbar form');
  const input = document.getElementById('navbar-search');

  if (!form || !input) {
    return;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();

    const query = input.value.trim();

    if (document.body.dataset.page === 'transactions') {
      document.getElementById('filter-search').value = query;
      renderTransactionTable();
      return;
    }

    location.href = pageUrl('transactions.html') + (query ? '?search=' + encodeURIComponent(query) : '');
  });
}

function getNotifications() {
  const items = [];

  if (settings.billReminders) {
    const today = todayISO();
    const limit = offsetDateISO(7);

    getBills()
      .filter(bill => bill.date <= limit)
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach(bill => {
        let when = 'is due on ' + formatDate(bill.date);

        if (bill.date < today) {
          when = 'was due on ' + formatDate(bill.date);
        } else if (bill.date === today) {
          when = 'is due today';
        }

        items.push(`${bill.name} ${when} (${formatCurrency(bill.amount)})`);
      });
  }

  if (settings.monthlySummary) {
    const monthKey = todayISO().slice(0, 7);
    const monthTransactions = getTransactions().filter(item => getMonthKey(item.date) === monthKey);

    if (monthTransactions.length > 0) {
      const totals = getTotals(monthTransactions);
      items.push(`This month: ${formatCurrency(totals.income)} income and ${formatCurrency(totals.expense)} expenses.`);
    }
  }

  return items;
}

function setupNotifications() {
  const button = document.querySelector('.notification-button');

  if (!button) {
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'notification-panel';
  panel.hidden = true;
  button.insertAdjacentElement('afterend', panel);

  const badge = button.querySelector('.notification-count');

  updateNotifications = function () {
    const items = getNotifications();

    badge.textContent = items.length;
    badge.hidden = items.length === 0;

    panel.innerHTML = '<h3>Notifications</h3>' + (items.length > 0
      ? '<ul>' + items.map(item => `<li>${escapeHTML(item)}</li>`).join('') + '</ul>'
      : '<p>No new notifications.</p>');
  };

  updateNotifications();

  button.addEventListener('click', event => {
    event.stopPropagation();
    updateNotifications();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', event => {
    if (!panel.contains(event.target)) {
      panel.hidden = true;
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      panel.hidden = true;
    }
  });
}

function initLayout() {
  document.addEventListener('submit', event => event.preventDefault());

  document.addEventListener('input', event => {
    const form = event.target.closest('form');

    if (form) {
      showFormMessage(form, '', false);
    }
  });

  setupMenuToggle();
  setupNavbarSearch();
  setupNotifications();
}

function renderRecentTransactions() {
  const body = document.getElementById('recent-transactions-body');
  const recent = sortByNewest(getTransactions()).slice(0, 5);

  if (recent.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty-message">No transactions yet.</td></tr>';
    return;
  }

  body.innerHTML = recent.map(item => `
    <tr>
      <td>${formatDate(item.date)}</td>
      <td>${escapeHTML(item.description)}</td>
      <td>${escapeHTML(item.category)}</td>
      <td class="amount ${item.type}">${item.type === 'income' ? '+' : '-'}${formatCurrency(item.amount)}</td>
    </tr>
  `).join('');
}

function renderBills() {
  const list = document.getElementById('bill-list');
  const empty = document.getElementById('bill-empty');
  const bills = getBills().sort((a, b) => a.date.localeCompare(b.date));
  const today = todayISO();

  list.innerHTML = bills.map(bill => {
    const overdue = bill.date < today;

    return `
      <li class="${overdue ? 'overdue' : ''}">
        <h3>${escapeHTML(bill.name)}</h3>
        <p>${formatDate(bill.date)}${overdue ? ' (overdue)' : ''}</p>
        <p class="bill-amount">${formatCurrency(bill.amount)}</p>
        <button type="button" class="btn-danger btn-small" data-bill-id="${escapeHTML(bill.id)}">Remove</button>
      </li>
    `;
  }).join('');

  empty.hidden = bills.length > 0;
}

function initBills() {
  const form = document.getElementById('bill-form');
  const list = document.getElementById('bill-list');

  renderBills();

  form.addEventListener('submit', event => {
    event.preventDefault();

    const name = document.getElementById('bill-name').value.trim();
    const date = document.getElementById('bill-date').value;
    const amount = parseAmount(document.getElementById('bill-amount').value, false);

    if (!name) return showFormMessage(form, 'Please enter a name for the expense.', true);
    if (!date) return showFormMessage(form, 'Please choose a due date.', true);
    if (amount === null) return showFormMessage(form, 'Please enter an amount greater than zero.', true);

    const bills = getBills();
    bills.push({ id: generateId('bill'), name, date, amount });

    if (!writeStorage(STORAGE_KEYS.bills, bills)) return showFormMessage(form, STORAGE_ERROR, true);

    form.reset();
    renderBills();
    updateNotifications();
  });

  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-bill-id]');

    if (!button) {
      return;
    }

    writeStorage(STORAGE_KEYS.bills, getBills().filter(bill => bill.id !== button.dataset.billId));
    renderBills();
    updateNotifications();
  });
}

function renderTodos() {
  const list = document.getElementById('todo-items');
  const empty = document.getElementById('todo-empty');
  const todos = getTodos();

  list.innerHTML = todos.map(todo => `
    <li class="${todo.done ? 'done' : ''}">
      <label>
        <input type="checkbox" data-todo-id="${escapeHTML(todo.id)}" ${todo.done ? 'checked' : ''} />
        <span>${escapeHTML(todo.text)}</span>
      </label>
      <button type="button" class="btn-danger btn-small" data-todo-delete="${escapeHTML(todo.id)}" aria-label="Delete to-do ${escapeHTML(todo.text)}">Delete</button>
    </li>
  `).join('');

  empty.hidden = todos.length > 0;
}

function initTodos() {
  const form = document.getElementById('todo-form');
  const list = document.getElementById('todo-items');

  renderTodos();

  form.addEventListener('submit', event => {
    event.preventDefault();

    const input = document.getElementById('todo-text');
    const text = input.value.trim();

    if (!text) return showFormMessage(form, 'Please enter a task.', true);

    const todos = getTodos();
    todos.push({ id: generateId('todo'), text, done: false });

    if (!writeStorage(STORAGE_KEYS.todos, todos)) return showFormMessage(form, STORAGE_ERROR, true);

    input.value = '';
    renderTodos();
  });

  list.addEventListener('change', event => {
    const checkbox = event.target.closest('input[data-todo-id]');

    if (!checkbox) {
      return;
    }

    const todos = getTodos().map(todo => {
      return todo.id === checkbox.dataset.todoId ? { ...todo, done: checkbox.checked } : todo;
    });

    writeStorage(STORAGE_KEYS.todos, todos);
    renderTodos();
  });

  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-todo-delete]');

    if (!button) {
      return;
    }

    writeStorage(STORAGE_KEYS.todos, getTodos().filter(todo => todo.id !== button.dataset.todoDelete));
    renderTodos();
  });
}

function initDashboard() {
  const transactions = getTransactions();
  const totals = getTotals(transactions);
  const balance = getTotalBalance();
  const balanceElement = document.getElementById('total-balance');

  setText('total-expense', formatCurrency(totals.expense));
  setText('total-income', formatCurrency(totals.income));
  setText('total-balance', formatCurrency(balance));
  balanceElement.classList.toggle('expense', balance < 0);

  renderMonthlyChart('dashboard-chart', transactions);
  renderRecentTransactions();
  initBills();
  initTodos();
}

function fillCategoryOptions() {
  const type = document.getElementById('transaction-type').value;
  const select = document.getElementById('transaction-category');

  const options = getCategories()
    .filter(category => category.type === type)
    .map(category => ({ value: category.name, label: category.name }));

  fillSelect(
    select,
    options.length > 0 ? options : [{ value: '', label: 'No categories - add one first' }],
    select.value
  );
}

function fillAccountOptions() {
  const select = document.getElementById('account');
  const transactions = getTransactions();

  const options = getMoneyAccounts().map(account => ({
    value: account.id,
    label: `${account.name} (${formatCurrency(getAccountBalance(account, transactions))})`
  }));

  fillSelect(
    select,
    options.length > 0 ? options : [{ value: '', label: 'No accounts - add one first' }],
    select.value
  );
}

function fillFilterOptions() {
  const categorySelect = document.getElementById('filter-category');
  const accountSelect = document.getElementById('filter-account');

  const names = Array.from(new Set(getCategories().map(category => category.name)))
    .sort((a, b) => a.localeCompare(b));

  fillSelect(
    categorySelect,
    [{ value: '', label: 'All' }, ...names.map(name => ({ value: name, label: name }))],
    categorySelect.value
  );

  fillSelect(
    accountSelect,
    [{ value: '', label: 'All' }, ...getMoneyAccounts().map(account => ({ value: account.id, label: account.name }))],
    accountSelect.value
  );
}

// The filter form's values, in the form the API understands (empty = no filter).
function readTransactionFilters() {
  const type = document.getElementById('filter-type').value;

  return {
    search: document.getElementById('filter-search').value.trim(),
    type: type === 'all' ? '' : type,
    category: document.getElementById('filter-category').value,
    accountId: document.getElementById('filter-account').value
  };
}

// Each call gets a number. If the user changes a filter while an answer is
// still on its way, the older answer arrives late and is ignored.
let transactionRequestNumber = 0;

// The server does the filtering and adds up the totals (GET /api/transactions
// and GET /api/summary with the same filters); this only draws the answer.
async function renderTransactionTable() {
  const body = document.getElementById('transactions-body');
  const summary = document.getElementById('transaction-summary');
  const accounts = getAccounts();
  const allCount = getTransactions().length;
  const requestNumber = ++transactionRequestNumber;
  const filters = readTransactionFilters();

  let list;
  let totals;

  try {
    [list, { totals }] = await Promise.all([Api.listTransactions(filters), Api.getSummary(filters)]);
  } catch (error) {
    if (requestNumber !== transactionRequestNumber) {
      return;
    }

    body.innerHTML = `<tr><td colspan="8" class="empty-message">${escapeHTML(errorText(error))}</td></tr>`;
    summary.textContent = '';
    return;
  }

  if (requestNumber !== transactionRequestNumber) {
    return; // a newer filter change has been made since
  }

  if (list.length === 0) {
    const message = allCount > 0
      ? 'No transactions match your filters.'
      : 'No transactions yet. Add your first transaction above.';

    body.innerHTML = `<tr><td colspan="8" class="empty-message">${message}</td></tr>`;
    summary.textContent = '';
    return;
  }

  body.innerHTML = list.map(item => `
    <tr>
      <td>${formatDate(item.date)}</td>
      <td>${escapeHTML(item.description)}</td>
      <td>${escapeHTML(item.category)}</td>
      <td>${item.type === 'income' ? 'Income' : 'Expense'}</td>
      <td>${escapeHTML(getAccountName(accounts, item.accountId))}</td>
      <td class="amount ${item.type}">${item.type === 'income' ? '+' : '-'}${formatCurrency(item.amount)}</td>
      <td>${escapeHTML(item.note || '')}</td>
      <td><button type="button" class="btn-danger btn-small" data-delete-id="${escapeHTML(item.id)}" aria-label="Delete transaction ${escapeHTML(item.description)}">Delete</button></td>
    </tr>
  `).join('');

  summary.textContent = `Showing ${totals.count} of ${allCount} transactions | Income: ${formatCurrency(totals.income)} | Expenses: ${formatCurrency(totals.expense)}`;
}

// Typing in the search box would otherwise send a request per key press.
let transactionFilterTimer = null;

function renderTransactionTableSoon() {
  clearTimeout(transactionFilterTimer);
  transactionFilterTimer = setTimeout(renderTransactionTable, 150);
}

function refreshTransactionsPage() {
  fillCategoryOptions();
  fillAccountOptions();
  fillFilterOptions();
  renderTransactionTable();
}

async function handleAddTransaction(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const description = document.getElementById('description').value.trim();
  const type = document.getElementById('transaction-type').value;
  const category = document.getElementById('transaction-category').value;
  const accountId = document.getElementById('account').value;
  const amount = parseAmount(document.getElementById('amount').value, false);
  const date = document.getElementById('transaction-date').value;
  const note = document.getElementById('note').value.trim();

  if (!description) return showFormMessage(form, 'Please enter a description.', true);

  // The form lists category NAMES; the API wants the category's id.
  const categoryRecord = getCategories().find(item => item.type === type && item.name === category);

  if (!categoryRecord) {
    return showFormMessage(form, 'Please select a category. Add one on the Categories page if the list is empty.', true);
  }

  if (!getMoneyAccounts().some(item => item.id === accountId)) {
    return showFormMessage(form, 'Please select an account. Add one on the Accounts page if the list is empty.', true);
  }

  if (amount === null) return showFormMessage(form, 'Please enter an amount greater than zero.', true);
  if (!date) return showFormMessage(form, 'Please choose a date.', true);
  if (date > todayISO()) return showFormMessage(form, 'The date cannot be in the future.', true);

  await submitWithBusy(form, async () => {
    try {
      const created = await Api.createTransaction({
        type,
        description,
        categoryId: categoryRecord.id,
        accountId,
        amount,
        note,
        date
      });
      store.transactions.push(created);
    } catch (error) {
      // The form keeps what the user typed so they can fix it and retry.
      showFormMessage(form, errorText(error), true);
      if (needsResync(error)) await resync(refreshTransactionsPage);
      return;
    }

    ['description', 'amount', 'note'].forEach(id => {
      document.getElementById(id).value = '';
    });

    fillAccountOptions();
    renderTransactionTable();
    updateNotifications();
    showFormMessage(form, 'Transaction added.', false);

    if (settings.transactionNotifications) {
      showToast('Transaction added');
    }
  });
}

async function handleDeleteTransaction(event) {
  const button = event.target.closest('button[data-delete-id]');

  if (!button || button.disabled || !confirm('Delete this transaction?')) {
    return;
  }

  const id = button.dataset.deleteId;
  let alreadyGone = false;
  button.disabled = true;

  try {
    await Api.deleteTransaction(id);
  } catch (error) {
    if (!isGone(error)) {
      button.disabled = false;
      showToast(errorText(error));
      return;
    }
    alreadyGone = true; // deleted elsewhere (for example in another tab)
    showToast('That transaction no longer exists.');
  }

  store.transactions = store.transactions.filter(item => item.id !== id);

  fillAccountOptions();
  renderTransactionTable();
  updateNotifications();

  if (!alreadyGone && settings.transactionNotifications) {
    showToast('Transaction deleted');
  }
}

function initTransactions() {
  const addForm = document.querySelector('.add-transaction-form');
  const filterForm = document.querySelector('.transaction-filters-form');
  const typeSelect = document.getElementById('transaction-type');
  const dateInput = document.getElementById('transaction-date');

  typeSelect.value = settings.defaultType;
  dateInput.value = todayISO();
  dateInput.max = todayISO();

  fillCategoryOptions();
  fillAccountOptions();
  fillFilterOptions();

  const initialSearch = new URLSearchParams(location.search).get('search');

  if (initialSearch) {
    document.getElementById('filter-search').value = initialSearch;
    document.getElementById('navbar-search').value = initialSearch;
  }

  // Drawn from the server's answer. startPage() waits for it, so the page is not
  // shown with a placeholder table first.
  const firstRender = renderTransactionTable();

  typeSelect.addEventListener('change', fillCategoryOptions);
  addForm.addEventListener('submit', handleAddTransaction);

  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    renderTransactionTable();
  });

  filterForm.addEventListener('input', renderTransactionTableSoon);

  document.getElementById('filter-clear').addEventListener('click', () => {
    filterForm.reset();
    document.getElementById('navbar-search').value = '';
    renderTransactionTable();
  });

  document.getElementById('transactions-body').addEventListener('click', handleDeleteTransaction);

  return firstRender;
}

function renderCategories() {
  renderCategoryCards(document.getElementById('expense-categories'), 'expense', true);
  renderCategoryCards(document.getElementById('income-categories'), 'income', true);
}

async function handleCategoryDelete(event) {
  const button = event.target.closest('button[data-name]');

  if (!button || button.disabled) {
    return;
  }

  const { name, type } = button.dataset;
  const category = getCategories().find(item => item.type === type && item.name === name);

  if (!category) {
    return;
  }

  const used = getTransactions().filter(item => item.type === type && item.category === name).length;

  if (used > 0) {
    showToast(`"${name}" is used by ${pluralize(used, 'transaction')} and cannot be deleted.`);
    return;
  }

  if (!confirm(`Delete the category "${name}"?`)) {
    return;
  }

  button.disabled = true;

  try {
    await Api.deleteCategory(category.id);
  } catch (error) {
    if (!isGone(error)) {
      button.disabled = false;
      showToast(errorText(error)); // for example: used by a transaction added elsewhere
      if (needsResync(error)) await resync(renderCategories);
      return;
    }
    showToast('That category no longer exists.');
  }

  store.categories = store.categories.filter(item => item.id !== category.id);
  renderCategories();
}

function initCategories() {
  const form = document.querySelector('.add-category-form');

  renderCategories();

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const nameInput = document.getElementById('category-name');
    const type = document.getElementById('category-type').value;
    const name = nameInput.value.trim();

    if (!name) return showFormMessage(form, 'Please enter a category name.', true);
    if (type !== 'income' && type !== 'expense') return showFormMessage(form, 'Please choose a category type.', true);

    const exists = getCategories().some(item => item.type === type && item.name.toLowerCase() === name.toLowerCase());

    if (exists) return showFormMessage(form, `The ${type} category "${name}" already exists.`, true);

    await submitWithBusy(form, async () => {
      try {
        store.categories.push(await Api.createCategory({ name, type }));
      } catch (error) {
        showFormMessage(form, errorText(error), true);
        if (needsResync(error)) await resync(renderCategories);
        return;
      }

      nameInput.value = '';
      renderCategories();
      showFormMessage(form, 'Category added.', false);
    });
  });

  document.getElementById('expense-categories').addEventListener('click', handleCategoryDelete);
  document.getElementById('income-categories').addEventListener('click', handleCategoryDelete);
}

function renderAccountGroup(containerId, list, emptyText) {
  const container = document.getElementById(containerId);

  if (list.length === 0) {
    container.innerHTML = `<p class="empty-message">${emptyText}</p>`;
    return;
  }

  container.innerHTML = list.map(account => `
    <div class="card">
      <h3>${escapeHTML(account.name)}</h3>
      <p class="${account.current < 0 ? 'expense' : ''}">${formatCurrency(account.current)}</p>
      <p>${ACCOUNT_TYPES[account.type].label}</p>
      <button type="button" class="btn-danger btn-small" data-account-id="${escapeHTML(account.id)}" aria-label="Delete account ${escapeHTML(account.name)}">Delete</button>
    </div>
  `).join('');
}

function renderAccounts() {
  const transactions = getTransactions();

  const accounts = getAccounts().map(account => ({
    ...account,
    current: MONEY_TYPES.includes(account.type) ? getAccountBalance(account, transactions) : account.balance
  }));

  const inGroup = group => accounts.filter(account => ACCOUNT_TYPES[account.type].group === group);
  const sumGroup = group => roundMoney(inGroup(group).reduce((sum, account) => sum + account.current, 0));

  const available = sumGroup('money');
  const assets = sumGroup('asset');
  const receivable = sumGroup('receivable');
  const payable = sumGroup('payable');
  const totalAssets = roundMoney(available + assets + receivable);
  const net = roundMoney(totalAssets - payable);

  setText('position-available', formatCurrency(available));
  setText('position-assets', formatCurrency(totalAssets));
  setText('position-liabilities', formatCurrency(payable));
  setText('position-net', formatCurrency(net));
  document.getElementById('position-net').classList.toggle('expense', net < 0);

  renderAccountGroup('money-accounts', inGroup('money'), 'No money accounts yet. Add a cash, bank or online account below.');
  renderAccountGroup('asset-accounts', inGroup('asset'), 'No assets added yet.');
  renderAccountGroup('receivable-accounts', inGroup('receivable'), 'Nobody owes you money.');
  renderAccountGroup('payable-accounts', inGroup('payable'), 'You do not owe anyone money.');
}

async function handleAccountDelete(event) {
  const button = event.target.closest('button[data-account-id]');

  if (!button || button.disabled) {
    return;
  }

  const accountId = button.dataset.accountId;
  const account = getAccounts().find(item => item.id === accountId);

  if (!account) {
    return;
  }

  const used = getTransactions().filter(item => item.accountId === accountId).length;

  if (used > 0) {
    showToast(`"${account.name}" is used by ${pluralize(used, 'transaction')} and cannot be deleted.`);
    return;
  }

  if (!confirm(`Delete the account "${account.name}"?`)) {
    return;
  }

  button.disabled = true;

  try {
    await Api.deleteAccount(accountId);
  } catch (error) {
    if (!isGone(error)) {
      button.disabled = false;
      showToast(errorText(error));
      if (needsResync(error)) await resync(renderAccounts);
      return;
    }
    showToast('That account no longer exists.');
  }

  store.accounts = store.accounts.filter(item => item.id !== accountId);
  renderAccounts();
}

function initAccounts() {
  const form = document.querySelector('.add-account-form');

  renderAccounts();

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const nameInput = document.getElementById('account-name');
    const amountInput = document.getElementById('account-amount');
    const type = document.getElementById('account-type').value;
    const name = nameInput.value.trim();
    const balance = parseAmount(amountInput.value, true);

    if (!name) return showFormMessage(form, 'Please enter an account name.', true);
    if (!ACCOUNT_TYPE_KEYS.includes(type)) return showFormMessage(form, 'Please choose an account type.', true);
    if (balance === null) return showFormMessage(form, 'Please enter a valid amount (zero or more).', true);

    if (getAccounts().some(item => item.name.toLowerCase() === name.toLowerCase())) {
      return showFormMessage(form, `An account named "${name}" already exists.`, true);
    }

    await submitWithBusy(form, async () => {
      try {
        store.accounts.push(await Api.createAccount({ name, type, balance }));
      } catch (error) {
        showFormMessage(form, errorText(error), true);
        if (needsResync(error)) await resync(renderAccounts);
        return;
      }

      nameInput.value = '';
      amountInput.value = '';
      renderAccounts();
      showFormMessage(form, 'Account added.', false);
    });
  });

  ['money-accounts', 'asset-accounts', 'receivable-accounts', 'payable-accounts'].forEach(id => {
    document.getElementById(id).addEventListener('click', handleAccountDelete);
  });
}

function renderTopTables(transactions) {
  const expenseBody = document.getElementById('top-expenses-body');
  const incomeBody = document.getElementById('top-income-body');

  const topExpenses = transactions
    .filter(item => item.type === 'expense')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const topIncome = getCategoryTotals(transactions, 'income').slice(0, 5);

  expenseBody.innerHTML = topExpenses.length > 0
    ? topExpenses.map((item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHTML(item.description)}</td>
          <td>${escapeHTML(item.category)}</td>
          <td class="amount expense">${formatCurrency(item.amount)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="empty-message">No expenses yet.</td></tr>';

  incomeBody.innerHTML = topIncome.length > 0
    ? topIncome.map((item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHTML(item.name)}</td>
          <td class="amount income">${formatCurrency(item.total)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="empty-message">No income yet.</td></tr>';
}

function fillTypeAnalysis(transactions, type) {
  const list = transactions.filter(item => item.type === type);
  const total = sumAmounts(list);
  const highest = list.reduce((max, item) => Math.max(max, item.amount), 0);
  const average = list.length > 0 ? roundMoney(total / list.length) : 0;

  setText(type + '-total', formatCurrency(total));
  setText(type + '-average', formatCurrency(average));
  setText(type + '-highest', formatCurrency(highest));
  setText(type + '-count', pluralize(list.length, 'Transaction'));
}

function initAnalytics() {
  const transactions = getTransactions();
  const [lastMonth, thisMonth] = getRecentMonths(2);
  const monthTotals = key => getTotals(transactions.filter(item => getMonthKey(item.date) === key));
  const current = monthTotals(thisMonth.key);
  const previous = monthTotals(lastMonth.key);
  const overall = getTotals(transactions);

  setText('month-income', 'Income: ' + formatCurrency(current.income));
  setText('month-expense', 'Expenses: ' + formatCurrency(current.expense));
  setText('last-month-income', 'Income: ' + formatCurrency(previous.income));
  setText('last-month-expense', 'Expenses: ' + formatCurrency(previous.expense));
  setText('net-balance', formatCurrency(overall.balance));
  document.getElementById('net-balance').classList.toggle('expense', overall.balance < 0);

  fillTypeAnalysis(transactions, 'expense');
  fillTypeAnalysis(transactions, 'income');

  renderMonthlyChart('trend-chart', transactions);
  renderCategoryChart('expense-chart', transactions, 'expense');
  renderCategoryChart('income-chart', transactions, 'income');

  renderCategoryCards(document.getElementById('analytics-expense-categories'), 'expense', false);
  renderCategoryCards(document.getElementById('analytics-income-categories'), 'income', false);

  renderTopTables(transactions);
}

function renderSettingsSummary() {
  setText('info-name', 'Name: ' + settings.name);
  setText('info-email', 'Email: ' + settings.email);
  setText('pref-currency', settings.currency);
  setText('pref-date-format', settings.dateFormat);
  setText('pref-type', settings.defaultType === 'income' ? 'Income' : 'Expense');
}

function initSettings() {
  const accountForm = document.querySelector('.update-account-form');
  const appearanceForm = document.querySelector('.appearance-change-form');
  const notificationForm = document.querySelector('.notification-settings-form');
  const preferencesForm = document.querySelector('.update-preferences-form');

  document.getElementById('theme-select').value = settings.theme;
  document.getElementById('transaction-notification').value = settings.transactionNotifications ? 'on' : 'off';
  document.getElementById('bill-reminders').value = settings.billReminders ? 'on' : 'off';
  document.getElementById('monthly-summary').value = settings.monthlySummary ? 'on' : 'off';
  document.getElementById('default-currency').value = settings.currency;
  document.getElementById('date-format').value = settings.dateFormat;
  document.getElementById('default-transaction-type').value = settings.defaultType;

  renderSettingsSummary();

  accountForm.addEventListener('submit', event => {
    event.preventDefault();

    const nameInput = document.getElementById('update-name');
    const emailInput = document.getElementById('update-email');
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();

    if (!name && !email) return showFormMessage(accountForm, 'Enter a new name or email to update.', true);
    if (email && !emailInput.checkValidity()) return showFormMessage(accountForm, 'Please enter a valid email address.', true);

    const changes = {};

    if (name) changes.name = name;
    if (email) changes.email = email;

    if (!updateSettings(changes)) return showFormMessage(accountForm, STORAGE_ERROR, true);

    accountForm.reset();
    renderSettingsSummary();
    showFormMessage(accountForm, 'Account information updated.', false);
  });

  appearanceForm.addEventListener('submit', event => {
    event.preventDefault();

    if (!updateSettings({ theme: document.getElementById('theme-select').value })) {
      return showFormMessage(appearanceForm, STORAGE_ERROR, true);
    }

    applyTheme();
    showFormMessage(appearanceForm, 'Appearance settings saved.', false);
  });

  notificationForm.addEventListener('submit', event => {
    event.preventDefault();

    const saved = updateSettings({
      transactionNotifications: document.getElementById('transaction-notification').value === 'on',
      billReminders: document.getElementById('bill-reminders').value === 'on',
      monthlySummary: document.getElementById('monthly-summary').value === 'on'
    });

    if (!saved) return showFormMessage(notificationForm, STORAGE_ERROR, true);

    updateNotifications();
    showFormMessage(notificationForm, 'Notification settings saved.', false);
  });

  preferencesForm.addEventListener('submit', event => {
    event.preventDefault();

    const saved = updateSettings({
      currency: document.getElementById('default-currency').value,
      dateFormat: document.getElementById('date-format').value,
      defaultType: document.getElementById('default-transaction-type').value
    });

    if (!saved) return showFormMessage(preferencesForm, STORAGE_ERROR, true);

    renderSettingsSummary();
    updateNotifications();
    showFormMessage(preferencesForm, 'Preferences saved.', false);
  });

  initMigrationPanel();

  // Resets only what is stored in this browser for non-financial features.
  // Transactions, accounts and categories live in the database and are not
  // touched (and the old financial localStorage keys are never removed).
  document.getElementById('reset-data').addEventListener('click', () => {
    if (!confirm('This will reset your settings, bills and to-do items. Your transactions, accounts and categories are stored in the database and will NOT be deleted. Continue?')) {
      return;
    }

    try {
      LOCAL_ONLY_KEYS.forEach(key => localStorage.removeItem(key));
    } catch (error) {
      showToast('Could not reset the data.');
      return;
    }

    location.reload();
  });
}

// ---------------------------------------------------------------------------
// Talking to the API
// ---------------------------------------------------------------------------

// Fills the store with the lists a page needs. All requests must succeed, or the
// store is left exactly as it was.
async function loadFinancialData(names) {
  const loaders = {
    accounts: Api.listAccounts,
    categories: Api.listCategories,
    transactions: Api.listTransactions
  };
  const results = await Promise.all(names.map(name => loaders[name]()));

  names.forEach((name, index) => {
    store[name] = results[index];
  });
}

// Text that is safe to show to the user. ApiError messages are already safe.
function errorText(error) {
  if (error instanceof ApiError) {
    return error.message;
  }

  console.error(error);
  return 'Something went wrong. Please try again.';
}

// The record was already removed (for example in another tab).
function isGone(error) {
  return error instanceof ApiError && error.status === 404;
}

// After these errors our copy of the data may be out of date, so reload it.
function needsResync(error) {
  return error instanceof ApiError
    && (error.status === 404
      || error.status === 409
      || error.details.some(item => item.field === 'categoryId' || item.field === 'accountId'));
}

async function resync(rerender) {
  try {
    await loadFinancialData(PAGE_DATA[document.body.dataset.page]);
    rerender();
    updateNotifications();
  } catch (error) {
    // The original error is already on screen; nothing more to say.
  }
}

// Runs a save for a form. A second submit while the first is still running is
// ignored, and the form's submit buttons stay disabled until it finishes.
async function submitWithBusy(form, task) {
  if (form.dataset.busy === 'true') {
    return;
  }

  const buttons = form.querySelectorAll('button[type="submit"]');

  form.dataset.busy = 'true';
  buttons.forEach(button => { button.disabled = true; });

  try {
    await task();
  } finally {
    delete form.dataset.busy;
    buttons.forEach(button => { button.disabled = false; });
  }
}

// ---------------------------------------------------------------------------
// Banners: loading, backend problems, and data from the old version
// ---------------------------------------------------------------------------

function setBanner(id, text, { kind = 'info', actions = [] } = {}) {
  const header = document.querySelector('main > header');

  if (!header) {
    return;
  }

  let area = document.querySelector('.status-banners');

  if (!area) {
    area = document.createElement('div');
    area.className = 'status-banners';
    header.insertAdjacentElement('afterend', area);
  }

  let banner = area.querySelector(`[data-banner="${id}"]`);

  if (!banner) {
    banner = document.createElement('div');
    banner.dataset.banner = id;
    area.appendChild(banner);
  }

  banner.className = 'status-banner ' + kind;
  banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  banner.textContent = '';

  const message = document.createElement('p');
  message.textContent = text;
  banner.appendChild(message);

  actions.forEach(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary btn-small';
    button.textContent = action.label;
    button.addEventListener('click', () => action.onClick(button));
    banner.appendChild(button);
  });
}

function clearBanner(id) {
  const banner = document.querySelector(`.status-banners [data-banner="${id}"]`);

  if (banner) {
    banner.remove();
  }
}

// ---------------------------------------------------------------------------
// Old browser data (read only) and moving it into the database
//
// The previous version of the app kept transactions, accounts and categories in
// localStorage. Everything in this section only READS those keys. Nothing here
// ever writes, changes or removes them, not even after a successful import.
// ---------------------------------------------------------------------------

const LEGACY_BACKUP_FORMAT = 'expense-manager-legacy-backup';
const LEGACY_BACKUP_VERSION = 1;

// An account or category that is exactly one of the defaults the old version
// wrote on its first run is not something the user created.
function isDefaultLegacyAccount(account) {
  return DEFAULT_ACCOUNTS.some(item => item.id === account.id && item.name === account.name
    && item.type === account.type && item.balance === account.balance);
}

function isDefaultLegacyCategory(category) {
  return DEFAULT_CATEGORIES.some(item => item.name === category.name && item.type === category.type);
}

const LEGACY_ENTITIES = [
  { name: 'accounts', key: STORAGE_KEYS.accounts, label: 'Accounts', one: 'Account', isValid: isValidAccount, isDefault: isDefaultLegacyAccount },
  { name: 'categories', key: STORAGE_KEYS.categories, label: 'Categories', one: 'Category', isValid: isValidCategory, isDefault: isDefaultLegacyCategory },
  { name: 'transactions', key: STORAGE_KEYS.transactions, label: 'Transactions', one: 'Transaction', isValid: isValidTransaction, isDefault: () => false }
];

// Reads the three old keys exactly as stored. A value that cannot be read, is
// not valid JSON, or is not a list is reported in `problems` (and its raw text
// kept in `unreadable`) instead of being silently treated as "no records".
function readLegacyStorage() {
  const result = { records: { accounts: [], categories: [], transactions: [] }, problems: [], unreadable: {} };

  LEGACY_ENTITIES.forEach(entity => {
    let raw;

    try {
      raw = localStorage.getItem(entity.key);
    } catch (error) {
      result.problems.push({ key: entity.key, kind: 'inaccessible', message: 'Browser storage could not be read.' });
      return;
    }

    if (raw === null) {
      return;
    }

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      result.problems.push({ key: entity.key, kind: 'unreadable', message: 'The stored text is not valid JSON.' });
      result.unreadable[entity.key] = raw;
      return;
    }

    if (!Array.isArray(parsed)) {
      result.problems.push({ key: entity.key, kind: 'not-a-list', message: 'The stored value is not a list of records.' });
      result.unreadable[entity.key] = raw;
      return;
    }

    result.records[entity.name] = parsed;
  });

  return result;
}

// What is in the old keys, per type: how many records are stored, how many are
// unchanged defaults, how many are malformed and how many are real user records.
function reviewLegacyData() {
  const legacy = readLegacyStorage();
  const entities = {};

  LEGACY_ENTITIES.forEach(entity => {
    const stored = legacy.records[entity.name];
    const valid = stored.filter(entity.isValid);
    const defaults = valid.filter(entity.isDefault).length;

    entities[entity.name] = {
      stored: stored.length,
      malformed: stored.length - valid.length,
      defaults,
      userRecords: valid.length - defaults
    };
  });

  return { entities, problems: legacy.problems };
}

// Counts the financial records the OLD version left in this browser (read-only).
function getLegacyFinancialSummary() {
  const { entities } = reviewLegacyData();

  return {
    transactions: entities.transactions.userRecords,
    accounts: entities.accounts.userRecords,
    categories: entities.categories.userRecords
  };
}

// The backup document. It contains the old records exactly as they are stored
// (unknown fields and malformed entries included) plus a note of anything that
// could not be read. The same document is what the import preview and the
// import send to the server. See docs/API.md for the format.
function buildLegacyBackup() {
  const legacy = readLegacyStorage();
  const backup = {
    format: LEGACY_BACKUP_FORMAT,
    version: LEGACY_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      app: 'Expense Manager (browser-only version)',
      origin: typeof location !== 'undefined' ? location.origin : undefined,
      storageKeys: LEGACY_ENTITIES.map(entity => entity.key)
    },
    complete: legacy.problems.length === 0,
    problems: legacy.problems,
    data: legacy.records
  };

  if (Object.keys(legacy.unreadable).length > 0) {
    backup.unreadable = legacy.unreadable;
  }

  return backup;
}

// Saves a JSON document through the browser's own download. The data never
// leaves the computer. The file name only contains letters, digits and dashes.
function downloadJson(baseName, document_) {
  const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `${baseName}-${todayISO()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Adds up the per-type counts of an import report.
function importTotals(report) {
  const totals = { toImport: 0, alreadyThere: 0, blocked: 0 };

  LEGACY_ENTITIES.forEach(entity => {
    const counts = report.counts[entity.name];

    totals.toImport += counts.imported;
    totals.alreadyThere += counts.duplicateInDatabase;
    totals.blocked += counts.rejected + counts.unresolvedReferences;
  });

  return totals;
}

const LEGACY_NOTICE_DISMISSED = 'em_legacy_notice_dismissed'; // sessionStorage, this tab only

function legacyFoundText(summary) {
  const parts = [];

  if (summary.transactions > 0) parts.push(pluralize(summary.transactions, 'transaction'));
  if (summary.accounts > 0) parts.push(pluralize(summary.accounts, 'account'));
  if (summary.categories > 0) parts.push(summary.categories === 1 ? '1 category' : `${summary.categories} categories`);

  return parts.join(', ');
}

// The yellow/blue notice at the top of every page while old records remain in
// this browser. It first shows what was found, then asks the server (a preview,
// which changes nothing) how those records compare with the database, so the
// wording stays true after an import: the browser copies are never removed, so
// the notice stays, but it says whether they still need importing.
async function renderLegacyNotice() {
  try {
    if (sessionStorage.getItem(LEGACY_NOTICE_DISMISSED) === '1') {
      return;
    }
  } catch (error) {
    // sessionStorage unavailable: show the notice every time.
  }

  const found = legacyFoundText(getLegacyFinancialSummary());

  if (!found) {
    return;
  }

  const dismiss = {
    label: 'Dismiss',
    onClick: () => {
      try {
        sessionStorage.setItem(LEGACY_NOTICE_DISMISSED, '1');
      } catch (error) {
        // Nothing to remember it with; just hide it now.
      }
      clearBanner('legacy-data');
    }
  };
  const review = {
    label: 'Review',
    onClick: () => { location.href = pageUrl('settings.html') + '#data-migration'; }
  };
  const intro = 'This browser still holds financial data from the previous version of the app: ' + found + '. ';
  const unchanged = 'The copies in this browser have not been changed or deleted.';

  setBanner('legacy-data', intro + unchanged + ' Checking them against the database...', { kind: 'warning', actions: [dismiss] });

  let totals = null;

  try {
    totals = importTotals(await Api.previewImport(buildLegacyBackup()));
  } catch (error) {
    totals = null; // the generic message below is still true
  }

  if (!document.querySelector('.status-banners [data-banner="legacy-data"]')) {
    return; // dismissed while the check was running
  }

  if (totals === null) {
    setBanner('legacy-data', intro + unchanged + ' Open Settings to review them and move them into the database.', { kind: 'warning', actions: [review, dismiss] });
  } else if (totals.toImport > 0) {
    setBanner('legacy-data', intro + pluralize(totals.toImport, 'record') + ' of them are not in the database yet, so they do not appear in the app. ' + unchanged, { kind: 'warning', actions: [review, dismiss] });
  } else if (totals.blocked > 0) {
    setBanner('legacy-data', intro + 'Everything that can be imported is already in the database, but ' + pluralize(totals.blocked, 'record') + ' cannot be imported (see Settings for the reasons). ' + unchanged, { kind: 'warning', actions: [review, dismiss] });
  } else {
    setBanner('legacy-data', intro + 'All of them are already in the database. ' + unchanged + ' This notice stays while they remain in this browser.', { kind: 'info', actions: [dismiss] });
  }
}

// ---------------------------------------------------------------------------
// Settings: "Move Data From the Old Version"
// Review -> backup -> preview -> explicit confirmation -> import -> report.
// ---------------------------------------------------------------------------

const migration = { dataReady: false, busy: false };

function makeElement(tag, text, className) {
  const element = document.createElement(tag);

  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;

  return element;
}

function migrationMessage(text, isError) {
  const panel = document.getElementById('migration-panel');

  if (panel) {
    showFormMessage(panel, text, isError);
  }
}

// Runs one action at a time; every button in the panel is disabled meanwhile.
async function runMigrationTask(task) {
  const panel = document.getElementById('migration-panel');

  if (migration.busy || !panel) {
    return;
  }

  migration.busy = true;
  panel.querySelectorAll('button, input').forEach(control => { control.disabled = true; });

  try {
    await task();
  } finally {
    migration.busy = false;
    panel.querySelectorAll('button, input').forEach(control => { control.disabled = false; });
    updateMigrationControls();
  }
}

function legacyHasRecords() {
  const summary = getLegacyFinancialSummary();
  return summary.transactions + summary.accounts + summary.categories > 0;
}

// Enables only what makes sense right now.
function updateMigrationControls() {
  const previewButton = document.getElementById('migration-preview-button');
  const databaseButton = document.getElementById('export-database');
  const confirmBox = document.getElementById('migration-confirm');
  const runButton = document.getElementById('migration-run');

  if (!previewButton || migration.busy) {
    return;
  }

  previewButton.disabled = !migration.dataReady || !legacyHasRecords();
  databaseButton.disabled = !migration.dataReady;

  if (runButton) {
    runButton.disabled = !(confirmBox && confirmBox.checked);
  }
}

function renderMigrationPanel() {
  const area = document.getElementById('migration-review');

  if (!area) {
    return;
  }

  const review = reviewLegacyData();
  const cards = makeElement('div', undefined, 'card-container');

  LEGACY_ENTITIES.forEach(entity => {
    const info = review.entities[entity.name];
    const card = makeElement('div', undefined, 'card');

    card.appendChild(makeElement('h3', entity.label));
    card.appendChild(makeElement('p', String(info.userRecords), 'migration-count'));
    card.appendChild(makeElement('p', 'found in this browser'));
    card.appendChild(makeElement('p', migration.dataReady ? `In the database: ${store[entity.name].length}` : 'In the database: not available'));

    if (info.defaults > 0) {
      card.appendChild(makeElement('p', `${info.defaults} unchanged default${info.defaults === 1 ? '' : 's'} of the old version (not counted)`));
    }
    if (info.malformed > 0) {
      card.appendChild(makeElement('p', `${info.malformed} malformed (cannot be imported)`, 'migration-warning'));
    }

    cards.appendChild(card);
  });

  area.textContent = '';
  area.appendChild(cards);

  review.problems.forEach(problem => {
    area.appendChild(makeElement('p', `${problem.key}: ${problem.message} It is kept in the backup file but cannot be imported.`, 'migration-warning'));
  });

  const found = legacyFoundText(getLegacyFinancialSummary());

  area.appendChild(makeElement(
    'p',
    found
      ? 'These records are still only in this browser\'s storage. They are not part of the database until you import them.'
      : 'No financial records from the old version were found in this browser.'
  ));

  if (!migration.dataReady) {
    area.appendChild(makeElement('p', 'The database could not be reached, so importing and the database export are unavailable. Use "Try again" above.', 'migration-warning'));
  }

  updateMigrationControls();
}

function counted(value) {
  return String(value);
}

// One row per record type. `mode` is 'preview' or 'import'.
function renderCountsTable(report, mode) {
  const wrapper = makeElement('div', undefined, 'table-container');
  const table = document.createElement('table');
  const head = document.createElement('tr');

  ['Records', 'Found', mode === 'import' ? 'Imported' : 'Will be imported', 'Already in database', 'Repeated in backup', 'Old defaults skipped', 'Rejected', 'Unresolved'].forEach(title => {
    const cell = makeElement('th', title);
    cell.scope = 'col';
    head.appendChild(cell);
  });

  const thead = document.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const body = document.createElement('tbody');

  LEGACY_ENTITIES.forEach(entity => {
    const counts = report.counts[entity.name];
    const row = document.createElement('tr');

    [entity.label, counts.received, counts.imported, counts.duplicateInDatabase, counts.duplicateInFile, counts.oldDefaultNotImported, counts.rejected, counts.unresolvedReferences]
      .forEach(value => row.appendChild(makeElement('td', counted(value))));
    body.appendChild(row);
  });

  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

// The records the server refused, with its reason for each.
function renderProblemList(report) {
  const problems = [];

  LEGACY_ENTITIES.forEach(entity => {
    report.items[entity.name]
      .filter(item => item.outcome === 'rejected' || item.outcome === 'unresolved-reference')
      .forEach(item => {
        const name = item.label || item.id || `#${item.index + 1}`;
        problems.push(`${entity.one} "${name}": ${item.reason}`);
      });
  });

  if (problems.length === 0) {
    return null;
  }

  const wrapper = makeElement('div');
  const list = makeElement('ul', undefined, 'migration-problems');

  wrapper.appendChild(makeElement('h4', `Records that cannot be imported (${problems.length})`));
  problems.slice(0, 50).forEach(text => list.appendChild(makeElement('li', text)));
  wrapper.appendChild(list);

  if (problems.length > 50) {
    wrapper.appendChild(makeElement('p', `Only the first 50 are listed here; the table above has the full counts.`));
  }
  if (report.items.transactionsTruncated) {
    wrapper.appendChild(makeElement('p', 'The server lists at most 200 transaction results; the counts are complete.'));
  }

  return wrapper;
}

function renderMigrationPreview(report) {
  const area = document.getElementById('migration-preview');
  const totals = importTotals(report);

  document.getElementById('migration-report').hidden = true;
  area.textContent = '';
  area.hidden = false;

  area.appendChild(makeElement('h3', 'Import preview'));
  area.appendChild(makeElement('p', 'Nothing has been changed yet. This is what an import would do right now, checked against the current database.'));
  area.appendChild(renderCountsTable(report, 'preview'));

  const problems = renderProblemList(report);

  if (problems) {
    area.appendChild(problems);
  }

  if (totals.toImport === 0) {
    area.appendChild(makeElement('p', totals.blocked > 0
      ? 'There is nothing new that can be imported. Fix the problems above (for example rename a clashing account) and preview again.'
      : 'There is nothing new to import: everything is already in the database.'));
    return;
  }

  const confirmBox = makeElement('div', undefined, 'migration-confirm');
  const statements = makeElement('ul');

  [
    `${pluralize(totals.toImport, 'record')} will be copied into the database.`,
    'Existing database records will not be overwritten.',
    'The records in this browser stay where they are, unchanged.',
    'Duplicates are skipped and invalid records are rejected; both are listed in the report.',
    'The import is all-or-nothing: if something unexpected fails, nothing is saved.',
    'Keep your backup file until you have checked the result.'
  ].forEach(text => statements.appendChild(makeElement('li', text)));
  confirmBox.appendChild(statements);

  const label = makeElement('label');
  const checkbox = document.createElement('input');

  checkbox.type = 'checkbox';
  checkbox.id = 'migration-confirm';
  checkbox.addEventListener('change', updateMigrationControls);
  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(` I have read this and want to import ${pluralize(totals.toImport, 'record')}.`));
  confirmBox.appendChild(label);

  const run = makeElement('button', 'Import Now');

  run.type = 'button';
  run.id = 'migration-run';
  run.disabled = true;
  run.addEventListener('click', runLegacyImport);
  confirmBox.appendChild(run);

  area.appendChild(confirmBox);
}

function renderMigrationReport(report, recheck) {
  const area = document.getElementById('migration-report');
  const totals = importTotals(report);
  const before = report.databaseBefore;
  const after = report.databaseAfter;

  document.getElementById('migration-preview').hidden = true;
  area.textContent = '';
  area.hidden = false;

  area.appendChild(makeElement('h3', report.complete ? 'Import complete' : 'Import finished partially'));
  area.appendChild(makeElement('p', report.complete
    ? (totals.toImport > 0
      ? `${pluralize(totals.toImport, 'record')} were saved to the database. Every other record was already there or was an unused default of the old version.`
      : 'Nothing new was imported: everything was already in the database.')
    : `${pluralize(totals.toImport, 'record')} were saved. ${pluralize(totals.blocked, 'record')} could not be imported and were left out (listed below). Nothing else was changed.`));
  area.appendChild(renderCountsTable(report, 'import'));

  const problems = renderProblemList(report);

  if (problems) {
    area.appendChild(problems);
  }

  area.appendChild(makeElement('h4', 'Verification'));

  const checks = makeElement('ul');

  checks.appendChild(makeElement('li', `Database before: ${before.accounts} accounts, ${before.categories} categories, ${before.transactions} transactions. After: ${after.accounts} accounts, ${after.categories} categories, ${after.transactions} transactions.`));
  checks.appendChild(makeElement('li', `Read-back check: ${report.verification.recordsMatching} of ${report.verification.recordsChecked} saved records were read back from the database and matched what was sent.`));
  checks.appendChild(makeElement('li', recheck
    ? `Fresh check of the old records against the database: ${recheck.toImport} still to import, ${recheck.alreadyThere} already in the database, ${recheck.blocked} cannot be imported.`
    : 'The fresh check of the old records against the database could not be run. Use "Preview Import" to run it.'));
  checks.appendChild(makeElement('li', 'The records in this browser were not changed or deleted.'));
  area.appendChild(checks);
  area.appendChild(makeElement('p', 'Keep your backup until you have compared the numbers above with the Dashboard, Accounts and Transactions pages.'));
}

async function runLegacyBackupDownload() {
  try {
    const backup = buildLegacyBackup();

    downloadJson('expense-manager-legacy-backup', backup);

    const total = LEGACY_ENTITIES.reduce((sum, entity) => sum + backup.data[entity.name].length, 0);

    if (!backup.complete) {
      migrationMessage('Backup downloaded, but it is NOT complete: some stored values could not be read as lists (see the notes above). Their raw text is included in the file.', true);
    } else {
      migrationMessage(total === 0
        ? 'Backup downloaded. This browser holds no old records, so the file has empty lists.'
        : `Backup downloaded (${pluralize(total, 'record')}, kept exactly as stored). This file is a backup only; it cannot be imported back into the app.`, false);
    }
  } catch (error) {
    console.error(error);
    migrationMessage('The backup could not be created. Nothing was changed.', true);
  }
}

async function runDatabaseExport() {
  await runMigrationTask(async () => {
    try {
      const exported = await Api.exportDatabase();

      downloadJson('expense-manager-database-export', exported);
      migrationMessage(`Database export downloaded: ${pluralize(exported.counts.accounts, 'account')}, ${exported.counts.categories === 1 ? '1 category' : exported.counts.categories + ' categories'}, ${pluralize(exported.counts.transactions, 'transaction')}. It is for backup and checking; it cannot be imported back into the app.`, false);
    } catch (error) {
      migrationMessage(errorText(error), true);
    }
  });
}

async function runMigrationPreview() {
  await runMigrationTask(async () => {
    migrationMessage('Checking the old records against the database...', false);

    try {
      renderMigrationPreview(await Api.previewImport(buildLegacyBackup()));
      migrationMessage('', false);
    } catch (error) {
      migrationMessage(errorText(error), true);
    }
  });
}

async function runLegacyImport() {
  await runMigrationTask(async () => {
    const confirmBox = document.getElementById('migration-confirm');

    // Only a ticked box starts an import (the button is also disabled otherwise).
    if (!confirmBox || !confirmBox.checked) {
      return;
    }

    migrationMessage('Importing...', false);

    let report;

    try {
      // The old data is read again here, and the server plans the import again
      // against the database as it is now. The earlier preview is not trusted.
      report = await Api.importLegacy(buildLegacyBackup());
    } catch (error) {
      migrationMessage(errorText(error), true);
      return;
    }

    let refreshed = true;

    try {
      await loadFinancialData(PAGE_DATA.settings);
    } catch (error) {
      refreshed = false;
    }

    let recheck = null;

    try {
      recheck = importTotals(await Api.previewImport(buildLegacyBackup()));
    } catch (error) {
      recheck = null;
    }

    renderMigrationReport(report, recheck);
    renderMigrationPanel();
    migrationMessage(refreshed
      ? (report.complete ? 'Import complete.' : 'Import finished partially. See the report below.')
      : 'The import finished, but the page could not reload the database counts. Reload the page.', !refreshed);

    try {
      sessionStorage.removeItem(LEGACY_NOTICE_DISMISSED);
    } catch (error) {
      // Nothing to reset.
    }
    clearBanner('legacy-data');
    renderLegacyNotice();
  });
}

function initMigrationPanel() {
  const panel = document.getElementById('migration-panel');

  if (!panel) {
    return;
  }

  document.getElementById('export-legacy').addEventListener('click', runLegacyBackupDownload);
  document.getElementById('export-database').addEventListener('click', runDatabaseExport);
  document.getElementById('migration-preview-button').addEventListener('click', runMigrationPreview);
  renderMigrationPanel();
}

// ---------------------------------------------------------------------------
// Page start-up
// ---------------------------------------------------------------------------

const PAGE_INITIALIZERS = {
  dashboard: initDashboard,
  transactions: initTransactions,
  categories: initCategories,
  accounts: initAccounts,
  analytics: initAnalytics,
  settings: initSettings
};

let pageInitialized = false;
let pageStarting = false;

// Loads what the page needs from the API, then starts the page. Until the data
// has arrived, the financial content is hidden (see "data-pending" in the CSS)
// so that placeholder zeros are never mistaken for real values. If the server
// cannot be reached, an error with a retry button is shown instead.
async function startPage() {
  const root = document.documentElement;
  const page = document.body.dataset.page;
  const initialize = PAGE_INITIALIZERS[page];

  if (!initialize || pageStarting) {
    root.classList.remove('data-pending');
    return;
  }

  pageStarting = true;

  // Settings works without financial data, so it starts at once.
  const needsData = page !== 'settings';

  if (!needsData && !pageInitialized) {
    await initialize();
    pageInitialized = true;
  }

  clearBanner('load-error');
  root.classList.remove('data-error');

  if (needsData) {
    root.classList.add('data-pending');
    setBanner('loading', 'Loading your data...', { kind: 'info' });
  }

  try {
    await loadFinancialData(PAGE_DATA[page]);
  } catch (error) {
    clearBanner('loading');
    root.classList.remove('data-pending');
    migration.dataReady = false;
    renderMigrationPanel();

    if (needsData) {
      root.classList.add('data-error');
    }

    setBanner('load-error', errorText(error), {
      kind: 'error',
      actions: [{ label: 'Try again', onClick: () => startPage() }]
    });
    pageStarting = false;
    return;
  }

  clearBanner('loading');

  if (!pageInitialized) {
    await initialize(); // an initializer may return a promise (the transactions page does)
    pageInitialized = true;
  }

  if (page === 'settings') {
    migration.dataReady = true; // database counts are known now
    renderMigrationPanel();
  }

  root.classList.remove('data-pending');
  updateNotifications();
  pageStarting = false;
}

// Hide financial content from the first moment (this script runs in <head>)
// until startPage() has decided what to show.
document.documentElement.classList.add('data-pending');

applyTheme();

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') {
      applyTheme();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initLayout();
  renderLegacyNotice();
  startPage();
});
