# @agex-ts/kvsql

SQLite in the browser on an OPFS file, with every change recorded in a
[kvgit](../kvgit-ts) log: checkpoints and restores, cheap test copies,
and sync between devices through any kvgit remote.

> **Status:** in development. This package so far loads the SQLite build,
> records and applies changesets, and guards the schema. The design is agex-studio's
> [`roadmap/app-db.md`](https://github.com/ashenfad/agex-studio/blob/rebuild/roadmap/app-db.md).

## How it will work

- **The database** is a file in the origin-private file system (OPFS),
  run by the official [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm)
  build in a worker, through synchronous access handles. Opening reads
  only the header, at any size.
- **Every transaction's changes** are captured with SQLite's session
  extension as a changeset, kept in the file until a flush commits a
  batch of them to kvgit as one log entry.
- **Storage is a series of epochs:** a gzipped snapshot plus the log
  since it. A new device downloads the snapshot and replays the log;
  starting a new epoch drops the old one without rewriting history.
- **Checkpoints** are positions in the log, and a restore inverts the
  changesets back to one.

## Loading SQLite

```ts
import { loadSqlite } from '@agex-ts/kvsql'

const sqlite3 = await loadSqlite() // loaded once per page or worker
const db = new sqlite3.oo1.DB(':memory:')
```

The build is pinned to an exact version: the package relies on its VFS
API and its session-extension exports.

## Changesets

A session records what statements change, by primary key; the
changeset it yields is a plain `Uint8Array`.

```ts
import { applyChangeset, startSession } from '@agex-ts/kvsql'

const session = startSession(sqlite3, db) // every table but internal ones
db.exec("UPDATE notes SET title = 'Hi' WHERE id = 'n1'")
const changeset = session.changeset() // everything since it started
session.dispose()

const { applied, conflicts } = applyChangeset(sqlite3, replica, changeset)
```

- `invertChangeset` makes the changeset that undoes one;
  `combineChangesets` merges a sequence into one with the same net
  effect; `changesetOps` lists the rows a changeset touches (table, op,
  column count, key, before and after values).
- `applyChangeset` runs in a savepoint, with triggers and foreign-key
  actions off (the changeset already holds what they did). Its conflict
  policy is `ABORT_ON_CONFLICT` by default: any conflict rolls the whole
  changeset back and returns `applied: false` with the conflicts met.
  `THIS_SIDE_WINS` lets the changeset's values overwrite the database's
  and skips changes to rows the database deleted, but still aborts on a
  constraint or foreign-key violation.
- Tables whose names start with `_kvsql_` are the package's own and
  aren't recorded, nor are SQLite's `sqlite_*` tables.

## The schema guard

The session extension silently skips a table without a primary key, a
row whose key is NULL, and anything outside the main database, so:

- `installGuard(sqlite3, db, { label })` installs an authorizer that
  refuses `ATTACH`, `DETACH`, `VACUUM` and `VACUUM INTO`, virtual
  tables (FTS5, R*Tree) and `load_extension()`, and keeps callers out
  of `_kvsql_*` tables. `guard.run(fn)` turns a refusal into a
  `RefusedError` whose message says what to do instead;
  `guard.trusted(fn)` lifts the refusals for the package's own
  statements. `guard.schemaChanged` reports DDL on the main database.
- `checkSchema(db)`, run after a schema change, lists every table
  without a non-null `PRIMARY KEY`, so the transaction can be rolled
  back. `INTEGER PRIMARY KEY` and `WITHOUT ROWID` keys qualify; any
  other key needs `NOT NULL`.

## Tests

`pnpm test` runs the Node tests. `pnpm test:browser` runs the browser
tests in Chromium; CI also runs them in Firefox and WebKit
(`pnpm test:browser --browser.name=firefox`). Install the browsers once
with `pnpm exec playwright install chromium firefox webkit`.
