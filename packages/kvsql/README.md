# @agex-ts/kvsql

SQLite in the browser on an OPFS file, with every change recorded in a
[kvgit](../kvgit-ts) log: checkpoints and restores, cheap test copies,
and sync between devices through any kvgit remote.

> **Status:** in development. This package so far runs SQLite on a file
> in OPFS (or in memory) through its own VFS, records and applies
> changesets, guards the schema, keeps the changeset log in kvgit
> with crash recovery and replay, copies a database, starts new epochs
> from snapshots, takes checkpoints and restores them, and serves the
> database from a worker to every tab, and rebases one device's
> changes onto another's; sync between devices comes next. The design is agex-studio's
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
it as `<name>-journal`, and, while a new epoch's snapshot or a restore
is made, `<name>-snapshot` and `<name>-restore` (so a database's own
name can't end in `-journal`, `-snapshot` or `-restore`). In a browser the directory is in OPFS, which
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
  `application_id`, `ANALYZE`) is logged instead as its SQL, every
  statement in order, with the `foreign_keys` setting it ran under, and
  bumps `schemaVersion`. Only a real change counts: DDL that turns out
  a no-op (`CREATE TABLE IF NOT EXISTS` on a table that exists, as an
  app runs on every load) leaves the file's schema cookie as it was,
  and the call is logged as rows. Replay runs that SQL again, so it must give the same
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
- **Export:** `export()` gives the database as a standalone SQLite
  file's bytes (its schema, rows and `user_version`, without kvsql's
  own tables, vacuumed), for any SQLite tool. It holds every committed
  transaction, flushed or not. The copy is made in memory (`VACUUM
  INTO` an in-memory database), so it briefly costs about twice the
  file's size there.
- **Copies:** `copy({ dir, name })` writes the database, as it stands
  between calls, to the file `name` in `dir` as a **detached copy**: a
  database with no log, for a test to run on. Its file is copied as it
  is, a chunk at a time, so a copy of any size never sits in memory
  whole. `openDetached({ dir, name, label })` opens it (or starts an
  empty one). Its calls are refused and checked as the logged
  database's are, but record nothing: `flush()` has nothing to do, and
  `seq`, `base` and `schemaVersion` stay where the copy was taken.
  `copy({ dir, name, repo, branch })` makes a **logged copy** instead:
  it flushes first, and the copy's log is a new branch starting where
  this database's flushed transactions end, so its history is its
  source's and then its own, and the branch alone rebuilds it. That
  branch must be new, and in a repository holding the source's log.
  A copy replaces only a copy: the target file must be missing, empty,
  not a database, or a detached copy. Any logged database is refused,
  even one on the source's own branch, which may hold transactions no
  log has. The file's magic string is written last, so a copy cut short
  reads as no database, and a logged copy is marked detached until its
  branch exists, so either is replaced by the next try. A copy cut
  short in the moment between its last page and its mark, or between
  its branch and its mark, is refused like a database: delete the
  target to clear it. A detached copy can't be opened on a log, nor a
  logged database as a detached copy.
- **Checkpoints.** `checkpoint(label)` flushes, then names the log's
  position with a kvgit tag (`kvsql/checkpoint/<log>/<seq>-<random>`,
  its info the label, the time, the transaction and schema version);
  `checkpoints()` lists them oldest first, across every epoch, and
  `deleteCheckpoint(id)` deletes one. The database takes one itself
  before each schema change, labelled with its first statement, and
  keeps the last 10 of those (`autoCheckpoints`; 0 takes none): it
  flushes the transactions before the change as an entry of their own,
  so a commit holds that state. A tag keeps its commit and its history
  from being collected, so a checkpoint on an epoch since replaced keeps
  that epoch's snapshot and log, though not its branch, until it goes.
  Deleting a log deletes its checkpoints.
