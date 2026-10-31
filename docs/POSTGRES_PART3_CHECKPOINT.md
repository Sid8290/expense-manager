# PostgreSQL migration, Part 3: import and export

> Written at the end of Part 3; it describes the project as it was then. Later parts finished the work listed as "not done" here. The current state is in [README.md](../README.md) and [POSTGRES_PART5_CHECKPOINT.md](POSTGRES_PART5_CHECKPOINT.md).

**Status: Part 3 of 5 is done.** `GET /api/export`, `POST /api/import/preview` and `POST /api/import` run on PostgreSQL again. Request/response formats, validation rules, error codes and report fields are unchanged from the SQLite version.

## What changed
| File | Change |
| ---- | ------ |
| `backend/api/importer.js` | Async, uses `db.query()` with `$1, $2` parameters and `db.runInTransaction()`. Adds an advisory lock. |
| `backend/api/exporter.js` | Async; reads the three lists in one read-only `REPEATABLE READ` transaction. |
| `backend/server.js` | The importer and exporter routes are registered again. The per-route 8 MB body limit is unchanged. |
| `backend/test/import.test.js` | Ported to PostgreSQL (55 tests, all kept) and 6 new PostgreSQL tests. |
| `backend/test/api.test.js` | One Part 2 test that asserted "import/export answer 404" now checks that the routes exist. |
| `package.json` | New scripts `test:import` and `test:part3`. |
| `README.md`, `docs/API.md` | Status banner and the import/export transaction description. The full rewrite is Part 5. |

`accounts.js`, `categories.js`, `transactions.js`, `db.js`, `db-errors.js` and the frontend are unchanged.

## How the import works
1. `checkEnvelope()` validates the document (format, version, entity names, array types, record limits: 500 accounts, 500 categories, 20 000 transactions, 8 MB body). Nothing touches the database before this passes.
2. `db.runInTransaction()` checks out **one** connection and runs `BEGIN`. Every `db.query()` inside it automatically uses that connection.
3. `pg_advisory_xact_lock(7243001)` is taken first. Imports therefore run one at a time; the lock is released by `COMMIT` or `ROLLBACK`. A second import waits, then plans against the data the first one saved (so it reports duplicates instead of failing on a unique constraint).
4. Accounts, then categories, then transactions are planned and written, one record after another, using the same validators as the normal API (`readBody` of each module). Existing rules are unchanged: same id and identical data is a duplicate, same id with different data is a conflict, names are never matched as identity for accounts, references are never guessed, unused old defaults are not imported.
5. Every record that was written is read back and compared (`verifyWritten`). A mismatch throws.
6. `COMMIT` for an import; `ROLLBACK` for a preview (`dryRun: true`). The preview runs exactly the same code, so it cannot promise something the import would not do.

## Atomicity and rollback
- Any thrown error (a database error, a failed read-back check, a lost connection) makes `runInTransaction` run `ROLLBACK` and rethrow; the handler answers `500 IMPORT_FAILED` ("nothing was saved") or `500 PREVIEW_FAILED`. The details are logged on the server only and never sent to the client.
- Nothing is committed until the very end, so there is never partly imported data. Tests prove it with a database trigger that rejects one row in the middle of an import (transactions and categories), and check that the data is identical afterwards and that the same import works once the problem is gone.
- Only normal validation problems (a bad record) are reported per record; they do not abort the import, exactly as before.

## Export
`GET /api/export` runs `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` as the first statement of a transaction, then reads accounts, categories and transactions. The three lists come from one snapshot, so a transaction saved during the export is in all lists or none. A test exports repeatedly while a 2 000-record import is running and checks that every export is all-or-nothing.

## Behaviour differences from the SQLite version
- **Id counters can skip.** PostgreSQL never rewinds an identity counter, so a preview, or an import that rolled back, may use up category ids; the next category then gets a higher id. Ids stay unique and valid; only the numbering has gaps. (SQLite rolled counters back; the old test that asserted this was dropped.)
- Import of the same file twice at the same moment is now safe (see the lock above).

## Tests (isolated schema in `TEST_DATABASE_URL`)
- `import.test.js`: 61 tests covering preview without changes, successful import, invalid payloads, missing and malformed fields, duplicates (in file and in database), conflicts, unresolved account/category references, referential integrity, rollback after a failed import, repeated imports (idempotency), empty datasets, a 20 000-transaction import, status codes and response shapes, SQL-injection-like and HTML content, concurrency, export snapshot, and the normal API after an import.
- Commands: `npm run test:import`, `npm run test:part3`, `npm test`.

## Not done (later parts)
Part 4: server-side transaction filtering and summary endpoints. Part 5: README and `docs/API.md` rewrite (they still describe SQLite in other places), the Settings page text that mentions SQLite (`frontend/pages/settings.html`), an optional SQLite-to-PostgreSQL data copy, and the final audit.
