# Expense Manager: API reference

Base URL: `http://127.0.0.1:3000` (set `HOST` and `PORT` to change it). All endpoints live under `/api/`; the frontend pages use them for every financial record. The server is Express, the data is in PostgreSQL.

Endpoints at a glance:

| Path | Methods |
| --- | --- |
| `/api/health` | GET |
| `/api/accounts`, `/api/accounts/:id` | GET, POST / GET, PUT, DELETE |
| `/api/categories`, `/api/categories/:id` | GET, POST / GET, PUT, DELETE |
| `/api/transactions`, `/api/transactions/:id` | GET (with filters), POST / GET, PUT, DELETE |
| `/api/summary` | GET |
| `/api/import/preview`, `/api/import` | POST |
| `/api/export` | GET |

Routes are matched exactly: a different letter case (`/api/Accounts`) or a trailing slash (`/api/accounts/`) is a `404`. `HEAD` works wherever `GET` does. Any other method on a known path is `405` with an `Allow` header (including `OPTIONS`; there is no CORS).

## Conventions

- Requests with a body (`POST`, `PUT`) must send `Content-Type: application/json` and a JSON **object**. Other content types get `415` (checked before the body is read). Bodies over 64 KB get `413`; only the two import endpoints accept up to 8 MB.
- Success: `{ "ok": true, "data": ... }`. Failure: `{ "ok": false, "error": { "code", "message", "details"? } }`. `details` (validation errors only) is a list of `{ "field", "message" }`, and **all** problems are listed at once.
- `PUT` replaces all editable fields (there is no `PATCH`). Unknown fields are rejected, not ignored.
- Money is a JSON **number** with at most 2 decimals, e.g. `45.5`. It is stored as whole paise internally. Strings such as `"45.5"` are rejected.
- Text fields are trimmed before they are checked and stored.
- `DELETE` returns `200` with `{ "ok": true, "data": { "id": ... } }`.
- Deleting a record that other records use is refused with `409 IN_USE`. Nothing is ever cascade-deleted.

## Health: `GET /api/health`

Asks the database for its real, current state (it does not trust a flag set at startup).

```
200 {"ok":true,"data":{"status":"ok","server":{"running":true,"uptimeSeconds":12},
     "database":{"ready":true,"engine":"postgresql","serverVersion":"16.15","schemaVersion":2}}}

503 {"ok":false,"data":{"status":"degraded",...,"database":{"ready":false,"engine":"postgresql"}},
     "error":{"code":"DATABASE_NOT_READY","message":"The database is not ready."}}
```

It never contains the connection URL, user name or password.

## Database schema (PostgreSQL, schema version 2)

Created and upgraded automatically at startup (`backend/db.js`, numbered migrations recorded in `schema_migrations`; a database with a newer version than the app understands is refused).

```
accounts      seq BIGINT identity (insertion order) | id TEXT PK (1-64) | name TEXT (1-40, unique ignoring case)
              | type (cash|bank|online|asset|receivable|payable) | balance_minor BIGINT (0 .. 100,000,000,000)
categories    id INTEGER identity PK | name (1-30) | type (income|expense)
              | UNIQUE(type, lower(name)) | UNIQUE(id, type)
transactions  seq BIGINT identity | id TEXT PK (1-64) | type (income|expense) | description (1-100)
              | category_id INTEGER | account_id -> accounts(id) ON DELETE RESTRICT
              | amount_minor BIGINT (1 .. 100,000,000,000) | note (0-200) | date TEXT 'YYYY-MM-DD' | created_at BIGINT (ms)
              | FOREIGN KEY (category_id, type) -> categories(id, type) ON DELETE RESTRICT
app_meta, schema_migrations   bookkeeping
```

Money is stored as whole minor units (paise), so sums are exact. The composite foreign key means the database itself guarantees an income transaction can only use an income category, and that a category cannot change type while transactions use it. Foreign keys are always enforced by PostgreSQL. Tables start empty (nothing is seeded). Every database query uses `$1, $2, ...` parameters.

## Accounts: `/api/accounts`

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| GET | `/api/accounts` | 200, list | In creation order |
| POST | `/api/accounts` | 201 + `Location` | Body: `name`, `type`, `balance` (initial, >= 0, <= 1,000,000,000), optional `id` |
| GET | `/api/accounts/:id` | 200 | |
| PUT | `/api/accounts/:id` | 200 | Body: `name`, `type`, `balance` |
| DELETE | `/api/accounts/:id` | 200 | 409 if any transaction uses it |

