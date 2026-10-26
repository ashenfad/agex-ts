# @agex-ts/kvsql

## 0.2.0

### Minor Changes

- 1b8a9d3: **`transact(fn)` and procedures:** a function runs as one transaction through `tx.query`, so a write can depend on what it read, and `serve(open, { procedures })` lets clients `call(name, args)` such functions by name.

### Patch Changes

- Updated dependencies [8a29999]
- Updated dependencies [ee3020b]
- Updated dependencies [e3b247f]
- Updated dependencies [83c2b5b]
  - @agex-ts/kvgit@0.2.1

## 0.1.0

### Minor Changes

- d35357c: **Changesets and the schema guard.** Record a connection's changes with the session extension, then invert, combine, list and apply them under a conflict policy, behind an authorizer and a primary-key check that refuse what the record would silently miss.
- d4a9c94: **Checkpoints and restore:** `checkpoint(label)` names the log's position with a kvgit tag, the database takes one itself before each schema change (keeping the last 10), and `restore(id)` brings the database back to one by moving the log forward: one transaction undoing the changes since, or, across a schema change or epochs, a new epoch from the database rebuilt at the checkpoint. Database names ending in `-restore` are now refused.
- 0ea4411: **Content hash.** `contentHash()` hashes a database's schema and rows, the same for any copy holding the same. Each snapshot records it, and a copy moving to a new epoch from the point its snapshot was taken compares its own first, refusing with `DivergedError` if they differ.
- 48649e3: **Rebase across epochs.** `rebase(undefined, { synced })` moves a database with changes of its own onto a newer epoch another device started: its changes since `synced` apply to a copy rebuilt at the epoch's tip, which replaces the file. Keeping `'mine'` starts a newer epoch from the database's own file, which also lets a rebase keep this copy's side over a schema change in the log. Opening no longer rebuilds over a file with changes the newer epoch may not hold: it stays on its own epoch (`recovery.stayed`). `adopt(tip)` takes in entries another device pushed to the old epoch while this one started the new one.
- 6e50a53: **Epochs:** a log on a branch named `<name>/<n>` starts its next epoch from a gzipped snapshot of the database (`newEpoch()`, or by itself once the log or one transaction is large next to the snapshot), deletes the old one, and opens on its newest epoch, rebuilding a missing or stale file from the snapshot. The default branch is `kvsql/<id>/0`.
- fe070fd: **SQLite on a file:** `openDatabase(dir, name)` opens a crash-safe database (PERSIST rollback journal) on an OPFS directory (`OpfsDirectory`, in a dedicated worker) or in memory (`MemoryDirectory`) through the package's own VFS, and `CrashingDirectory` crashes any directory at a chosen write, truncate or sync for crash tests.
- a572740: **The changeset log:** `openLog({ dir, name, repo, branch })` records each `query` or `transaction([...])` in the database file, flushes them in batches as entries on a kvgit branch, and replays the log on open, so an empty directory rebuilds the database.
- 2111ce3: **Rebase.** `rebase(onto?, { keep? })` (on the database and its client) moves this copy's own changes, pending and unsynced, after entries another copy wrote, renumbered after them, in one file transaction. A conflict or a schema change on either side changes nothing; `keep: 'mine' | 'theirs'` settles it, the other side kept as a checkpoint. Opening and flushing rebase pending transactions onto a moved branch by themselves, and `RebaseRequiredError` now means they conflict (with `conflicts` and `schemaChange`).
- da71c9f: **A new package for SQLite with a kvgit changeset log.** It loads the pinned official SQLite build (`loadSqlite`) and checks it carries the session extension, in Node and in Chromium, Firefox and WebKit.
- c281d59: **The worker host:** `serve` (or the default worker, `@agex-ts/kvsql/worker`) runs databases in a dedicated worker and `connect` (`@agex-ts/kvsql/client`) calls them from the page, with one writer across tabs by Web Lock, takeover when it goes away, and `ConnectionLostError` for a request lost with it.

### Patch Changes

- bd9900f: **Epochs between syncs.** `rebase` and `adopt` follow the snapshots back through any epochs between, so a copy several epochs behind moves on (its epochs before gone or not), and pushes to an epoch two back are taken in; `synced: null` says the copy synced none of its epoch, so all of it is its own. A copy moving onto an epoch taken at its own position checks the content hash again.
- d4c729e: **The guard refuses setting `recursive_triggers` and `case_sensitive_like`,** which change what statements do on one connection only.
- bd9900f: **Older epochs that synced are kept** (and every epoch after them) until the sync deletes them, so what another device pushed to one can still be taken in after a sweep of the store; others still go at once. `onEpochsDeleted` (and a worker storage's `epochsDeleted`) hears of the epochs deleted, for scheduling that sweep.
- bd9900f: **Free pages given back.** A new database file is in incremental auto-vacuum mode, and `reclaimPages` shrinks it once its free pages are 1 MiB and a quarter of it; a logged database does so after each flush and new epoch (which drop a transaction's pending copy) and at open. Files in another mode keep it.
- Updated dependencies [cbaa8ea]
- Updated dependencies [6115187]
- Updated dependencies [3c938b2]
- Updated dependencies [f72a259]
- Updated dependencies [f154ccc]
- Updated dependencies [7de1515]
- Updated dependencies [36a2042]
- Updated dependencies [7ab2502]
- Updated dependencies [1494f5c]
- Updated dependencies [f65aaec]
- Updated dependencies [d7a3f69]
- Updated dependencies [62727b0]
- Updated dependencies [1cfdbf5]
- Updated dependencies [3f0b814]
- Updated dependencies [b382ec7]
- Updated dependencies [a574362]
- Updated dependencies [231a95e]
- Updated dependencies [bd9900f]
- Updated dependencies [9b4cfef]
- Updated dependencies [326eedf]
  - @agex-ts/kvgit@0.2.0
