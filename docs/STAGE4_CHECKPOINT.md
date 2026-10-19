# Stage 4 checkpoint: safe import, export and migration

## What Stage 4 adds
- `POST /api/import/preview`, `POST /api/import`, `GET /api/export` (see `docs/API.md`).
- `backend/api/importer.js`, `backend/api/exporter.js`; `db.runInTransaction(work, { dryRun })` in `backend/db.js`.
- `accounts.js`, `categories.js`, `transactions.js` now export their validators and insert helpers so the importer uses **the same validation** as the normal API.
- Frontend: `api.js` (`previewImport`, `importLegacy`, `exportDatabase`), `script.js` (legacy reading, backup, migration panel, refined notice), Settings section "Move Data From the Old Version", corrected FAQ text, small CSS.
- Tests: `backend/test/import.test.js` (new), additions to `frontend.test.js`, new Scenario 6 in `browser-check.js`.

## How the workflow works
1. Settings shows per-type counts found in this browser (user records, unchanged old defaults, malformed) next to the database counts. Opening the page writes nothing.
2. "Download Browser Backup": `expense-manager-legacy-backup-YYYY-MM-DD.json` with `format`, `version`, `exportedAt`, `source`, `complete`, `problems`, `data` (entries exactly as stored, malformed ones and unknown fields included) and `unreadable` (raw text of any key that was not valid JSON / not a list).
3. "Preview Import": the server plans the import in a transaction and rolls it back. Nothing changes.
4. The confirmation statements and checkbox enable "Import Now".
5. The import re-reads the browser data, the server re-plans against the current database, commits once, then reads every written record back and compares it.
6. The report shows counts per type, the reason for every rejected record (first 50 shown), database counts before/after, the read-back result and a fresh re-check of the old data. The page's data is reloaded and the legacy notice is re-evaluated.

## Rules
- All-or-nothing: one `BEGIN IMMEDIATE` transaction; failure = rollback, "Nothing was saved".
- Never overwrites: same id + identical data = duplicate (skipped); same id + different data, or a taken name = rejected conflict.
- Order accounts -> categories -> transactions; ids are preserved; categories are matched by (type, name, ignoring case); the old default accounts/categories are skipped unless a transaction uses them.
- Unresolvable account/category references are reported, never guessed.
- Idempotent: demonstrated by tests (second import imports 0 records, database unchanged) and by the browser check.
- Frontend never writes to SQLite directly; `localStorage` financial keys are never written or removed (a source test guards this).

## Limitations
- Backup and database export files cannot be re-imported (the importer rejects the database export explicitly). Only the live browser data can be imported, so it has to be done in the browser (and address) that holds it.
- Transaction results are listed up to 200 per response; counts are always complete.
- Limits: 8 MB body, 500 accounts, 500 categories, 20000 transactions.
- The legacy notice stays while old records remain in `localStorage` (they are deliberately not deleted); there is no "delete old browser data" button.
- The Node version tested here is 22.22.0 on Linux, not the Node 24 used on Windows; run `npm test` there.

## Tests
`npm test` (no dependencies) and the optional `node backend/test/browser-check.js` (needs Playwright). See the final report for the actual results.

## Manual verification on Windows (PowerShell)
```
cd path\to\expense-manager
npm test
npm start
```
Then in the browser at `http://127.0.0.1:3000/pages/settings.html`: (1) read the counts; (2) Download Browser Backup; (3) open the file and check it; (4) Preview Import; (5) tick the box and Import Now; (6) compare counts with the Dashboard, Accounts, Transactions; (7) stop (Ctrl+C) and restart the server and reload; (8) preview/import again and confirm 0 new records; (9) Download Database Export; (10) in DevTools -> Application -> Local Storage confirm the `em_*` keys are unchanged; (11) check bills, to-dos and theme still work.

## Part 5 readiness
Candidates: editing records, deleting the old browser copies after a verified import (explicit button), re-importing from a backup file, bills/to-dos in the database, authentication/hosting if ever needed.
