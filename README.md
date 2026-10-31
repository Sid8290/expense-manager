# Expense Manager

A small expense manager: a plain HTML, CSS and JavaScript frontend served by an **Express** backend that stores accounts, categories and transactions in **PostgreSQL**. Settings, bills and to-do items stay in the browser's `localStorage`.

It is meant to run on your own computer (it listens on `127.0.0.1` only and has no login).

## Features

- **Transactions**: add income and expense transactions (description, type, category, account, amount, date, optional note), view and delete them. Filtering and totals are done **by the server**: search text, type, category and account (the API also supports a date range and paging, see [docs/API.md](docs/API.md)).
- **Accounts**: cash, bank and online accounts with an initial balance; their balances update with every transaction. Assets, money to receive and money to give are tracked too, with a financial position summary.
- **Categories**: add and delete income and expense categories. Accounts and categories that transactions use cannot be deleted.
- **Dashboard**: total income, expense and balance, a 6-month income vs expense chart, the 5 latest transactions, upcoming bills and a to-do list.
- **Analytics**: this month vs last month, category breakdowns, top expenses and income sources (drawn with HTML, CSS and JavaScript only).
- **Settings**: theme, currency, date format, default transaction type, notification preferences, and a reset button that clears the browser-stored settings, bills and to-dos (it never deletes database records).
- **Import and export** (Settings): review records the older, browser-only version left in this browser, download a backup, preview and confirm an import into the database, and download a database export. Nothing in the browser is changed or deleted.
- **Summary API**: `GET /api/summary` returns exact totals, per-category and per-month sums for any filter.
- **Moving data from the old SQLite version**: an optional command-line tool (see [below](#moving-data-from-the-old-sqlite-version)).

Changing the currency only changes the symbol and number format; amounts are not converted. The name, email and password fields in Settings are display only.

## Technology

- Frontend: HTML5, CSS3, vanilla JavaScript, `fetch`, Font Awesome icons from a CDN.
- Backend: Node.js, **Express 5**, **PostgreSQL** through the `pg` driver (parameterized `$1, $2` queries, one transaction per multi-step write, versioned migrations).
- Tests: Node's built-in test runner against a real PostgreSQL server; an optional Playwright browser check.
- `node:sqlite` (built into Node.js) is used **only** by the optional migration tool and its tests.

## Project structure

```
expense-manager/
├── package.json, package-lock.json
├── .env.example            copy to .env (never commit .env)
├── backend/
│   ├── server.js           Express app: /api routes, JSON body handling, static files, startup, shutdown
│   ├── db.js               pg pool, migrations, query(), runInTransaction(), health status
│   ├── db-errors.js        maps PostgreSQL constraint errors (SQLSTATE) to API answers
│   ├── api/                accounts, categories, transactions, summary, importer, exporter,
│   │                       transaction-filters (query-string filters -> parameterized SQL), validate, common
│   ├── tools/sqlite-to-postgres.js   optional one-time data migration tool
│   └── test/               *.test.js, helpers/, browser-check.js
├── frontend/               index.html, pages/, css/style.css, js/api.js (the only code that calls /api), js/script.js
└── docs/                   API.md (API reference) and the checkpoint documents (see "Documentation")
```

## Requirements

- **Node.js 22.13 or newer** (developed on 22.22.0; also intended for Node 24).
- **PostgreSQL 13 or newer** (tested on 16.15). Version 13+ is needed for `trim_scale`, used by the search filter.
- A web browser. Playwright is needed only for the optional browser check.

## Setup

### 1. Create the databases (once)

Choose your own password. Using `psql` (on Windows, run it from the PostgreSQL `bin` folder or the SQL Shell):

```
psql -U postgres -c "CREATE USER expense_user WITH PASSWORD 'choose-a-password';"
psql -U postgres -c "CREATE DATABASE expense_manager OWNER expense_user;"
psql -U postgres -c "CREATE DATABASE expense_manager_test OWNER expense_user;"
```

`expense_manager` is the app's database. `expense_manager_test` is a **separate** database used only by the automated tests (they create and drop their own temporary schemas in it). The tables are created automatically when the server first starts.

### 2. Configure `.env`

```
copy .env.example .env        (Command Prompt / PowerShell)
cp .env.example .env          (macOS / Linux)
```

Open `.env` and replace `CHANGE_ME` with your password. `.env` is ignored by Git; `.env.example` contains placeholders only.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes, to run the app | `postgres://USER:PASSWORD@HOST:PORT/DATABASE`, e.g. `postgres://expense_user:...@127.0.0.1:5432/expense_manager`. If it is missing, or PostgreSQL cannot be reached, the server prints the reason (never the password) and exits. |
| `TEST_DATABASE_URL` | yes, to run the database tests | URL of the separate test database. Its name must contain "test" and must differ from `DATABASE_URL`, or the tests refuse to run. |
| `PORT` | no (3000) | Port to listen on (`0` = any free port). |
| `HOST` | no (127.0.0.1) | Address to listen on. Keep the default unless you understand the risk: there is no login. |

`FRONTEND_ROOT` and `CHECK_PORT` exist only for the automated tests.

### 3. Install and start

```
npm install
npm start
```

Open **http://127.0.0.1:3000**. Stop with `Ctrl+C` (the server finishes in-flight requests and closes the database pool first). Use `npm ci` instead of `npm install` for an exact install from the lockfile.

To use another port: PowerShell `$env:PORT = 4000; npm start`, Command Prompt `set PORT=4000 && npm start`.

### Check that the backend is healthy

```
Invoke-RestMethod http://127.0.0.1:3000/api/health        (PowerShell)
curl http://127.0.0.1:3000/api/health                     (curl)
```

```json
{ "ok": true, "data": { "status": "ok", "server": { "running": true, "uptimeSeconds": 12 },
  "database": { "ready": true, "engine": "postgresql", "serverVersion": "16.15", "schemaVersion": 2 } } }
```

If the database stops being usable, `/api/health` answers HTTP 503 with `"ok": false`. The response never contains connection details.

## Tests

All database tests run against `TEST_DATABASE_URL` (set in `.env` or the environment). Each test file creates its own temporary schema and drops it afterwards; your real database is never touched.

| Command | What it runs |
| --- | --- |
| `npm test` | Everything: database foundation, API, server, frontend data layer, import/export, filters and summary, SQLite migration tool |
| `npm run test:db` | The database layer (migrations, transactions, error mapping) |
| `npm run test:import` | Import, preview and export |
| `npm run test:filters` | Transaction filters, paging and the summary endpoint |
| `npm run test:migration` | The SQLite-to-PostgreSQL migration tool |
| `npm run test:browser` | The optional real-browser check (below) |

The graceful-shutdown tests need Linux or macOS (Windows cannot send a signal to a child process) and are skipped on Windows; the symbolic-link tests are skipped where symlinks are not permitted.

### Optional real-browser check

It drives the real pages in headless Chromium against a temporary server and schema:

```
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

## Moving data from the old SQLite version

Earlier versions of this project stored the data in a SQLite file (`backend/data/expense-manager.db`). If you have one, you can copy it into PostgreSQL once with `backend/tools/sqlite-to-postgres.js`.

**Before you start**

1. **Back up** the SQLite file (copy it somewhere safe) and the PostgreSQL database (`pg_dump -U expense_user expense_manager > backup.sql`). The tool never changes the SQLite file, but a backup is the right habit.
2. Stop the old server. Make sure `DATABASE_URL` points at the database you want (the destination).

**Preview first (saves nothing)**

```
npm run migrate:sqlite -- --source backend\data\expense-manager.db
```

It shows the counts (in SQLite, to copy, already there) and runs the real inserts inside a transaction that is then rolled back, so every database rule is checked.

**Copy the data**

```
npm run migrate:sqlite -- --source backend\data\expense-manager.db --apply
```

What it guarantees (each point is covered by `npm run test:migration`):

- The SQLite file is opened **read-only** and is never modified, created or deleted. `--source` is required; the destination is always `DATABASE_URL`; nothing is assumed.
- Ids (account ids, category numbers, transaction ids), amounts (exact whole paise), dates, notes and creation times are copied unchanged, and every row is read back and compared, and each account's balance is re-checked, before the transaction is committed.
- It is **one transaction**: any problem rolls everything back and nothing is left behind.
- It never overwrites. Records already in PostgreSQL with identical data are skipped, so **running it again changes nothing** ("already migrated"). The same id with different data, or a name already used by another record, is a **conflict**: the whole migration is refused (exit code 2) and nothing is written. The easiest and recommended way is to migrate into an **empty** database.
- The password is never printed.

Exit codes: `0` done (or nothing to do), `1` error, `2` conflicts. The tool needs the built-in `node:sqlite` module (Node.js 22.13+), which Node may report as experimental; that is why it is the only code that uses it. Source files from other versions (schema version other than 2) are refused rather than guessed at.

The browser-only version's data (in `localStorage`) is a different path: use Settings, "Move Data From the Old Version".

## API

See [docs/API.md](docs/API.md) for every endpoint, parameter, response and error code. A quick check from PowerShell:

```
Invoke-RestMethod http://127.0.0.1:3000/api/accounts
Invoke-RestMethod "http://127.0.0.1:3000/api/summary?type=expense"
```

## Documentation

- `docs/API.md`: the API reference (kept in step with the code).
- `docs/POSTGRES_PART1-4_CHECKPOINT.md`, `docs/POSTGRES_PART5_CHECKPOINT.md`: how and why the PostgreSQL migration was done, step by step.
- `docs/STAGE1-4_CHECKPOINT.md`, `docs/FINAL_AUDIT_CHECKPOINT.md`: the history of the earlier SQLite-based versions. They describe that earlier design and are kept for reference only.

## Known limitations

- **Local use only.** No authentication, no CORS headers, no `Host` header check; it listens on `127.0.0.1`.
- **Browser data is per address.** `localStorage` is stored separately for each origin; `http://localhost:3000` and `http://127.0.0.1:3000` differ, and so does data from a `file://` page. Use one address.
- Bills, to-do items and settings have no API and stay in `localStorage`.
- The dashboard, analytics page and bell notification still add up the transactions they loaded in the browser; only the Transactions page uses the server-side filters and the summary endpoint.
- The Transactions page has no date-range inputs (the API supports `from` and `to`), and records cannot be edited in the pages (the API supports `PUT`).
- Each page loads its data when it opens; changes made in another tab appear after a reload.
- The browser backup and the database export cannot be re-imported (backup and inspection only).
- PostgreSQL never rewinds identity counters, so a preview or a rolled-back import can leave gaps in category numbers. Ids stay unique.
- Case-insensitive search of non-ASCII letters depends on the PostgreSQL database's locale.
- Font Awesome icons load from a CDN and need an internet connection.
