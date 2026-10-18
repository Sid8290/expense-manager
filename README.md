# Expense Manager

A simple expense manager built with plain HTML, CSS and JavaScript. All of your data is still kept in the browser's `localStorage`. A small Node.js backend now serves the app and provides a SQLite-backed JSON API for transactions, accounts and categories, but the frontend does not use that API yet (see [Current Status](#current-status)).

## Features

- **Transactions**: add income and expense transactions with description, type, category, account, amount, date and an optional note. View them in a table, delete them, and filter by search text, type, category and account. Amounts are validated and must be greater than zero.
- **Accounts**: add cash, bank and online accounts with an initial balance. Their balances update automatically with transactions. You can also track assets, money to receive and money to give, and see a financial position summary.
- **Categories**: add and delete income and expense categories. The transaction form uses the categories you have created. Categories and accounts that are used by transactions cannot be deleted.
- **Dashboard**: total income, total expense, total balance, an income vs expense bar chart for the last 6 months, the 5 most recent transactions, upcoming expenses and a to-do list.
- **Analytics**: this month vs last month, balance, expense and income statistics, category breakdown charts, category cards and top expenses / top income sources tables. Charts are drawn with HTML, CSS and JavaScript only.
- **Settings**: theme (light, dark, system), default currency, date format, default transaction type, notification preferences, name and email display, and a reset button that clears all stored data.
- **Notifications**: a bell menu that shows bill reminders and a monthly summary, plus a short message after adding or deleting a transaction. Each can be turned on or off in Settings.
- **Navigation search**: the search box in the header opens the Transactions page filtered by your search text.
- **Mobile**: the sidebar becomes a slide-in menu opened with a menu button.
- **Persistence**: everything is saved in `localStorage` and remains after a page refresh.

Changing the currency only changes the symbol and number format; amounts are not converted. The name, email and password fields in Settings are display only: there is no login or authentication.

## Technologies

- HTML5
- CSS3
- Vanilla JavaScript
- Browser `localStorage`
- Font Awesome (loaded from a CDN)
- Node.js (built-in `http` module, no web framework)
- SQLite through Node's built-in `node:sqlite` module (no npm packages)

## Project Structure

```
expense-manager/
├── package.json            npm scripts (start, test) and the required Node.js version
├── backend/
│   ├── server.js           HTTP server: static files, /api routing, JSON body reading, startup and shutdown
│   ├── db.js               SQLite connection, schema migrations, status check
│   ├── api/
│   │   ├── common.js       ApiError, response helper, money conversion
│   │   ├── validate.js     shared request validation
│   │   ├── accounts.js     /api/accounts
│   │   ├── categories.js   /api/categories
│   │   └── transactions.js /api/transactions
│   ├── data/               created at runtime; holds the SQLite file (not committed)
│   └── test/
│       ├── server.test.js  Stage 1 tests: server, static files, startup, shutdown
│       └── api.test.js     Stage 2 tests: the three APIs, constraints, migration
├── frontend/
│   ├── index.html          dashboard
│   ├── pages/              transactions, categories, accounts, analytics, settings
│   ├── css/style.css
│   ├── js/script.js
│   └── assets/
└── docs/                   API.md (API reference), stage checkpoints
```

## Getting Started

### Prerequisites

- **Node.js 22.13.0 or newer.** Older 22.x versions do not enable `node:sqlite` without an extra flag. Check yours with `node --version`. This project was developed and tested on Node.js 22.22.0.
- No `npm install` is needed: there are no dependencies.

### Start the app (Windows PowerShell or Command Prompt)

```
cd path\to\expense-manager
npm start
```

Then open the dashboard at **http://127.0.0.1:3000**. Stop the server with `Ctrl+C`.

To use another port:

```
# PowerShell
$env:PORT = 4000; npm start

# Command Prompt
set PORT=4000 && npm start
```

Node.js prints an `ExperimentalWarning: SQLite is an experimental feature` message on startup. This is expected: `node:sqlite` is still marked experimental by Node.js.

### Check that the backend is healthy

```
# PowerShell
Invoke-RestMethod http://127.0.0.1:3000/api/health

# Command Prompt (curl.exe ships with Windows 10 and later)
curl.exe http://127.0.0.1:3000/api/health
```

A healthy response looks like this (values such as `uptimeSeconds` will differ):

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "server": { "running": true, "uptimeSeconds": 12 },
    "database": { "ready": true, "engine": "node:sqlite", "schemaVersion": 2, "foreignKeys": true }
  }
}
```

If the database is not usable, `/api/health` returns HTTP 503 with `"ok": false`. If the database cannot be opened at startup, the server prints the reason and exits instead of running.

### Run the automated tests

```
npm test
```

The tests run the real server with temporary databases and, where needed, a temporary copy of the frontend. They do not touch your real database or your browser data.

### Settings

| Variable         | Default                           | Meaning                                  |
| ---------------- | --------------------------------- | ---------------------------------------- |
| `PORT`           | `3000`                            | Port to listen on (`0` = any free port)  |
| `HOST`           | `127.0.0.1`                       | Address to listen on (this computer only)|
| `EXPENSE_DB_PATH`| `backend/data/expense-manager.db` | Where the SQLite file is stored          |

## API

The backend exposes `GET /api/health` plus create/read/update/delete endpoints for accounts, categories and transactions. The full reference (routes, rules, error codes and examples) is in [docs/API.md](docs/API.md). A quick check from PowerShell:

```
Invoke-RestMethod http://127.0.0.1:3000/api/accounts
```

## Current Status

This is **Stage 2: backend financial data APIs**.

- The Node.js server serves the existing frontend and a JSON API: health, accounts, categories and transactions.
- SQLite holds `accounts`, `categories` and `transactions` tables (created automatically, empty at first, nothing seeded), with foreign keys and constraints.
- **The frontend still reads and writes `localStorage`.** It does not call the API, and nothing is migrated from `localStorage` to SQLite yet. That comes in later stages, so data created through the API does not appear in the app and vice versa.

## Known Limitations

- **Browser data is per address.** `localStorage` is stored separately for each origin. Data you entered earlier by opening the HTML files directly (a `file://` address), or on a different port or host name, will not appear at `http://127.0.0.1:3000`. Use one address consistently. `http://localhost:3000` and `http://127.0.0.1:3000` also count as different origins.
- Font Awesome icons (menu and bell) load from a CDN and need an internet connection.
- `node:sqlite` is experimental in Node.js, so its behavior may change in future Node.js releases.
- The API has no authentication and no CORS headers, and it does not check the `Host` header. It is meant for a computer you control, bound to `127.0.0.1`.
- Bills, to-do items and settings have no API yet; they stay in `localStorage`.
- The API rejects amounts with more than 2 decimals and does not accept a category *name* on transactions (it uses `categoryId`), unlike today's frontend. Stage 3 has to adapt for both.
- The server is meant for local use only: it listens on `127.0.0.1`, has no login and sends no CORS headers.
- The shutdown tests need a Linux or macOS machine (Windows cannot send a graceful signal to a child process); they are skipped on Windows.
