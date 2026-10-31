# PostgreSQL migration, Part 1: database foundation

> Written at the end of Part 1; it describes the project as it was then. Later parts finished the work listed as "not done" here. The current state is in [README.md](../README.md) and [POSTGRES_PART5_CHECKPOINT.md](POSTGRES_PART5_CHECKPOINT.md).

**Status: Part 1 of 5 is done. The application as a whole does NOT run yet.** `backend/server.js`, the three API modules and the importer/exporter still call the old SQLite functions (`db.getDb()` and friends), which no longer exist. They are migrated in Parts 2 and 3. Until then use `npm run test:db`; `npm test` is expected to fail (see "Compatibility left for Part 2").

## What Part 1 contains
| File | Purpose |
| ---- | ------- |
| `backend/db.js` | Rewritten. A `pg` connection pool, versioned PostgreSQL migrations, `query()`, `runInTransaction()`, `getStatus()`, `closeDatabase()`. No SQLite code or fallback remains. |
| `backend/db-errors.js` | New. Recognizes constraint errors by SQLSTATE (`23505` unique, `23503` foreign key, `23514` check, `23502` not null) and gives the API answer for each (same status/code/message the SQLite version used). No dependencies. |
| `backend/test/postgres-foundation.test.js` | New. 52 tests against a real PostgreSQL server. |
| `.env.example` | New. Placeholders only. |
| `.gitignore` | One line added (`!.env.example`). The existing `.env.*` rule, listed again later in the file, was ignoring `.env.example`. `.env` is still ignored. |
| `package.json`, `package-lock.json` | `pg` added (the lockfile is new; the project had none). Scripts use `node --env-file-if-exists=.env` so a local `.env` is loaded without another dependency. New script `test:db`. Express was not added: it is not needed until Part 2. |

## Schema (migration versions 1 and 2, same as before)
Tables `app_meta`, `accounts`, `categories`, `transactions` (plus `schema_migrations`, which records applied versions). Rules carried over unchanged: composite foreign key `(category_id, type)` so a transaction can only use a category of its own type, RESTRICT on delete, all CHECK limits, money as integer paise.

Deliberate differences, each needed because PostgreSQL has no equivalent:
- Money and `created_at` are `BIGINT` (values reach 1e11 and `Date.now()` milliseconds, which do not fit 32 bits).
- `COLLATE NOCASE` became unique indexes on `lower(name)` (accounts) and `(type, lower(name))` (categories). The `lower()` result follows the database's locale; the API's own `toLowerCase()` check still runs first.
- The hidden `rowid` became an identity column `seq` on accounts and transactions. Part 2 must use `ORDER BY seq` where the code used `rowid`.
- `AUTOINCREMENT` became `GENERATED ALWAYS AS IDENTITY`; use `INSERT ... RETURNING id` instead of `lastInsertRowid`.
- The date `GLOB` check became a regular expression; dates stay `TEXT`, so the API still returns plain `'YYYY-MM-DD'`.

Migrations run in one transaction under an advisory lock, so a failed step leaves nothing behind and two servers starting together are safe. A database whose newest version is higher than the app knows is refused.

## Using the database layer (for Parts 2 and 3)
```js
const db = require('./db');
await db.initDatabase();                       // uses DATABASE_URL; options: { connectionString, schema, max }
const { rows } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
const result = await db.runInTransaction(async tx => {   // same client for every query inside
  await tx.query('INSERT ...', [...]);          // db.query(...) also uses it automatically
  return value;
}, { dryRun: false });                          // dryRun: true always rolls back (import preview)
await db.closeDatabase();                       // at shutdown
```
- Always `await`; `query()` returns a rejected promise on any problem.
- Whole numbers from `BIGINT`, `COUNT` and `SUM` arrive as JavaScript numbers. The conversion is on this pool only (not global) and **throws** a `RangeError` for any value beyond 2^53 instead of rounding. Decimals are untouched. `SUM` of no rows is `NULL`: use `COALESCE`.
- Transactions cannot be nested. The client is always released (destroyed if the connection broke). A transaction handle used after the transaction ended is refused.
- `getStatus()` now returns `{ ready, engine: 'postgresql', serverVersion, schemaVersion }`. The old `foreignKeys` field is gone (PostgreSQL always enforces them); `/api/health`, its tests and the README example need updating in Part 2.

## Setup
Environment variables (see `.env.example`): `DATABASE_URL` (the app), `TEST_DATABASE_URL` (a separate database used only by the tests), `PORT`, `HOST`. Nothing else is read.

One-time setup in `psql` as an administrator (replace the password):
```sql
CREATE ROLE expense_user LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE expense_manager OWNER expense_user;
CREATE DATABASE expense_manager_test OWNER expense_user;
```
Windows PowerShell (from the project folder):
```powershell
npm install
Copy-Item .env.example .env        # then edit .env and set the real password
npm run test:db
```
Without a `.env` file you can set the variable for the session instead: `$env:TEST_DATABASE_URL = "postgres://expense_user:PASSWORD@127.0.0.1:5432/expense_manager_test"`.

## Tests
`npm run test:db` runs `backend/test/postgres-foundation.test.js`. It stops with a clear message if `TEST_DATABASE_URL` is missing, if the database name does not contain "test", or if it equals `DATABASE_URL`. Every test uses its own temporary schema (`em_test_<random>`, dropped afterwards), so tables in `public` and your real database are never touched.

Covered: connection and status; clear messages for a missing URL, a closed port, a wrong password (the password is never printed), a missing database and a malformed URL; first and repeated migrations; a newer-version database refused; a failing migration rolling back completely; three processes migrating at once; tables, indexes, foreign keys and column types; foreign-key, RESTRICT, CHECK, NOT NULL and case-insensitive uniqueness enforcement (including values exactly at the limits); identity columns and insertion order; exact large integers, exact paise arithmetic, the `RangeError` guard; commit, rollback, dry run, same-client behavior, many failures with a 3-connection pool (no leaked clients), concurrent transactions, a killed connection, nesting refusal; pool shutdown, repeated close, close waiting for a running transaction, reopen with data intact.

## Compatibility left for Part 2 and 3
These existing files still use the removed SQLite API and must be migrated; their tests were not changed or weakened:
- `backend/server.js` (startup calls, `translateDatabaseError` which matches `ERR_SQLITE_ERROR`, shutdown, `/api/health`).
- `backend/api/accounts.js`, `categories.js`, `transactions.js` (`getDb().prepare(...)`, `?` placeholders, `rowid`, `lastInsertRowid`).
- `backend/api/importer.js`, `exporter.js` (`runInTransaction` was synchronous).
- Tests: `api.test.js`, `import.test.js`, `server.test.js`, `frontend.test.js` all fail today (`db.getDb is not a function`, server cannot start). SQLite-only assertions in them (`PRAGMA`, `sqlite_master`, `sqlite_sequence`, SQLite trigger, "not a SQLite database") will need PostgreSQL equivalents.
- README and `docs/API.md` still describe SQLite.

## Not done in this part
Express, API/importer/exporter migration, filtering/summary endpoints, frontend changes, copying data from an existing SQLite file. The original SQLite database was never opened or modified.
