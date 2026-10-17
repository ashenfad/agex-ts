# @agex-ts/kvsql

SQLite in the browser on an OPFS file, with every change recorded in a
[kvgit](../kvgit-ts) log: checkpoints and restores, cheap test copies,
and sync between devices through any kvgit remote.

> **Status:** in development. This package so far runs SQLite on a file
> in OPFS (or in memory) through its own VFS, records and applies
> changesets, guards the schema, keeps the changeset log in kvgit
> with crash recovery and replay, and serves the database from a
> worker to every tab; rebase, snapshots and epochs come next. The design is agex-studio's
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

## Opening a database

A database is a file in a `Directory`, with its rollback journal beside
it as `<name>-journal` (so a database's own name can't end in
`-journal`). In a browser the directory is in OPFS, which
works only in a dedicated worker (synchronous access handles exist only
there):

```ts
import { OpfsDirectory, openDatabase } from '@agex-ts/kvsql'

const dir = await OpfsDirectory.at('my-app') // created if missing
const file = await openDatabase(dir, 'app.db')
file.db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
file.db.exec({ sql: 'INSERT INTO t (v) VALUES (?)', bind: ['hello'] })
file.close() // closes the connection and releases the files
```

`file.db` is an `oo1.DB` from `@sqlite.org/sqlite-wasm`.
`deleteDatabase(dir, name)` removes a closed database and its journal.
`MemoryDirectory` is the same in memory, for Node and tests;
`image()` copies its files out and `new MemoryDirectory(image)` starts
from a copy.

- **Crash-safe by itself.** The database runs in PERSIST journal mode
  with a 1 MiB `journal_size_limit`: a rollback journal on a real file,
  which SQLite rolls back from on the next open after a crash.
- **One connection per database.** A second `openDatabase` of an open
  database fails, in the same worker by the VFS's registry and across
  workers and tabs by OPFS's exclusive access handles. WebKit, unlike
  Chromium and Firefox, lets another context delete an open OPFS file,
  so keep deletes behind whatever lock guards the database.
- **No WAL.** `PRAGMA journal_mode=WAL` is refused: it needs shared
  memory the VFS doesn't provide.
- **Temp files in memory.** Temp tables, sorts and statement journals
  never reach the directory.

### Your own directory

A `Directory` opens, deletes and checks named files, asynchronously; a
`SyncFile` it opens is read, written, truncated, synced and sized
synchronously, as SQLite's VFS needs. `openDatabase` opens the
database file and its journal before SQLite asks for them.

### Crash testing

`CrashingDirectory` wraps any directory and dies at a chosen
operation: `crashAt({ op: 'write' | 'truncate' | 'sync', n, torn? })`
fails the `n`th such operation (a torn write lands its first `torn`
bytes) and every operation after it, so the underlying files hold what
a process that died there would leave. `ops` counts operations, to
crash at each in turn.

```ts
const mem = new MemoryDirectory(image)
const dir = new CrashingDirectory(mem)
const file = await openDatabase(dir, 'app.db')
dir.crashAt({ op: 'write', n: 3, torn: 100 })
// ...run a transaction, which throws SimulatedCrash...
file.close()
const after = await openDatabase(new MemoryDirectory(mem.image()), 'app.db')
```

## The logged database

`openLog` opens a database whose every transaction is recorded in a
changeset log on a kvgit branch. The caller brings the `Repo` (its
codec must store bytes as they are: `'bytes'`, the default) and names
the branch:

```ts
import { openLog } from '@agex-ts/kvsql'

const db = await openLog({ dir, name: 'app.db', repo, branch: 'db/abc/0', label: 'agex.db' })
await db.query('CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, title TEXT, start INTEGER)')
const { rows } = await db.query('SELECT * FROM events WHERE start >= ?', [from])
await db.transaction([
  ['UPDATE accounts SET balance = balance - ? WHERE id = ?', [10, 'a1']],
  ['UPDATE accounts SET balance = balance + ? WHERE id = ?', [10, 'a2']],
])
await db.close() // flushes first
```

- **Calls.** Each `query(sql, params)` is one transaction;
  `transaction([[sql, params], ...])` runs several as one. Each returns
  `{ rows, changes, lastInsertRowid }` (an array of them for a
  transaction). A failing statement rolls the whole call back; in a
  transaction its error is a `StatementError` with the statement's
  `index`. Calls run one at a time, in order.
- **Behind the schema guard.** `BEGIN`, `COMMIT` and `ROLLBACK` are
  refused (each call already is a transaction; savepoints work inside
  one), as is everything the guard refuses, and a schema change that
  leaves a table without a non-null primary key is rolled back.
- **Foreign keys** are enforced by default (`foreignKeys: false` turns
  them off): an app that declares `REFERENCES` expects it, and a replay
  only notices a broken foreign key when they're on.