- **Restore.** `restore(id)` brings the database back to a checkpoint,
  everything written since gone, by moving the log forward, never by
  rewriting it. Within the current epoch, with no schema change since,
  it is one transaction applying the inverse of every change since
  (combined, then inverted), logged as any transaction is, so copies
  follow it as they follow any write, and a later checkpoint can be
  restored past it. Otherwise (a schema change since, which a
  changeset can't take back, or a checkpoint on an earlier epoch) the
  database is rebuilt at the checkpoint beside its file
  (`<name>-restore`, from that epoch's snapshot and log), becomes the
  snapshot of a new epoch, and the file is rebuilt from it, as opening
  does; that counts as a schema change. Calls wait while it runs. It
  needs a branch named for epochs; a crash at any point leaves the
  database as it was or restored.
- **Epochs.** A log on a branch named `<name>/<n>` is epoch `n` of a
  series. `newEpoch()` starts the next, `<name>/<n+1>`: a snapshot of
  the database as it stands (compacted with `VACUUM INTO`, every
  transaction so far in it, flushed or not) is gzipped and committed to
  the new branch, the file moves onto it in one transaction, and the
  old epoch's branch is deleted, so the log behind the snapshot goes
  without any branch being rewritten. Calls go on while the snapshot is
  committed; flushes wait, their transactions safe in the file, and go
  to the new epoch. The database also starts one by itself (`epochs`):
  when the epoch's log reaches half the snapshot's gzipped size, or one
  transaction does (an import, which then goes into the snapshot rather
  than becoming a huge log entry), and at least 8 MiB either way
  (`epochs.ratio`, `epochs.minBytes`; `epochs: false` turns it off). A
  failure there leaves the database on its epoch and calls
  `onEpochError`. A branch not named `<name>/<n>` has no epochs.
- **Opening** follows the log to its newest finished epoch, whichever
  of its branches it is asked for by, and deletes the older ones. A file
  that is missing, or behind on an older epoch with nothing pending, is
  rebuilt from the epoch's snapshot (`recovery.snapshot`); the file the
  snapshot was taken from, left on the old epoch by a crash, finishes
  its move (it is known by its position and its pending transactions'
  digest). One on an older epoch with changes the snapshot may not hold
  (entries past where it was taken, or pending transactions) stays on
  its own epoch while that epoch's branch is in the repository: another
  device's epoch replaced it, and `rebase()` moves it over
  (`recovery.stayed` names the newer epoch). One whose epoch's branch is
  gone holding transactions no log has is refused (`LogError`). `deleteLog(repo, branch)` deletes every epoch of
  a log.
- **The content hash.** `contentHash()` is a SHA-256 of the database's
  schema, header and every row in key order (each value `quote()`d, so
  `1`, `1.0` and `'1'` differ), kvsql's own tables aside: the same for
  any copy holding the same, however it came by it. Each snapshot
  records it (`hash` in its record). A copy that opens onto a new epoch
  from the very point its snapshot was taken, holding nothing past it,
  compares its own first, and one that holds something else (a change
  SQLite skipped, a file changed outside the log) stays on its epoch
  with `DivergedError` rather than moving over silently.
- **Opening** brings the file level with the branch: entries it didn't
  write are replayed (so an empty directory rebuilds the database from
  the log), and an entry matching its pending transactions is its own
  flush, interrupted before it could delete them. A file with pending
  transactions on a branch that has entries it didn't write rebases
  them onto those (`recovery.rebased`), as a flush onto a moved branch
  does; if they conflict, it refuses with `RebaseRequiredError` and
  changes nothing.
- **Rebase.** `rebase(onto?, { keep? })` brings the database onto
  `onto`, a commit of its log another copy wrote after the two parted
  (another device's, fetched by a sync that found the two diverged),
  or by default its branch's tip. Its own changes since then (pending
  transactions, and entries only this copy has) follow the log's: in
  one file transaction they are undone, the log's applied, and theirs
  applied again; they become entries numbered after the log's, on a
  branch beside the log's (`<log>/rebase`), and the log's branch moves
  there (a compare-and-swap). Only this copy had those entries, so
  nothing another copy holds is rewritten, and pushing afterwards is a
  fast-forward. Changes to other rows, or other columns of one row,
  follow cleanly (`rebased`). One column changed both ways, a row
  deleted against a change, one key inserted on both, a constraint the
  two break together, or a schema change on either side stops it with
  nothing changed (`conflict`, with `conflicts` or `schemaChange`).
  Rebasing again with `keep: 'theirs'` takes the log's side (the file
  is rebuilt from the log when this copy's own schema change can't be
  undone); `keep: 'mine'` keeps this copy's, after an entry that undoes
  the log's, or, over a schema change of the log's, which can't be
  undone, as a new epoch whose snapshot is this copy's file (after
  every epoch there is, and after every transaction of either side).
  Either way the side not kept stays as a checkpoint, on this device
  only (`kept`).