An account is `{ id, name, type, balance, currentBalance }`. `balance` is the initial balance the frontend stores. `currentBalance` is read-only and is calculated on every read exactly like the frontend's `getAccountBalance()`: `balance + income - expense` for that account. If `id` is omitted the server creates `acc-<uuid>`. Names are unique ignoring case (409 `CONFLICT`). An account that has transactions cannot be changed to `asset`, `receivable` or `payable` (409 `IN_USE`).

```
POST /api/accounts        {"id":"acc-cash","name":"Cash","type":"cash","balance":1000}
-> 201 Created, Location: /api/accounts/acc-cash
{"ok":true,"data":{"id":"acc-cash","name":"Cash","type":"cash","balance":1000,"currentBalance":1000}}

GET /api/accounts/acc-cash   (after a 45.50 expense)
{"ok":true,"data":{"id":"acc-cash","name":"Cash","type":"cash","balance":1000,"currentBalance":954.5}}

DELETE /api/accounts/acc-cash   (while a transaction uses it)
-> 409 {"ok":false,"error":{"code":"IN_USE","message":"\"Cash\" is used by 1 transaction and cannot be deleted."}}
```

## Categories: `/api/categories`

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| GET | `/api/categories` | 200, list | In creation order |
| POST | `/api/categories` | 201 + `Location` | Body: `name`, `type` (`income` or `expense`) |
| GET | `/api/categories/:id` | 200 | `:id` is a positive whole number |
| PUT | `/api/categories/:id` | 200 | Body: `name`, `type` |
| DELETE | `/api/categories/:id` | 200 | 409 if any transaction uses it |

A category is `{ id, name, type }`. Names are unique **per type**, ignoring case, so "Other" can exist as both an income and an expense category. Renaming a used category is allowed (transactions refer to the id and show the new name). Changing the `type` of a used category is refused (409 `IN_USE`).

```
POST /api/categories   {"name":"Groceries","type":"expense"}
-> 201 {"ok":true,"data":{"id":1,"name":"Groceries","type":"expense"}}
```

