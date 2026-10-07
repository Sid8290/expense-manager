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
  return loadList(STORAGE_KEYS.transactions, [], isValidTransaction);
}

function getAccounts() {
  return loadList(STORAGE_KEYS.accounts, DEFAULT_ACCOUNTS, isValidAccount);
}

function getCategories() {
  return loadList(STORAGE_KEYS.categories, DEFAULT_CATEGORIES, isValidCategory);
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
      ${manageable ? `<button type="button" class="btn-danger btn-small" data-name="${escapeHTML(item.name)}" data-type="${type}">Delete</button>` : ''}
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
      <button type="button" class="btn-danger btn-small" data-todo-delete="${escapeHTML(todo.id)}">Delete</button>
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

function getFilteredTransactions() {
  const search = document.getElementById('filter-search').value.trim().toLowerCase();
  const type = document.getElementById('filter-type').value;
  const category = document.getElementById('filter-category').value;
  const accountId = document.getElementById('filter-account').value;
  const accounts = getAccounts();

  return sortByNewest(getTransactions()).filter(item => {
    if (type !== 'all' && item.type !== type) return false;
    if (category && item.category !== category) return false;
    if (accountId && item.accountId !== accountId) return false;

    if (search) {
      const text = [
        item.description,
        item.category,
        item.note || '',
        getAccountName(accounts, item.accountId),
        String(item.amount)
      ].join(' ').toLowerCase();

      return text.includes(search);
    }

    return true;
  });
}

function renderTransactionTable() {
  const body = document.getElementById('transactions-body');
  const summary = document.getElementById('transaction-summary');
  const accounts = getAccounts();
  const allCount = getTransactions().length;
  const list = getFilteredTransactions();

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
      <td><button type="button" class="btn-danger btn-small" data-delete-id="${escapeHTML(item.id)}">Delete</button></td>
    </tr>
  `).join('');

  const totals = getTotals(list);

  summary.textContent = `Showing ${list.length} of ${allCount} transactions | Income: ${formatCurrency(totals.income)} | Expenses: ${formatCurrency(totals.expense)}`;
}

function handleAddTransaction(event) {
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

  if (!getCategories().some(item => item.type === type && item.name === category)) {
    return showFormMessage(form, 'Please select a category. Add one on the Categories page if the list is empty.', true);
  }

  if (!getMoneyAccounts().some(item => item.id === accountId)) {
    return showFormMessage(form, 'Please select an account. Add one on the Accounts page if the list is empty.', true);
  }

  if (amount === null) return showFormMessage(form, 'Please enter an amount greater than zero.', true);
  if (!date) return showFormMessage(form, 'Please choose a date.', true);
  if (date > todayISO()) return showFormMessage(form, 'The date cannot be in the future.', true);

  const transactions = getTransactions();

  transactions.push({
    id: generateId('txn'),
    description,
    type,
    category,
    accountId,
    amount,
    note,
    date,
    createdAt: Date.now()
  });

  if (!writeStorage(STORAGE_KEYS.transactions, transactions)) {
    return showFormMessage(form, STORAGE_ERROR, true);
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
}

function handleDeleteTransaction(event) {
  const button = event.target.closest('button[data-delete-id]');

  if (!button || !confirm('Delete this transaction?')) {
    return;
  }

  const remaining = getTransactions().filter(item => item.id !== button.dataset.deleteId);

  if (!writeStorage(STORAGE_KEYS.transactions, remaining)) {
    showToast(STORAGE_ERROR);
    return;
  }

  fillAccountOptions();
  renderTransactionTable();
  updateNotifications();

  if (settings.transactionNotifications) {
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

  renderTransactionTable();

  typeSelect.addEventListener('change', fillCategoryOptions);
  addForm.addEventListener('submit', handleAddTransaction);

  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    renderTransactionTable();
  });

  filterForm.addEventListener('input', renderTransactionTable);

  document.getElementById('filter-clear').addEventListener('click', () => {
    filterForm.reset();
    document.getElementById('navbar-search').value = '';
    renderTransactionTable();
  });

  document.getElementById('transactions-body').addEventListener('click', handleDeleteTransaction);
}

function renderCategories() {
  renderCategoryCards(document.getElementById('expense-categories'), 'expense', true);
  renderCategoryCards(document.getElementById('income-categories'), 'income', true);
}

function handleCategoryDelete(event) {
  const button = event.target.closest('button[data-name]');

  if (!button) {
    return;
  }

  const { name, type } = button.dataset;
  const used = getTransactions().filter(item => item.type === type && item.category === name).length;

  if (used > 0) {
    showToast(`"${name}" is used by ${pluralize(used, 'transaction')} and cannot be deleted.`);
    return;
  }

  if (!confirm(`Delete the category "${name}"?`)) {
    return;
  }

  const remaining = getCategories().filter(category => !(category.type === type && category.name === name));

  writeStorage(STORAGE_KEYS.categories, remaining);
  renderCategories();
}

function initCategories() {
  const form = document.querySelector('.add-category-form');

  renderCategories();

  form.addEventListener('submit', event => {
    event.preventDefault();

    const nameInput = document.getElementById('category-name');
    const type = document.getElementById('category-type').value;
    const name = nameInput.value.trim();

    if (!name) return showFormMessage(form, 'Please enter a category name.', true);
    if (type !== 'income' && type !== 'expense') return showFormMessage(form, 'Please choose a category type.', true);

    const categories = getCategories();
    const exists = categories.some(item => item.type === type && item.name.toLowerCase() === name.toLowerCase());

    if (exists) return showFormMessage(form, `The ${type} category "${name}" already exists.`, true);

    categories.push({ name, type });

    if (!writeStorage(STORAGE_KEYS.categories, categories)) return showFormMessage(form, STORAGE_ERROR, true);

    nameInput.value = '';
    renderCategories();
    showFormMessage(form, 'Category added.', false);
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
      <button type="button" class="btn-danger btn-small" data-account-id="${escapeHTML(account.id)}">Delete</button>
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

function handleAccountDelete(event) {
  const button = event.target.closest('button[data-account-id]');

  if (!button) {
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

  writeStorage(STORAGE_KEYS.accounts, getAccounts().filter(item => item.id !== accountId));
  renderAccounts();
}

function initAccounts() {
  const form = document.querySelector('.add-account-form');

  renderAccounts();

  form.addEventListener('submit', event => {
    event.preventDefault();

    const nameInput = document.getElementById('account-name');
    const amountInput = document.getElementById('account-amount');
    const type = document.getElementById('account-type').value;
    const name = nameInput.value.trim();
    const balance = parseAmount(amountInput.value, true);

    if (!name) return showFormMessage(form, 'Please enter an account name.', true);
    if (!ACCOUNT_TYPE_KEYS.includes(type)) return showFormMessage(form, 'Please choose an account type.', true);
    if (balance === null) return showFormMessage(form, 'Please enter a valid amount (zero or more).', true);

    const accounts = getAccounts();

    if (accounts.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      return showFormMessage(form, `An account named "${name}" already exists.`, true);
    }

    accounts.push({ id: generateId('acc'), name, type, balance });

    if (!writeStorage(STORAGE_KEYS.accounts, accounts)) return showFormMessage(form, STORAGE_ERROR, true);

    nameInput.value = '';
    amountInput.value = '';
    renderAccounts();
    showFormMessage(form, 'Account added.', false);
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

  document.getElementById('reset-data').addEventListener('click', () => {
    if (!confirm('This will delete all transactions, accounts, categories and settings. Continue?')) {
      return;
    }

    try {
      Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    } catch (error) {
      showToast('Could not reset the data.');
      return;
    }

    location.reload();
  });
}

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

  const initializers = {
    dashboard: initDashboard,
    transactions: initTransactions,
    categories: initCategories,
    accounts: initAccounts,
    analytics: initAnalytics,
    settings: initSettings
  };

  const initialize = initializers[document.body.dataset.page];

  if (initialize) {
    initialize();
  }
});