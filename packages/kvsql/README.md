# @agex-ts/kvsql

SQLite in the browser on an OPFS file, with every change recorded in a
[kvgit](../kvgit-ts) log: checkpoints and restores, cheap test copies,
and sync between devices through any kvgit remote.

> **Status:** in development. This package so far loads the SQLite build
> the rest is built on. The design is agex-studio's
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

## Tests

`pnpm test` runs the Node tests. `pnpm test:browser` runs the browser
tests in Chromium; CI also runs them in Firefox and WebKit
(`pnpm test:browser --browser.name=firefox`). Install the browsers once
with `pnpm exec playwright install chromium firefox webkit`.