- **What's logged.** A call's changes are recorded as a changeset and
  written into the file's pending table (`_kvsql_pending`) inside the
  call's own transaction, so the file's commit makes it durable on the
  device. A call that changed the schema (DDL, `PRAGMA user_version` or
  `application_id`) is logged instead as its SQL, every statement in
  order, with the `foreign_keys` setting it ran under, and bumps
  `schemaVersion`. Replay runs that SQL again, so it must give the same
  result anywhere: a schema-changing call that uses `random()`, the
  clock or the change counters is refused (change rows in a call of
  their own, where values are recorded as written), and so is one that
  uses a TEMP table or view an earlier call made, since other copies
  don't have it. Column defaults
  that read the clock, and queries whose result depends on row order
  without an `ORDER BY`, aren't caught.
- **Flushes** commit every pending transaction to the log as one entry:
  every 100 transactions (`flush.every`), when the oldest pending one is
  2 s old (`flush.maxAgeMs`), after a schema change, on `flush()`, and
  on `close()`. A flush the policy started that fails leaves the
  transactions pending (and calls `onFlushError`); `flush()` throws.
- **Opening** brings the file level with the branch: entries it didn't
  write are replayed (so an empty directory rebuilds the database from
  the log), and an entry matching its pending transactions is its own
  flush, interrupted before it could delete them. A file with pending
  transactions on a branch that has entries it didn't write needs a
  rebase, which isn't supported yet: `RebaseRequiredError`.
- **Replay** combines runs of changesets and applies them in chunks of
  up to 100k transactions or 32 MiB, stopping at any conflict
  (`ReplayError`): in a log written only by appending there is none, so
  one means divergence. A changeset written under another schema
  version, or recording a column count a table doesn't have (which
  SQLite would skip silently), is refused the same way.

### The log format

The log is the branch's first-parent chain of commits; each holds one
entry under the key `entry`, overwritten by every flush. Transactions
are numbered from 1 across the whole log. An entry is a format byte (1)
followed by CBOR: an array of pieces `[kind, from, to, schema, body]`,
where kind 0 is a changeset of transactions `from` to `to` and kind 1 a
schema change (`body` is CBOR `{foreignKeys, statements}`). A run of
changesets is stored merged when that makes it at most half its size
(a run rewriting the same rows), and otherwise packed one per
transaction, each a restore point. Each commit's info is
`{v: 1, from, to, length, digest, schema}`: the range, the entry's
byte length and SHA-256, and the schema version after it; a reader
refuses an entry that doesn't match them (`CorruptEntryError`).

## In a worker, from every tab

OPFS's synchronous handles exist only in dedicated workers, so a page
runs its database in one and talks to it with a client. The client,
`@agex-ts/kvsql/client`, loads neither SQLite nor kvgit.

```ts
import { connect } from '@agex-ts/kvsql/client'
// Vite; elsewhere, new Worker(new URL('@agex-ts/kvsql/worker', import.meta.url), { type: 'module' })
import KvsqlWorker from '@agex-ts/kvsql/worker?worker'

const db = connect(new KvsqlWorker(), { id: 'calendar', label: 'agex.db' })
await db.query('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY NOT NULL, title TEXT)')
const { rows } = await db.query('SELECT * FROM events')
await db.close()
```

- **The calls** are the logged database's (`query`, `transaction`,
  `flush`, `close`), as promises, plus `info()` (the database's
  sequence number, pending count, recovery, last flush error) and
  `status()` (this tab's part, below). Values cross as structured
  clones, so blobs stay `Uint8Array` and big integers bigint.
- **Errors arrive as their classes:** kvsql's (`RefusedError`,
  `StatementError` with its `index`, `RebaseRequiredError`, ...) and
  JavaScript's, with their fields and cause, so `instanceof` works on
  the page. Other errors (SQLite's own, a store's) arrive as an `Error`
  with their `name` and fields, a DOMException as a DOMException.
- **The config** names the database: `id` (required), and optionally
  `name` (the file, default `db.sqlite`), `branch` (default
  `kvsql/<id>`), `label`, `foreignKeys` and `flush`. Every tab passes
  the same config for the same database, and a worker refuses a second
  connect to an id with a different one.
- **The default worker** (`@agex-ts/kvsql/worker`) keeps each database
  with `openDefault`: the file in OPFS directory `kvsql/<id>` and the
  log on IndexedDB database `kvsql:<id>` (config `directory` and
  `indexedDB` change them).
- **Flushes on hide.** The client flushes when the page is hidden and
  on `pagehide`, which a worker can't see, best effort
  (`flushOnHide: false` turns it off). `onFlushError` hears of a flush
  the policy started that failed, in whichever tab ran it.

### Your own worker

An app that keeps its log in a repository of its own writes the worker
itself: `serve` takes the function that opens a database's storage from
its config.

```ts
// db.worker.ts
import { OpfsDirectory, serve } from '@agex-ts/kvsql'
import { repo } from './my-repo' // a Repo<Uint8Array>, or a promise of one

serve(async (config) => ({ dir: await OpfsDirectory.at('dbs', config.id), repo: await repo }))
```

