# Expense Manager: Stage 2 Checkpoint

> **Historical document.** It describes the earlier SQLite-based version of this project. The application now runs on Express and PostgreSQL; see [README.md](../README.md) and [docs/API.md](API.md) for the current design. Statements below about SQLite, `node:sqlite` and the old file layout no longer apply.

Paste or attach this file at the start of the Stage 3 conversation, together with the updated project ZIP. Stage 3 has **not** been started. Nothing has been committed or pushed.

## Status

Stage 2 (backend APIs and SQLite data layer for transactions, accounts and categories) is implemented and tested. The frontend is byte-for-byte unchanged from Stage 1; it still uses `localStorage` and does not call the API. No localStorage data was read, migrated or touched.

- Stack unchanged: vanilla frontend + Node.js built-in `http` + built-in `node:sqlite`. Zero npm dependencies. Node.js >= 22.13.0 (developed on 22.22.0), user runs Windows.
- Run: `npm start` -> http://127.0.0.1:3000. Test: `npm test` (142 tests). Full API reference: `docs/API.md`.

## What changed in Stage 2

| Path | Change |
| --- | --- |
| `backend/db.js` | Added migration **version 2** (accounts, categories, transactions, indexes). Version 1 untouched. |
| `backend/server.js` | Route params (`/api/accounts/:id`), JSON body reader (`readJsonBody`: 415/413/400), handlers now **return** `{status, payload, headers}` instead of writing to `res`, `ApiError` handling, safety-net mapping of SQLite constraint errors, `details` in error envelope. Health handler adapted to the new contract; its output is unchanged. |
| `backend/api/common.js`, `validate.js` | New: `ApiError`, `ok()`, money helpers; shared validators. |
| `backend/api/accounts.js`, `categories.js`, `transactions.js` | New: each exports `routes` (merged into `apiRoutes` in `server.js`). |
| `backend/test/api.test.js` | New: 69 API tests. |
| `backend/test/server.test.js` | Two Stage 1 assertions updated for the new schema (tables list; version == `LATEST_VERSION`) and one obsolete example changed (`POST /api/transactions` as an "unknown route" -> `/api/budgets`). |
| `README.md`, `docs/API.md`, this file | Documentation. |

## Design decisions (and why)

- **Money = INTEGER minor units** (`*_minor`, paise) in SQLite; API speaks decimal numbers. Amounts with >2 decimals are **rejected** (frontend rounds silently). Conversion lives only in `api/common.js` (`toMinor`/`fromMinor`).
- **Transactions reference categories by numeric `categoryId`** (FK), not by name. Responses also carry `category` (name). Categories can therefore be renamed. The frontend currently stores the name, so Stage 3/4 must map name -> id.
- **Composite FK** `(category_id, type) -> categories(id, type)` makes "category type = transaction type" a database guarantee. `account_id` FK is RESTRICT; money-account-only rule (cash/bank/online) is an API check.
- **Client-supplied `id` (and `createdAt`) accepted on POST** so Stage 4 can import records with their existing ids (`acc-cash`, `acc-bank`, `txn-...`). Otherwise `acc-<uuid>` / `txn-<uuid>`. Categories have no client id (the frontend has none).
- **No cascade deletes.** Delete of a used account/category -> 409 `IN_USE` (same rule and wording as the frontend). Type change of a used category, or of an account with transactions to a non-money type, -> 409.
- `PUT` = full replace (no PATCH). Unknown fields rejected. `id`/`createdAt` immutable.
- `currentBalance` on accounts is computed on read (`balance + income - expense`), same formula as the frontend's `getAccountBalance()`. `balance` is the stored **initial** balance.
- **Not seeded:** the frontend's default accounts (`acc-cash`, `acc-bank`) and 9 default categories are NOT created in SQLite. Stage 3/4 must decide how defaults are created.
- Uniqueness: DB uses `COLLATE NOCASE` (ASCII-only) plus an app-level `toLowerCase()` check to match the frontend for other alphabets.
- Date rule "not in the future" uses the **server's local date** (same machine as the browser in this local setup).
- A JSON body must be `application/json`. This also stops other websites from sending cross-site "simple" requests to the local API.

## Not implemented (deliberately, for later stages)

Frontend `fetch` integration; localStorage import/export/migration; bills, to-dos and settings in SQLite; server-side totals/analytics endpoints (the frontend computes totals, category totals and monthly charts itself); transaction filtering/search/pagination parameters; seeding default categories/accounts.

## Test status (Stage 2)

- `npm test`: **142 tests, 142 passed, 0 failed, 0 skipped** on Linux, Node.js 22.22.0, six consecutive full runs. (Stage 1 suite: 73; Stage 2 API suite: 69.)
- Mutation checks on a scratch copy: removing the account in-use check, disabling foreign keys, removing the category/type check, and rounding money with `floor` were each detected by failing tests; the unmutated control passed 142/142.
- Manual check with a real server process: data created through the API survived a SIGTERM and restart, and `/api/health` reported `schemaVersion: 2`.
- **Not tested:** Windows itself (shutdown tests are written to skip there; the rest uses `os.tmpdir()`/`path.join`), any browser (frontend not touched, so no browser run was needed), upgrade of a *real* user database from Stage 1 (only a synthetic version-1 file was used), concurrency beyond sequential requests.

## Known limitations

- Local-only API: no auth, no CORS, no `Host`-header check (DNS-rebinding hardening would be a later option).
- `node:sqlite` is experimental and prints a warning at startup.
- Request bodies over 64 KB are rejected (413).
- The GitHub repository could not be cloned from the working environment, so this stage was built on the local Stage 1 copy (which includes the shutdown-race fix from the Stage 1 review: `registerShutdown()` is called before `listen()`). If the committed `server.js` differs, merge by hand.

## Suggested Stage 3 starting points

1. Decide the defaults strategy (seed `acc-cash`/`acc-bank` and the 9 default categories through the API on first run, or let the frontend create them).
2. Add a small `api.js` fetch layer to the frontend and switch each page from `localStorage` reads/writes to the API, mapping category names to ids and handling 400/409 messages.
3. Keep `localStorage` untouched until an explicit import step (Stage 4) exists.
