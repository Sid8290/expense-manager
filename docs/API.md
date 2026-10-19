# Expense Manager: API reference (Stages 2 and 4)

Base URL: `http://127.0.0.1:3000`. All endpoints live under `/api/`. The frontend does **not** use them yet.

## Conventions

- Requests with a body (`POST`, `PUT`) must send `Content-Type: application/json` and a JSON **object**. Other content types get `415`. Bodies over 64 KB get `413`.
- Success: `{ "ok": true, "data": ... }`. Failure: `{ "ok": false, "error": { "code", "message", "details"? } }`. `details` (validation errors only) is a list of `{ "field", "message" }`, and **all** problems are listed at once.
- `PUT` replaces all editable fields (there is no `PATCH`). Unknown fields are rejected, not ignored.
- Money is a JSON **number** with at most 2 decimals, e.g. `45.5`. It is stored as whole paise internally. Strings such as `"45.5"` are rejected.
- Text fields are trimmed before they are checked and stored.
- `DELETE` returns `200` with `{ "ok": true, "data": { "id": ... } }`.
- Deleting a record that other records use is refused with `409 IN_USE`. Nothing is ever cascade-deleted.

## Database schema (migration version 2)

```
accounts      id TEXT PK | name TEXT UNIQUE NOCASE (1-40) | type (cash|bank|online|asset|receivable|payable)
              | balance_minor INTEGER (0 .. 100,000,000,000)
categories    id INTEGER PK AUTOINCREMENT | name (1-30) | type (income|expense)
              | UNIQUE(type, name NOCASE) | UNIQUE(id, type)
transactions  id TEXT PK | type (income|expense) | description (1-100)
              | category_id | account_id -> accounts(id) ON DELETE RESTRICT
              | amount_minor INTEGER (1 .. 100,000,000,000) | note (0-200) | date 'YYYY-MM-DD' | created_at INTEGER (ms)
              | FOREIGN KEY (category_id, type) -> categories(id, type) ON DELETE RESTRICT
```

The composite foreign key means the database itself guarantees an income transaction can only use an income category, and that a category cannot change type while transactions use it. `PRAGMA foreign_keys = ON` is set and verified on the connection. Tables start empty (nothing is seeded).

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
| GET | `/api/transactions` | 200, list | Newest `date` first, then newest `createdAt` (the frontend's order) |
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

## Import and export (Stage 4)

### `POST /api/import/preview` and `POST /api/import`

Both take the **legacy backup** document (the file the Settings page downloads) and run exactly the same code. `preview` plans the import inside a SQLite transaction and **rolls it back**, so it never changes the database. `import` runs the same plan, **commits** it, and requires `"confirm": true` (otherwise `400 CONFIRMATION_REQUIRED`). The import re-plans against the database as it is at that moment; an earlier preview is not trusted.

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

- **All or nothing.** One transaction (`BEGIN IMMEDIATE`). Order: accounts, categories, transactions. Any unexpected failure rolls everything back (`500 IMPORT_FAILED` / `PREVIEW_FAILED`, "Nothing was saved").
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

Records have the same shape the list endpoints return. This document is **not** importable (the importer rejects it with a clear message), and it is read-only: exporting changes nothing.

## Error codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_JSON` | Body missing, empty or not valid JSON |
| 400 | `INVALID_BODY` | Valid JSON but not an object (array, `null`, string, ...) |
| 400 | `VALIDATION_ERROR` | A field is missing, has the wrong type or value, is unknown, or points to a record that does not exist or does not fit. See `details` |
| 400 | `INVALID_ID` | The id in the URL has an invalid format |
| 404 | `NOT_FOUND` | No such record, or no such API path |
| 405 | `METHOD_NOT_ALLOWED` | Method not supported for the path (see the `Allow` header) |
| 409 | `CONFLICT` | Duplicate id or name |
| 409 | `IN_USE` | Delete (or type change) refused because transactions use the record |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 64 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content type is not `application/json` |
| 500 | `INTERNAL_ERROR` | Unexpected failure. The message is generic; details are only in the server console |
| 503 | `DATABASE_NOT_READY` | `/api/health` only, when the database is not usable |

## Trying it on Windows (PowerShell)

Start the server in one window (`npm start`), then in another:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/accounts

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/accounts `
  -ContentType 'application/json' `
  -Body '{"name":"Cash","type":"cash","balance":1000}'
```

Records you create this way stay in `backend/data/expense-manager.db` and do not appear in the app yet. To start from a clean database, stop the server and delete that file.