## Transactions: `/api/transactions`

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| GET | `/api/transactions` | 200, list | Newest `date` first, then newest `createdAt` (the frontend's order). Optional filters: see [Filtering and summary](#filtering-and-summary) |
| POST | `/api/transactions` | 201 + `Location` | Body below |
| GET | `/api/transactions/:id` | 200 | |
| PUT | `/api/transactions/:id` | 200 | Same fields as POST except `id` and `createdAt` (which never change) |
| DELETE | `/api/transactions/:id` | 200 | |

Body fields: `type` (`income`/`expense`), `description` (1-100), `categoryId` (existing category whose type equals `type`), `accountId` (existing **cash, bank or online** account), `amount` (> 0, <= 1,000,000,000, at most 2 decimals), `date` (`YYYY-MM-DD`, a real date, not in the future), optional `note` (<= 200, default `""`), and on POST only, optional `id` and `createdAt` (milliseconds; both kept as given so existing records can be imported later). If omitted, `id` is `txn-<uuid>` and `createdAt` is the current time.

A transaction is `{ id, type, description, categoryId, category, accountId, amount, note, date, createdAt }`. `category` is the category **name** (what the frontend shows today); `categoryId` is what you send.

```
POST /api/transactions
{"id":"txn-1","type":"expense","description":"Milk","categoryId":1,"accountId":"acc-cash","amount":45.5,"note":"","date":"2025-03-04","createdAt":1741046400000}
-> 201 {"ok":true,"data":{"id":"txn-1","type":"expense","description":"Milk","categoryId":1,"category":"Groceries","accountId":"acc-cash","amount":45.5,"note":"","date":"2025-03-04","createdAt":1741046400000}}

POST /api/transactions   (amount 1.234, income type with an expense category)
-> 400 {"ok":false,"error":{"code":"VALIDATION_ERROR","message":"The request contains invalid data.","details":[
     {"field":"amount","message":"Must have at most 2 decimal places."},
     {"field":"categoryId","message":"This is an expense category, but the transaction type is income."}]}}
```

## Filtering and summary

`GET /api/transactions` accepts optional query parameters, and `GET /api/summary` accepts the same filters. All are optional, combine with AND, and an empty value counts as absent.

| Parameter | Meaning |
| --- | --- |
| `type` | `income` or `expense` |
| `categoryId` | a category id (positive whole number) |
| `category` | a category name, exact match (a name shared by an income and an expense category matches both) |
| `accountId` | an account id |
| `from`, `to` | `YYYY-MM-DD`, both inclusive; may be in the future; `from` must not be after `to` |
| `search` | text (max 100), matched ignoring case anywhere in the description, category name, note, account name or amount (written like `12.5`); `%` and `_` are ordinary characters |
| `limit`, `offset` | paging, **list only**: `limit` 1 to 500, `offset` 0 or more; same order as the unfiltered list |

Invalid, repeated or unknown parameters give `400 VALIDATION_ERROR` with every problem in `details`. An id or name that matches nothing is simply an empty result. Without any parameter the list is exactly what it was before. `/api/transactions/:id` ignores query strings.

### `GET /api/summary`

```json
{
  "filters": { "type": "expense" },
  "totals": { "count": 7, "income": 0, "expense": 655.8, "balance": -655.8 },
  "byCategory": [ { "categoryId": 2, "category": "Rent", "type": "expense", "total": 600, "count": 2 } ],
  "byMonth": [ { "month": "2025-01", "income": 0, "expense": 312.8, "balance": -312.8, "count": 4 } ]
}
```

`balance` is `income - expense` of the matching transactions (not an account balance; those are `currentBalance` on `/api/accounts`). `byCategory` lists the biggest total first (ties by name); `byMonth` lists the oldest month first. An empty result is zeros and empty lists. The sums are done by PostgreSQL on whole paise, so they are exact, and all three parts are read in one read-only `REPEATABLE READ` transaction, so they always agree with each other.

## Import and export

### `POST /api/import/preview` and `POST /api/import`

Both take the **legacy backup** document (the file the Settings page downloads) and run exactly the same code. Both run inside one PostgreSQL transaction on one connection (`BEGIN` ... `COMMIT`). `preview` plans the import and then **rolls the transaction back**, so it never changes the database (it can only leave gaps in the numbering of new category ids, because PostgreSQL never hands an id out twice). A transaction-level advisory lock makes imports run one at a time, so two simultaneous imports of the same file give one `imported` result and one `duplicateInDatabase` result instead of an error. If anything fails unexpectedly, the whole transaction is rolled back (`500 IMPORT_FAILED` / `PREVIEW_FAILED`, "nothing was saved") and no partial data remains. Every record that was written is read back and compared before `COMMIT`. `import` runs the same plan, **commits** it, and requires `"confirm": true` (otherwise `400 CONFIRMATION_REQUIRED`). The import re-plans against the database as it is at that moment; an earlier preview is not trusted.

```json
{
  "format": "expense-manager-legacy-backup",
  "version": 1,
  "exportedAt": "2026-01-01T10:00:00.000Z",
  "data": {
    "accounts":     [ { "id": "acc-1", "name": "Savings", "type": "bank", "balance": 300 } ],
    "categories":   [ { "name": "Food", "type": "expense" } ],
    "transactions": [ { "id": "txn-1", "type": "expense", "description": "Tea", "category": "Food",
                        "accountId": "acc-1", "amount": 12.5, "note": "", "date": "2025-01-05", "createdAt": 1736000000000 } ]
  },
  "confirm": true
}
```

Other top-level keys (`source`, `complete`, `problems`, `unreadable`, ...) are allowed and ignored. `data` may only contain `accounts`, `categories`, `transactions`.

Rules:

- **All or nothing.** One PostgreSQL transaction. Order: accounts, categories, transactions. Any unexpected failure rolls everything back (`500 IMPORT_FAILED` / `PREVIEW_FAILED`, "Nothing was saved").
- **Same validation as the normal API** (the same `readBody` functions). Invalid records are *rejected* with a reason; the rest are still imported (`complete: false`).
- **Never overwrites.** Same id with identical data = `duplicate-in-database` (skipped). Same id with different data, or a taken name = `rejected` (conflict).
- Ids are preserved. A legacy category is matched to a database category by (type, name ignoring case); the transaction gets that category's numeric id.
- The old version's two default accounts and two default categories are skipped (`old-default-unused`) unless a transaction uses them.
- A transaction whose account or category cannot be found is `unresolved-reference` and is not imported (nothing is guessed).
- Repeating the same import imports 0 records (idempotent).
- Limits: body 8 MB; 500 accounts, 500 categories, 20000 transactions (`LIMIT_EXCEEDED`).

Response `data`:

```json
{
  "mode": "preview",
  "complete": true,
  "counts": {
    "accounts": { "received": 1, "imported": 1, "duplicateInDatabase": 0, "duplicateInFile": 0,
                  "oldDefaultNotImported": 0, "rejected": 0, "conflicts": 0, "unresolvedReferences": 0 },
    "categories": { "...": "same fields" },
    "transactions": { "...": "same fields" }
  },
  "items": { "accounts": [], "categories": [], "transactions": [], "transactionsTruncated": false },
  "verification": { "recordsChecked": 3, "recordsMatching": 3 },
  "databaseBefore": { "accounts": 0, "categories": 0, "transactions": 0 },
  "databaseAfter":  { "accounts": 1, "categories": 1, "transactions": 1 }
}
```

`items.*` entries are `{ index, outcome, id?, label?, reason? }`; outcomes: `imported`, `duplicate-in-database`, `duplicate-in-file`, `old-default-unused`, `rejected`, `unresolved-reference`. For transactions, imported ones are not listed and at most 200 are returned (`transactionsTruncated`). After a real import every written record is read back and compared (`verification`). In `preview` mode `databaseAfter` shows what the database *would* contain.

Import-specific error codes: `UNSUPPORTED_FORMAT`, `UNSUPPORTED_VERSION`, `INVALID_BODY`, `UNSUPPORTED_ENTITY`, `LIMIT_EXCEEDED`, `CONFIRMATION_REQUIRED` (all 400), `IMPORT_FAILED` / `PREVIEW_FAILED` (500).

### `GET /api/export`

A versioned JSON export of the database (for backup and checking):

```json
{
  "format": "expense-manager-database-export",
  "version": 1,
  "exportedAt": "2026-01-01T10:00:00.000Z",
  "counts": { "accounts": 1, "categories": 1, "transactions": 1 },
  "data": {
    "accounts":     [ { "id": "acc-1", "name": "Savings", "type": "bank", "balance": 300, "currentBalance": 287.5 } ],
    "categories":   [ { "id": 1, "name": "Food", "type": "expense" } ],
    "transactions": [ { "id": "txn-1", "type": "expense", "description": "Tea", "categoryId": 1, "category": "Food",
                        "accountId": "acc-1", "amount": 12.5, "note": "", "date": "2025-01-05", "createdAt": 1736000000000 } ]
  }
}
```

The three lists are read in one read-only `REPEATABLE READ` transaction, so they come from one consistent snapshot even if another request is writing at the same time. Records have the same shape the list endpoints return. This document is **not** importable (the importer rejects it with a clear message), and it is read-only: exporting changes nothing.

## Error codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_JSON` | Body missing, empty or not valid JSON |
| 400 | `INVALID_BODY` | Valid JSON but not an object (array, `null`, string, ...) |
| 400 | `VALIDATION_ERROR` | A field is missing, has the wrong type or value, is unknown, or points to a record that does not exist or does not fit. See `details` |
| 400 | `INVALID_ID` | The id in the URL has an invalid format |
| 404 | `NOT_FOUND` | No such record, or no such API path |
| 405 | `METHOD_NOT_ALLOWED` | Method not supported for the path (see the `Allow` header) |
| 409 | `CONFLICT` | Duplicate id or name (also when two requests race and the database's unique index rejects the second) |
| 409 | `CONSTRAINT_VIOLATION` | The database refused a change because other records are linked to it |
| 409 | `IN_USE` | Delete (or type change) refused because transactions use the record |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the limit (64 KB; 8 MB for the import endpoints) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content type is not `application/json` |
| 400 | `UNSUPPORTED_FORMAT`, `UNSUPPORTED_VERSION`, `UNSUPPORTED_ENTITY`, `LIMIT_EXCEEDED`, `CONFIRMATION_REQUIRED` | Import documents only (see above) |
| 500 | `INTERNAL_ERROR` | Unexpected failure (including a database error). The message is generic; details are only in the server console |
| 500 | `IMPORT_FAILED`, `PREVIEW_FAILED` | The import or preview failed and nothing was saved |
| 503 | `DATABASE_NOT_READY` | `/api/health` only, when the database is not usable |

## Trying it on Windows (PowerShell)

Start the server in one window (`npm start`), then in another:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
Invoke-RestMethod http://127.0.0.1:3000/api/accounts

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/accounts `
  -ContentType 'application/json' `
  -Body '{"name":"Cash","type":"cash","balance":1000}'

Invoke-RestMethod 'http://127.0.0.1:3000/api/summary?type=expense'
```

Records created this way are real records in your database and appear in the app. To remove them, delete them in the app or through `DELETE` requests.
