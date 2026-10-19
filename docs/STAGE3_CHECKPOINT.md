# Expense Manager: Stage 3 Checkpoint

Paste or attach this file at the start of the Stage 4 conversation, together with the Stage 3 ZIP. Stage 4 has **not** been started. Nothing has been committed or pushed.

## Status

The frontend now uses the SQLite-backed API for transactions, accounts and categories on all six pages. Settings, theme, bills and to-dos stay in `localStorage`. The backend (`backend/server.js`, `backend/db.js`, `backend/api/*`) and `package.json` are **unchanged** from Stage 2. No new endpoint, schema or migration was needed.

- Run: `npm start` -> http://127.0.0.1:3000. Test: `npm test`. Optional real-browser check: `node backend/test/browser-check.js` (needs Playwright, not a project dependency).

## What changed

| Path | Change |
| --- | --- |
| `frontend/js/api.js` | **New.** Only code that calls `/api` (relative URLs, 15 s timeout). Resolves with `data`; rejects with `ApiError` (`kind` network/server/request, `status`, `code`, `details`) whose `message` is always user-safe (5xx text is never passed through; validation `details` become "Field: message"). Refuses `file://`. In Node it exports `{ createClient, ApiError }` for tests. |
| `frontend/js/script.js` | `getTransactions/getAccounts/getCategories` now return an in-memory `store`, filled by `loadFinancialData()` when a page opens (`PAGE_DATA` lists what each page needs; all requests must succeed or the store is untouched). Existing synchronous render/calculation code is unchanged. Create/delete handlers are async: call the API first, change the store only from the confirmed response. `submitWithBusy` blocks double submits and disables buttons. Errors: `errorText`, `isGone` (404), `needsResync` (404/409/stale reference -> reload lists). Status banners (loading, load error + retry, legacy-data notice). Settings "reset" now removes only `em_settings`, `em_bills`, `em_todos`. `DOMContentLoaded` -> `startPage()`. |
| `frontend/css/style.css` | Appended `.status-banner(s)` styles (existing CSS variables) and the `data-pending`/`data-error` rule that hides financial content until data has loaded. |
| `frontend/index.html`, `frontend/pages/{transactions,accounts,categories,analytics,settings}.html` | One line each: `<script src=".../js/api.js">` before `script.js`. `settings.html` also relabels the reset button "Reset Settings, Bills and To-Dos". |
| `backend/test/frontend.test.js` | **New.** 36 tests (see below). Runs in `npm test`. |
| `backend/test/browser-check.js` | **New.** Optional, 32 real-browser checks. Not run by `npm test`. |
| `README.md`, `docs/STAGE3_CHECKPOINT.md` | Docs. |

## Design decisions

- **Store pattern:** keeps the original sync rendering code working with minimal edits; the database is the only source of truth, the store is a per-page copy.
- **Category mapping:** forms show category names; `handleAddTransaction` looks up the `categoryId` (by type + name) from the store and sends it. API transactions already carry `category` (name), so grouping/filters/analytics are unchanged.
- **Balances:** unchanged formula, computed in the page (`balance` initial + income - expense). Tests assert this equals the API's `currentBalance`.
- **No defaults:** a fresh database is empty (the old version's 2 default accounts and 9 default categories are NOT created). The user must add an account and a category first. Decide in Stage 4 whether to seed them.
- **Reset button:** the old "Reset All Data" would have deleted the legacy financial keys and could not clear the database, so it now resets only non-financial data. There is no "delete all database records" feature.
- **Legacy notice:** `getLegacyFinancialSummary()` only reads `em_transactions`, `em_accounts`, `em_categories`; untouched defaults the old app wrote (Cash/Bank Account with 0, the 9 default categories) are not counted. Notice appears on every page while legacy records exist, "Dismiss" hides it for the current tab only (`sessionStorage`). It does not claim anything was imported.
- Old financial keys are never written, removed or cleared (guarded by tests and a byte-for-byte check in the browser run).

## Stage 4 (reserved): what remains

Safe import of the old `localStorage` records into the database. Facts you will need:
- Legacy shapes: transaction `{id:'txn-…', type, description, category (NAME), accountId, amount, note, date, createdAt}`; account `{id:'acc-…', name, type, balance}` (defaults `acc-cash`, `acc-bank`); category `{name, type}` (no id).
- API accepts optional `id` and `createdAt` on POST for transactions, optional `id` for accounts, so ids can be preserved. Import order: categories (collect new ids by type+name), accounts, then transactions with `categoryId` mapped from the name.
- Validation limits the legacy data may violate (the old app only checked types on read): amount > 0, <= 1e9, <= 2 decimals; dates real and not in the future; transactions only on cash/bank/online accounts; account names unique ignoring case; ids 1-64 chars of letters, digits, `-`, `_`.
- localStorage is per origin: data entered at another port/host or via `file://` is not visible at `http://127.0.0.1:3000`.
- Must be idempotent / re-runnable and must not delete the legacy keys without an explicit user action.

## Test status

Run on Linux, Node.js 22.22.0 (not on the target Windows / Node 24.21.0):
- `npm test`: **178 tests, 178 passed, 0 failed, 0 skipped** (Stage 1+2 suites: 142 unchanged; `frontend.test.js`: 36).
- `frontend.test.js` covers: API client against the real server (shapes, validation messages, 409/404, URL encoding, network/5xx/503/non-JSON/odd-200 handling); the real `script.js` in a stubbed browser (`vm`): no localStorage writes on load, store-backed getters, all-or-nothing loading, page data lists, balance consistency with API `currentBalance`, form double-submit guard, legacy detection read-only, reset scope; source guards (api.js loaded on every page, no `localStorage.clear`, no `fetch` outside api.js).
- `browser-check.js`: **32 passed, 0 failed** in headless Chromium (Playwright 1.56) against a temporary server/database: all six pages, add/delete flows, filters, dashboard/analytics/accounts numbers vs API, restart persistence, failure handling (500, validation, network, double submit, record deleted elsewhere, backend down + retry), non-financial features, legacy-data notice, `file://`.
- Manual visual check of dashboard, accounts (dark) and mobile layouts via screenshots: banner matches the existing design.
- **Not tested:** Windows, Node 24, Firefox/Safari/Edge, the Font Awesome icons (CDN blocked in the sandbox), real user data, multi-tab edits beyond the scripted "deleted elsewhere" cases.

## Known limitations

- Data is loaded when a page opens; other tabs' changes need a reload.
- No record editing UI (original had none; the API supports PUT but the client has no update methods).
- Empty database on first run (see above); legacy data invisible until Stage 4.
- `node:sqlite` is experimental; local-only API without auth.
