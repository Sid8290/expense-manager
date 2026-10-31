# PostgreSQL migration, Part 5: finalization and audit

**Status: the planned migration (Parts 1 to 5) is complete.** The app runs on Express and PostgreSQL; documentation matches the code; an optional tool copies data from the old SQLite version.

## What Part 5 changed
| File | Change |
| ---- | ------ |
| `backend/tools/sqlite-to-postgres.js` (new) | The optional SQLite-to-PostgreSQL migration tool (`npm run migrate:sqlite`). |
| `backend/test/sqlite-migration.test.js`, `backend/test/helpers/legacy-sqlite.js` (new) | 26 tests for the tool; the helper builds a legacy SQLite file (a copy of the old schema). |
| `README.md` | Rewritten for PostgreSQL: requirements, database setup, `.env`, scripts, tests, migration tool, limitations. |
| `docs/API.md` | Corrected against the code: endpoint table, health endpoint, PostgreSQL schema, error codes, body limits, removed Stage/Part labels and SQLite statements. |
| `frontend/pages/settings.html` | The FAQ now says the data is stored in the PostgreSQL database (it said SQLite). |
| `docs/STAGE1-4_CHECKPOINT.md`, `FINAL_AUDIT_CHECKPOINT.md`, `POSTGRES_PART1-4_CHECKPOINT.md` | One-line "historical" notes at the top. The content is otherwise untouched. |
| `package.json` | Scripts tidied: the temporary `test:part2/3/4` are gone; added `test:migration`, `test:browser`, `migrate:sqlite`. |

No application code (server, API modules, database layer) changed in Part 5.

## The SQLite migration tool
It was possible to build it reliably because the old schema (version 2) is known exactly from the repository history, and the old data always passed that schema's CHECK and foreign-key rules.

- Source: `--source <file>` (required), opened **read-only**; checked to exist, to be a SQLite database of this app, schema version 2, and free of broken references. It is never created, changed or deleted (tests compare a SHA-256 and the modification time, and check that no journal file appears).
- Destination: `DATABASE_URL` only. Preview is the default; `--apply` is needed to save. A preview runs the real inserts in a transaction and rolls back, so every database rule is exercised.
- One transaction under an advisory lock. Account and transaction ids, category numbers (kept with `OVERRIDING SYSTEM VALUE`, then the identity counter is moved past the highest one), exact paise amounts, dates, notes and `created_at` are copied unchanged, in the old insertion order. Every row is read back and compared, and every migrated account's balance is recomputed, before commit.
- Duplicates and conflicts: identical records already present are skipped, so a second run changes nothing; the same id with different data or a clashing name refuses the **whole** migration (exit code 2, nothing written).
- Errors are reported without the password. Unsupported schema versions are refused, not guessed at.

`node:sqlite` is the only remaining SQLite use: the tool and its test fixture. It is a built-in module (no package), loaded only when the tool runs.

## Audit results
Checked across the whole project:
- **SQLite**: no runtime use in the server, API, database layer or frontend (`grep` for `node:sqlite`, `DatabaseSync`, `getDb` finds only the tool and its test helper). Remaining mentions are comments explaining differences, test names, regexes that check nothing leaks, and the `.gitignore` lines for legacy database files.
- **SQL safety**: every query that takes request data uses `$n` parameters. The only interpolation into SQL text is constants (fixed select lists, the `WHERE` builder that inserts `$n` placeholders, `LIMIT $n`/`OFFSET $n`). No string concatenation reaches `query()`.
- **Transactions**: multi-step writes (create/update/delete, import, migration) run in `runInTransaction`; the export and the summary read inside a read-only `REPEATABLE READ` transaction; imports and the migration take advisory locks.
- **Consistency**: all error responses use the same envelope; unknown, repeated or malformed filter parameters are `400`; database errors never reach the client.
- **Secrets and stray files**: the project contains no `.env`, credentials, database files, logs or generated output; `.env.example` has placeholders only; `.gitignore` ignores `.env`, `node_modules`, `backend/data/`, `*.db`, `*.sqlite*` and logs.
- **Scripts and dependencies**: only `express` and `pg` are dependencies; `npm audit` reports no known vulnerabilities at the time of the check (see the report for the exact output). `engines.node` is `>=22.13.0`.
- **Documentation**: README and `docs/API.md` rewritten from the code; the Settings page wording corrected.

## Remaining limitations
See "Known limitations" in the README. In short: local use only (no authentication), the dashboard/analytics still compute in the browser, no date inputs or record editing in the pages, identity counters can skip, and only Linux was available for testing (see the final report for the platforms tested).
