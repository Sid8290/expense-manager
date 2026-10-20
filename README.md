# Expense Manager

A simple expense manager built with plain HTML, CSS and JavaScript. Transactions, accounts and categories are stored in a SQLite database through a small Node.js backend; settings, bills and to-do items are still kept in the browser's `localStorage`. Data saved by the older, browser-only version can be copied into the database from the Settings page (see [Current Status](#current-status)).

## Features

- **Transactions**: add income and expense transactions with description, type, category, account, amount, date and an optional note. View them in a table, delete them, and filter by search text, type, category and account. Amounts are validated and must be greater than zero.
- **Accounts**: add cash, bank and online accounts with an initial balance. Their balances update automatically with transactions. You can also track assets, money to receive and money to give, and see a financial position summary.
- **Categories**: add and delete income and expense categories. The transaction form uses the categories you have created. Categories and accounts that are used by transactions cannot be deleted.
- **Dashboard**: total income, total expense, total balance, an income vs expense bar chart for the last 6 months, the 5 most recent transactions, upcoming expenses and a to-do list.
- **Analytics**: this month vs last month, balance, expense and income statistics, category breakdown charts, category cards and top expenses / top income sources tables. Charts are drawn with HTML, CSS and JavaScript only.
- **Settings**: theme (light, dark, system), default currency, date format, default transaction type, notification preferences, name and email display, and a reset button that clears the settings, bills and to-do items stored in the browser (it never deletes database records).
- **Data migration and export** (Settings): review records left in the browser by the older version, download a backup, preview and confirm an import into the database, and download a database export. Nothing in the browser is changed or deleted.
- **Notifications**: a bell menu that shows bill reminders and a monthly summary, plus a short message after adding or deleting a transaction. Each can be turned on or off in Settings.
- **Navigation search**: the search box in the header opens the Transactions page filtered by your search text.
- **Mobile**: the sidebar becomes a slide-in menu opened with a menu button.
- **Persistence**: transactions, accounts and categories are saved in the SQLite database and remain after a refresh or a server restart. Settings, bills and to-do items are saved in `localStorage`.

Changing the currency only changes the symbol and number format; amounts are not converted. The name, email and password fields in Settings are display only: there is no login or authentication.

## Technologies

- HTML5
- CSS3
- Vanilla JavaScript
- Browser `localStorage` (settings, bills and to-dos only)
- `fetch` for same-origin calls to the API
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
│   │   ├── transactions.js /api/transactions
│   │   ├── importer.js     /api/import/preview and /api/import (legacy browser data -> SQLite)
│   │   └── exporter.js     /api/export (database export)
│   ├── data/               created at runtime; holds the SQLite file (not committed)
│   └── test/
│       ├── server.test.js  Stage 1 tests: server, static files, startup, shutdown
│       ├── api.test.js     Stage 2 tests: the three APIs, constraints, migration
│       ├── frontend.test.js Stage 3-4 tests: API client, page data layer, legacy-data safety, backup
│       ├── import.test.js  Stage 4 tests: import, preview, export, idempotency, atomicity
│       └── browser-check.js optional real-browser check (needs Playwright, see below)
├── frontend/
│   ├── index.html          dashboard
│   ├── pages/              transactions, categories, accounts, analytics, settings
│   ├── css/style.css
│   ├── js/api.js           the only code that calls /api (loaded before script.js)
│   ├── js/script.js
│   └── assets/
└── docs/                   API.md (API reference), stage checkpoints (STAGE1-4_CHECKPOINT.md)
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

## Optional real-browser check

`npm test` needs nothing but Node.js. A second, optional check drives the real pages in a headless browser against a temporary server and database (it never touches your real database or browser profile):

```
npm install --no-save playwright
npx playwright install chromium
node backend/test/browser-check.js
```

## Current Status

This is **Stage 4: safe import, export and migration**.

- Transactions, accounts and categories are read from and written to the database through the API on every page (`frontend/js/api.js` is the only code that calls `/api`).
- Settings, theme, bills and to-do items stay in `localStorage`.
- A fresh database is **empty**: the old version's default accounts and categories are not created.
- **Moving old data:** Settings -> "Move Data From the Old Version" lets you review what the old browser-only version left in this browser, download a backup file, preview the import (nothing is changed), tick a confirmation box and import. The import is all-or-nothing, never overwrites, skips duplicates, reports every rejected record, and can be repeated safely (the second run imports nothing). The records in `localStorage` are only read, never changed or deleted. Details: [docs/STAGE4_CHECKPOINT.md](docs/STAGE4_CHECKPOINT.md).
- **Exports:** "Download Browser Backup" (old data exactly as stored) and "Download Database Export" (current database). Both are backups/checks; neither can be imported back into the app.
- A notice on every page remains while old records stay in this browser; after an import it says whether they are already in the database. Dismissing it only hides it for the current tab.
- The app must be opened through the server (`http://127.0.0.1:3000`). Opening an HTML file directly shows an instruction instead of data.

## Known Limitations

- **Browser data is per address.** `localStorage` is stored separately for each origin. Data you entered earlier by opening the HTML files directly (a `file://` address), or on a different port or host name, will not appear at `http://127.0.0.1:3000`. Use one address consistently. `http://localhost:3000` and `http://127.0.0.1:3000` also count as different origins.
- Font Awesome icons (menu and bell) load from a CDN and need an internet connection.
- `node:sqlite` is experimental in Node.js, so its behavior may change in future Node.js releases.
- The API has no authentication and no CORS headers, and it does not check the `Host` header. It is meant for a computer you control, bound to `127.0.0.1`.
- Bills, to-do items and settings have no API; they stay in `localStorage`.
- Each page loads its data when it opens. Changes made in another browser tab appear after a reload (a save or delete that conflicts with such a change refreshes the page's lists and shows a message).
- The browser backup and the database export cannot be re-imported (backup/inspection only). Old data can only be imported from the same browser and address (`localStorage` is per origin) it was stored in.
- There is no way yet to edit a record (the original app had none) or to delete all database records from the Settings page.
- The server is meant for local use only: it listens on `127.0.0.1`, has no login and sends no CORS headers.
- The shutdown tests need a Linux or macOS machine (Windows cannot send a graceful signal to a child process); they are skipped on Windows.