The opener runs in the worker that takes the database's lock, each time
it opens it. It returns `{ dir, repo }`, and may add `close()` (called
after the database closes) and `destroy()` (called when it is deleted,
to remove what was the database's alone). Config fields of the app's
own reach the opener as they are. `serve(open, { scope: null })`
listens for nothing and leaves the app to pass `server.connect(config,
port)` the ports from its own messages.

### Many tabs, one writer

Each tab runs its own worker, but a database's file can be open in only
one: its access handles are exclusive.

- **A Web Lock, `kvsql:<id>`,** is held by the worker that has the file
  open, for as long as it has it. The other tabs' workers wait in the
  lock's queue and meanwhile send their requests to the holder over a
  `BroadcastChannel` of the same name. `status().role` is `holder` or
  `forwarding` (`connecting` until the holder answers; `opening`,
  `failed` while it opens or after it failed to; `closed`).
- **When the holder's tab closes,** the browser releases its lock (as
  it does for a terminated worker), and the next worker in the queue
  takes it, opens the file (the log's recovery runs: transactions it
  committed are there, pending, and flush as usual) and serves every
  tab. A holder whose last connection closes flushes, closes the file
  and lets the lock go, and its unanswered requests go to the next
  holder: nothing it ran goes unanswered.
- **A busy holder lets go late.** A worker terminated while SQLite runs
  a statement stops when the engine can interrupt it: at once in
  Firefox, after about 2 s in Chromium, and in WebKit only once the
  statement returns (WebKit can't stop a worker inside a WebAssembly
  call). Its lock, and so the takeover, waits until then.
- **A request lost with the holder** fails with `ConnectionLostError`:
  sent, not answered, and the worker running it went away, so it may or
  may not have committed. Nothing retries a query or transaction,
  since the client can't tell a read from a write; retry it yourself,
  written so running it twice is safe. `flush()`, `info()` and
  `delete()` are safe to repeat, and are sent again to the next holder.
- **Delete through a client:** `db.delete()` runs on the holder, under
  the lock, after every call it received before: it closes the
  database, deletes the file, its journal and the log's branch (and,
  with the default worker, the directory and IndexedDB database),
  closes every tab's connection, and keeps the lock until the other
  workers have left its queue, so none of them opens it again. Don't
  delete a database's files in any other way: WebKit lets one context
  delete a file another has open, and the database is lost when it
  closes. `db.delete({ keepLog: true })` deletes only this device's
  file, after flushing its pending transactions (if that fails, nothing
  is deleted), and rebuilds it from the log at once; a file that fails
  to open can be deleted either way, though its unflushed transactions
  are lost.

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
  actions off (the changeset already holds what they did); SQLite can't
  switch TEMP triggers off, so it refuses a connection that has any. Its conflict
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
  tables (FTS5, R*Tree), TEMP triggers (which would fire again on
  replay), `load_extension()`, and setting the pragmas
  that change how the file is written (`journal_mode`, `locking_mode`,
  `synchronous`, `writable_schema`, `schema_version`, `page_size`,
  `auto_vacuum`) or that change what statements do on this connection
  only, so replayed SQL would act differently elsewhere
  (`recursive_triggers`, `case_sensitive_like`), `BEGIN`, `COMMIT` and
  `ROLLBACK` (savepoints stay allowed), and keeps callers out of
  `_kvsql_*` tables. `guard.run(fn)` turns a refusal into a
  `RefusedError` whose message says what to do instead;
  `guard.trusted(fn)` lifts the refusals for the package's own
  statements. `guard.schemaChanged` reports DDL on the main database,
  and setting `PRAGMA user_version` or `application_id`, which the
  session extension doesn't record either. `guard.nondeterministic`
  names the first function a statement called whose result can differ
  between runs (`random()`, the date and time functions, the change
  counters), and `guard.tempDependency` the first TEMP table or view a
  statement used that no statement since the last reset created, for a
  runner that replays a call's SQL.
- `checkSchema(db)`, run after a schema change, lists every table
  without a non-null `PRIMARY KEY`, so the transaction can be rolled
  back. `INTEGER PRIMARY KEY` and `WITHOUT ROWID` keys qualify; any
  other key needs `NOT NULL`.

## Tests

`pnpm test` runs the Node tests. `pnpm test:browser` runs the browser
tests in Chromium; CI also runs them in Firefox and WebKit
(`pnpm test:browser --browser.name=firefox`). The worker host's Node
tests run the handoff between tabs over in-memory locks and channels;
its browser tests stand in for tabs with dedicated workers of one page,
since Web Locks and `BroadcastChannel` are origin-wide. Install the
browsers once with `pnpm exec playwright install chromium firefox
webkit`.

The browser tests run each page in a persistent Playwright profile (a
temporary directory): WebKit has no OPFS in Playwright's default
private contexts, and the other browsers keep private storage off the
disk.
