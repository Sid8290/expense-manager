# PostgreSQL migration, Part 2: Express server and core APIs

> Written at the end of Part 2; it describes the project as it was then. Later parts finished the work listed as "not done" here. The current state is in [README.md](../README.md) and [POSTGRES_PART5_CHECKPOINT.md](POSTGRES_PART5_CHECKPOINT.md).

**Status: Part 2 of 5 is done.** The server runs on Express with PostgreSQL, and the accounts, categories and transactions APIs work with the unchanged frontend. **Import and export are switched off until Part 3**: `/api/import`, `/api/import/preview` and `/api/export` answer the standard 404, and `backend/test/import.test.js` fails until it is migrated.

## What changed
| File | Change |
| ---- | ------ |
| `backend/server.js` | Rewritten on Express. Same route table and handler contract, same responses. |
| `backend/api/accounts.js`, `categories.js`, `transactions.js` | Async, parameterized (`$1, $2, ...`) queries through `db.query()`. Multi-statement writes run in `db.runInTransaction()`. |
| `backend/test/helpers/pg-test-db.js` (new) | Test safety checks plus one throw-away schema per test file. |
| `backend/test/api.test.js`, `server.test.js`, `frontend.test.js`, `browser-check.js` | Adapted to PostgreSQL (see "Tests"). |
| `package.json`, `package-lock.json` | `express` added; new script `test:part2`. |
| `README.md` | Status notice and health example. The rest of the README still describes SQLite (Part 5). |

## Server (Express)
Kept exactly as before: the JSON envelope; 404 for unknown `/api/...` paths; 405 with an `Allow` header; 415 for a body that is not `application/json` (checked before the body is read); 413 above 64 KB (the limit is per route through `handler.maxBodyBytes`, ready for the 8 MB import); 400 for empty, malformed or non-object JSON with the same codes and messages; case-sensitive and strict routing (`/api/Accounts` and `/api/accounts/` are not `/api/accounts`); HEAD behaves like GET; the health endpoint and its 503; the generic 500; graceful shutdown (the pool is closed after in-flight requests finish).

Choices and why:
- **The route table stays.** Each `routes` object (`path -> { METHOD: handler }`) is registered with Express by `registerApiRoute()`, so the API modules did not need rewriting beyond their queries.
- **`express.json()` reads the body.** It supplies reading, limit and parsing; a few lines map its errors to the existing codes, and `verify` keeps "an empty body is an error" (Express would otherwise treat it as `{}`).
- **The static-file code is unchanged** (its path-traversal, dotfile, symlink and file-type rules are covered by many tests); it is mounted as the last middleware instead of using `express.static`.
- **One error handler** turns `ApiError`, database constraint errors (through `db-errors.js`: 23505 -> 409 `CONFLICT`, 23503 -> 409 `CONSTRAINT_VIOLATION`, 23514/23502 -> 400 `VALIDATION_ERROR`), body-parser errors and URL decoding errors into the documented answers. Anything else is a generic 500 and is logged on the server only.
- `createServer()` still returns a Node `http.Server` (around the Express app), so the tests and `start()` work as before. `createApp()` and `toApiError()` are also exported.

## APIs
- Routes, methods, validation, response shapes and messages are unchanged.
- Account balance is still calculated on every read in SQL: `balance + SUM(income - expense)`, cast to `BIGINT` so it arrives as an exact number. Order: accounts by `seq` (insertion order), transactions by date, created time, then `seq`, categories by id.
- Creating, updating and deleting run in one transaction on one connection (checks and write together). The database constraints remain the safety net for races.
- Category ids are a 32-bit column. SQLite answered a huge id in a URL with 404; PostgreSQL would raise a range error (500). The code now answers 404 (URL) or 400 `VALIDATION_ERROR` (`categoryId` in a body) without querying. `MAX_CATEGORY_ID` is exported from `categories.js`.
- Helpers the importer will use in Part 3 keep their names but are now async: `readBody` (transactions only), `nameTaken`, `insertAccount`, `insertCategory` (returns the new id through `RETURNING`), `insertTransaction`, `allAccounts`, `allCategories`, `allTransactions`. They use `db.query()`, so they automatically join the transaction when called inside `db.runInTransaction()`.

## Tests
Run with `npm run test:part2` (foundation + api + server + frontend). All need `TEST_DATABASE_URL`; each file uses its own temporary schema, dropped at the end, and refuses to run against a database whose name lacks "test".
- `api.test.js`: every existing test kept (69). SQLite-only tests rewritten with SQLSTATE codes. Added 10: concurrent duplicate creates (one winner), balance consistency with 1e9 amounts and fractions, edit/delete moving balances, ids beyond 32 bits, failed writes returning a generic 500 and not exhausting the pool (25 failures with a pool of 10), no category left behind by a failed create, recovery after PostgreSQL drops connections, the error mapping, import/export routes unavailable.
- `server.test.js`: static, security, shutdown and port tests unchanged. The SQLite-only `db module` tests now check the same things on PostgreSQL (not ready before init, FK enforcement, no seeding, migrations not re-run, newer schema refused, unreachable server refused). The two SQLite file tests ("path is a directory", "corrupt file") became "PostgreSQL not reachable", "wrong password (never printed)" and "DATABASE_URL not set". Persistence now checks both the metadata and a record saved through the API. Health now expects `engine: "postgresql"` and `serverVersion` instead of `foreignKeys` (PostgreSQL always enforces them).
- `frontend.test.js`: only the setup changed.
- `browser-check.js` (optional, needs Playwright): setup changed to a PostgreSQL schema. It exercises the unchanged frontend against Express and PostgreSQL.

## Known blockers (Part 3)
- `import.test.js`: all of it fails (`db.getDb is not a function`); it is untouched.
- `api/importer.js` and `api/exporter.js` still use the SQLite code and are not registered.
- Browser check scenarios 4 (first check) and 6 fail only because `/api/import/preview` and `/api/export` answer 404; the pages themselves degrade gracefully.
- `docs/API.md` and most of the README still describe SQLite and the import/export endpoints.

## Remaining work
Part 3: importer and exporter migration (one transaction through `db.runInTransaction`, advisory lock, `import.test.js` and the browser check's migration scenario). Part 4: server-side transaction filtering and summary endpoints. Part 5: documentation (`README.md`, `docs/API.md`), final audit, optional SQLite-to-PostgreSQL data copy.
