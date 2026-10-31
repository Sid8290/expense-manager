# Expense Manager: Stage 1 Checkpoint

> **Historical document.** It describes the earlier SQLite-based version of this project. The application now runs on Express and PostgreSQL; see [README.md](../README.md) and [docs/API.md](API.md) for the current design. Statements below about SQLite, `node:sqlite` and the old file layout no longer apply.

Paste or attach this file at the start of the Stage 2 conversation, together with the updated project ZIP.

## Status

Stage 1 (backend foundation) is implemented and tested. Stage 2 has **not** been started.

- Stack: existing HTML/CSS/vanilla JS frontend + Node.js (built-in `http`) + SQLite (built-in `node:sqlite`). Zero npm dependencies.
- Required Node.js: 22.13.0 or newer (developed on 22.22.0). Target OS for the user: Windows.
- Run: `npm start` -> `http://127.0.0.1:3000`. Test: `npm test` (73 tests).
- The frontend still uses `localStorage` for everything. No financial API exists yet.

## Files

| Path | Role |
| --- | --- |
| `package.json` | `start`, `test` scripts; `engines.node >= 22.13.0` |
| `backend/server.js` | HTTP server, API route table, safe static serving, startup, graceful shutdown |
| `backend/db.js` | `initDatabase()`, `getDb()`, `getStatus()`, `closeDatabase()`, `MIGRATIONS` list |
| `backend/test/server.test.js` | `node:test` suite; spawns the real server with a temp DB and temp frontend copy |
| `frontend/index.html` | One-line fix: script path `../frontend/js/script.js` -> `./js/script.js` |
| `README.md`, `docs/` | Setup docs, this checkpoint, `.gitignore` additions |

## How the backend works (extension points for Stage 2)

- **API routes**: `apiRoutes` in `server.js` maps a path to `{ METHOD: handler }`. Unknown path -> 404 JSON, wrong method -> 405 JSON with `Allow`. Paths are exact matches (no `:id` patterns yet). Request bodies are currently discarded with `req.resume()`; Stage 2 must add a JSON body reader (with a size limit) there.
- **Response envelope**: success `{ "ok": true, "data": ... }`; error `{ "ok": false, "error": { "code", "message" } }`. Codes in use: `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `INTERNAL_ERROR`, `DATABASE_NOT_READY`. Helpers: `sendJson`, `sendApiError`.
- **Database**: `db.js` owns one synchronous `DatabaseSync` connection. `PRAGMA foreign_keys = ON` is set and verified. Schema changes are numbered steps in `MIGRATIONS`, tracked with `PRAGMA user_version`; each runs once in a transaction. Version 1 only creates `app_meta` (holds `created_at`). **To add tables, append `{ version: 2, sql: ... }`; never edit version 1.** The DB file defaults to `backend/data/expense-manager.db` (override: `EXPENSE_DB_PATH`).
- **Startup is fail-fast**: bad `PORT`, missing `frontend/index.html`, or any DB init error prints a message and exits with code 1 before listening.
- **Static serving**: root is `frontend/` (override `FRONTEND_ROOT`, used by tests). Decoded once; rejects `..`, `\`, `:`, NUL, dotfiles; checks containment lexically and again after `realpath`; extension allowlist; GET/HEAD only.
- **Config env vars**: `PORT` (3000, `0` = any), `HOST` (127.0.0.1), `EXPENSE_DB_PATH`, `FRONTEND_ROOT`.

## Existing frontend data model (from `frontend/js/script.js`, read directly)

All keys are in `localStorage`; ids are generated in the browser (`generateId('txn' | 'acc' | 'bill' | 'todo')`).

| Key | Shape |
| --- | --- |
| `em_transactions` | `{ id, type: 'income'｜'expense', description, category (name string), accountId, amount (number > 0), note, date 'YYYY-MM-DD', createdAt (ms) }` |
| `em_accounts` | `{ id, name, type: cash｜bank｜online｜asset｜receivable｜payable, balance }`. Defaults: `acc-cash` "Cash" and `acc-bank` "Bank Account", balance 0 |
| `em_categories` | `{ name, type: 'income'｜'expense' }`. 9 defaults (6 expense, 3 income) |
| `em_bills` | `{ id, name, date, amount }` |
| `em_todos` | `{ id, text, done }` |
| `em_settings` | `{ theme, currency, dateFormat, defaultType, transactionNotifications, billReminders, monthlySummary, name, email }` |

Behavior rules the frontend currently enforces (Stage 2 must preserve them): amount > 0 and <= 1,000,000,000, rounded to 2 decimals; transaction date not in the future; transactions use only cash/bank/online accounts; a money account's balance = initial balance + income - expense; a category or account used by a transaction cannot be deleted; category names are unique per type and account names unique overall (case-insensitive); transactions reference categories **by name** and accounts **by id**.

## Decisions to make in Stage 2 (not decided yet)

- How to store money (integer minor units vs decimal) and how it maps to the frontend's 2-decimal rounding.
- Whether categories are referenced by id or by name in SQL (the frontend uses the name today).
- How and when to import existing `localStorage` data (it was deliberately not touched in Stage 1), and which origin it lives on.
- Whether bills, to-dos and settings move to SQLite in Stage 2 or later.

## Test status (Stage 1)

- Automated: 73 tests passing on Linux, Node.js 22.22.0 (`npm test`; 5 consecutive full runs all green after the shutdown fix below). A review pass found that SIGTERM/SIGINT arriving right after startup could kill the process before the shutdown handler existed (3 of 20 runs; the DB was then not closed gracefully). Fixed by calling `registerShutdown(server)` before `server.listen()`; afterwards 60 of 60 signalled shutdowns exited with code 0. Mutation check: with the path-safety code deliberately disabled in a scratch copy, 14 tests failed, so the safety tests do detect regressions.
- Browser: 30 checks passed in headless Chromium 141 on Linux (all pages, sidebar navigation, add transaction, dashboard totals and chart, header search, dark theme, `fetch('/api/health')`, mobile menu).
- **Not tested**: anything on Windows itself (PowerShell/cmd startup, `Ctrl+C`, Windows path handling, Windows Node.js version differences), Firefox/Safari/Edge, and Font Awesome icons (CDN blocked in the test sandbox).

## Known limitations

- `localStorage` is per origin: data entered via `file://`, another port, or `localhost` vs `127.0.0.1` is not visible at `http://127.0.0.1:3000`.
- `node:sqlite` is experimental in Node.js and prints a warning at startup.
- Local-only server: no auth, no CORS headers, bound to 127.0.0.1.
- Original `.gitignore` was not visible, so only `docs/stage1-gitignore-additions.txt` is provided; append it to the existing file.
- Shutdown tests are skipped on Windows (no POSIX signals for child processes).