- **Rebase onto a new epoch.** With a newer epoch of its log in the
  repository (another device's), `rebase()` moves the database onto its
  tip. The newer epoch's snapshot folds in what changed before it, so
  there is no log to undo or apply: the database's changes since
  `synced` (the last commit of its own epoch the newer one holds, such
  as the one this copy last synced, or null if it synced none of it; by
  default, where the snapshot chain back from the newer epoch, through
  any epochs between the repository has, left this one, or the epoch's
  start for a database with nothing on it) are applied to a copy
  rebuilt at the tip beside the file (`<name>-rebase`), committed after
  the tip, and that copy replaces the file; the old epoch goes. With
  nothing of its own, the database just moves, comparing its content
  hash first if it is where the snapshot was taken. Conflicts and
  `keep` work as within an epoch; keeping `'mine'` starts an epoch after
  the newer one. A crash leaves it on its old epoch or rebased: opening
  finishes a built copy (it names the new epoch, at the rebase branch's
  tip), moving the epoch's branch only from where the rebase started.
- **Adopt.** `adopt(tip, { since?, keep? })` takes into the database
  entries another copy pushed to the epoch it moved on from, which its
  snapshot doesn't hold (pushed while it started the epoch): those on
  `tip`'s line after `since` (by default where that line parted from
  the one the snapshot of the epoch after `tip`'s was taken on, found
  by following the snapshot chain back), applied in one file transaction
  as entries after the database's own. A conflict changes nothing;
  `keep: 'mine'` takes nothing and keeps `tip` as a checkpoint. The last
  entry records `tip`, so adopting it again does nothing, and a later
  tip starts after it.
  A crash leaves the database as it was or rebased: opening finishes
  the branch's move if the file committed, from the head a tag
  (`kvsql/rebase/<log>`) recorded and only from there (a branch that
  moved on meanwhile is left as it is, and opening refuses), and
  otherwise drops the rebase's branch and tag.
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
byte length and SHA-256, and the schema version after it, and `total`,
the bytes of the epoch's entries through it; a reader refuses an entry
that doesn't match them (`CorruptEntryError`).

A new epoch's branch starts from the root commit with its snapshot:
the database file, gzipped, in 8 MiB chunks under `snapshot/<i>`, two
to a commit, so a sync can send one of any size as a run of small
requests. The last of those commits also holds the snapshot's record
under `epoch` (CBOR: the last transaction and schema version it holds,
the file's size, the gzipped size, each chunk's SHA-256, and where it
was taken from), and its info is `{v: 1, snapshot: {seq, schema, last:
true}}` (the ones before, `last: false`: a branch whose tip is one of
those never finished, and opening passes it over). Every later commit
is a log entry, numbered on from the snapshot's last transaction. A
rebuild checks each chunk's digest, gzip's own check and the size, and
refuses a snapshot that doesn't match (`CorruptSnapshotError`).

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
  `flush`, `export`, `close`), as promises, plus `copy(config)` (below),
  `info()` (the database's
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
  `kvsql/<id>/0`), `label`, `foreignKeys`, `flush`, `epochs`,
  `autoCheckpoints`, and `detached` (a detached copy, which has no
  branch). Opening follows the log to its newest epoch, so a config can
  keep naming the branch it started with; `info().branch` says where
  the log is now, and `db.newEpoch()` has the holder start the next.
  `checkpoint`, `checkpoints`, `deleteCheckpoint` and `restore` run on
  the holder too. Every tab passes the same config
  for the same database, and a worker refuses a second connect to an
  id with a different one.
- **Copies:** `db.copy(config)` has the worker holding the database
  copy it to the database `config` names, in storage from that worker's
  opener: a detached copy if `config.detached`, else a logged one on
  `config`'s branch. That worker holds the target's lock meanwhile and
  refuses a target open anywhere; connect to the target afterwards to
  use it. A copy whose holder went away isn't sent again (it may have
  been made). A logged copy's log starts from its source's, so both
  must be in one repository: the default worker gives each database
  its own, so there only detached copies work (and logged copies of a
  database that has flushed nothing yet). An app that makes logged
  copies keeps every log in one repository of its own (below).
- **The default worker** (`@agex-ts/kvsql/worker`) keeps each database
  with `openDefault`: the file in OPFS directory `kvsql/<id>` and the
  log on IndexedDB database `kvsql:<id>` (config `directory` and
  `indexedDB` change them; a detached copy has no log, so no IndexedDB
  database).
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
it opens it, and in the worker that copies a database to it. It
returns `{ dir, repo }` (a detached copy needs no `repo`), and may add `close()` (called
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
  written so running it twice is safe. `flush()`, `export()`, `info()`
  and `delete()` are safe to repeat, and are sent again to the next
  holder.
- **Delete through a client:** `db.delete()` runs on the holder, under
  the lock, after every call it received before: it closes the
  database, deletes the file, its journal and the log's branch (and,
  with the default worker, the directory and IndexedDB database),
  closes every tab's connection, and keeps the lock until the other
  workers have left its queue, so none of them opens it again (a
  connect made after the delete resolves waits for that, then starts
  the database afresh). Don't
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
  session extension doesn't record either: what a statement may do, as
  prepared, so a no-op counts too. `guard.analyzed` reports `ANALYZE`,
  whose statistics change no schema cookie. `guard.nondeterministic`
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
