# PostgreSQL migration, Part 4: server-side filtering and summaries

**Status: Part 4 of 5 is done.** The transactions page now asks the server for its filtered list and totals. Everything from Parts 1 to 3 is unchanged in behaviour.

## What changed
| File | Change |
| ---- | ------ |
| `backend/api/transaction-filters.js` (new) | Validates the query string and builds a parameterized `WHERE`. |
| `backend/api/summary.js` (new) | `GET /api/summary`. |
| `backend/api/transactions.js` | `GET /api/transactions` accepts the filters and `limit`/`offset`. Everything else is unchanged. |
| `backend/server.js` | Registers the summary route. |
| `frontend/js/api.js` | `listTransactions(filters)` and the new `getSummary(filters)`. |
| `frontend/js/script.js` | The transactions page uses them instead of filtering in the browser. |
| `backend/test/filters.test.js` (new), `frontend.test.js`, `browser-check.js` | Tests (see below). |
| `package.json`, `README.md`, `docs/API.md` | Scripts `test:filters`, `test:part4`; status banner; the filter and summary reference. |

No database change: the existing indexes (date, account, category) are enough and there is no new migration.

## Design decisions
- **The filters are exactly the ones the page already had** (search, type, category, account), plus an inclusive date range, because the API-level range is cheap and the summary needs it. The page has no date inputs, so none were added.
- **Search keeps its old meaning**: a case-insensitive substring of `description category note account amount` joined by spaces. In SQL that is `position(lower($n) in lower(concat_ws(' ', ...)))`, which treats `%` and `_` literally (no `LIKE` escaping needed). An equivalence test runs 15 filter combinations against an independent JavaScript copy of the old browser rules.
- **Strict query strings**: unknown, repeated or malformed parameters are `400`, so a typo such as `acountId` cannot silently return everything. An unfiltered request is unchanged.
- **The list stays a plain array**; the matching count and totals come from `/api/summary` with the same filters. That avoids changing the response shape.
- **All values are `$n` parameters.** Only constant SQL fragments are concatenated; the `WHERE` builder only inserts placeholders.
- **Summary** returns totals, per-category and per-month sums, computed by PostgreSQL on whole paise in one read-only `REPEATABLE READ` transaction (the same technique as the export), so the parts always agree.
- **Frontend**: filter changes are debounced (150 ms), and a request counter ignores an answer that arrives after a newer filter change. If the request fails, the table shows the API's safe message. The page stays hidden (the existing `data-pending` state) until the first filtered table has been drawn, so no placeholder table is shown first; `startPage()` now awaits an initializer that returns a promise.

## Tests
`npm test` runs everything; `npm run test:filters` runs the new file (24 tests; a 25th, in `frontend.test.js`, checks the client methods): every filter, combinations, inclusive date edges, search (case, notes, accounts, amounts, accents, `%`/`_`, SQL-injection strings), paging, every validation error, repeated/unknown parameters, summary totals/categories/months, exactness with 1e9 amounts and fractions, edits and deletes, consistency during concurrent writes, 5 000 rows, and database failure.

## Known limitations
- The dashboard, analytics page and bell notification still add up the transactions they already hold in the browser; only the transactions page uses the server filters and the summary endpoint.
- No date inputs on the transactions page (the API supports `from`/`to`).
- Case-insensitive search uses PostgreSQL's `lower()`, which depends on the database's locale for non-ASCII letters (tested with accented letters on the test database).
- Part 5 is still to do: README and `docs/API.md` rewrite, the Settings page wording about SQLite, optional SQLite-to-PostgreSQL data copy, final audit.
