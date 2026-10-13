# @agex-ts/world

A versioned world for agents: every session a branch of one
[kvgit](../kvgit-ts) repository, holding its files, its cache and its
working directory, with the history of all three. The TypeScript
counterpart of [nontainer](https://github.com/ashenfad/nontainer)'s
store and workspace, with the same semantics and its own storage
layout.

> **Status:** Pre-alpha, on the agex-ts `rebuild` branch. The tools
> and the turn come next.

## Use

```ts
import { Store } from '@agex-ts/world'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'

const store = await Store.open(await IndexedDB.open({ dbName: 'world' }))
const ws = await store.open('alice') // created if new, at /workspace

await ws.files.write('notes/todo.md', '- write the tests\n') // one commit
await ws.tags.add('v1')

const draft = await ws.fork('alice-draft') // O(1): a new branch
await draft.files.write('notes/todo.md', '- done\n')

await ws.checkout('v1') // a new commit restoring v1; history is kept
```

## Concepts

- **A store** is one kvgit repository on any `KVStore` (memory,
  IndexedDB, SQLite). Each session is a branch named by its id, and
  exists exactly when its branch does. `store.sessions()`, `exists`,
  `delete` (with its tags, then garbage collection), `clean`, `fork`,
  and `resolve('session@ref')` for a frozen view.
- **A workspace** is one session, opened with `store.open(id)`. A new
  session starts with its root directory (`/workspace` by default) and
  its working directory there, committed as `{tool: 'init'}`.
- **Files:** `ws.files.read`, `readText`, `exists` and `list` read;
  `write` (creating directories) and `remove` each commit
  (`file_write`, `file_remove`). `ws.files.fs` is the whole
  filesystem, termish's `FileSystem`, for a shell or a kernel: its
  writes stay pending until something commits, and its `chdir` is
  stored with the session.
- **The cache:** `ws.cache` holds named values (anything CBOR holds:
  JSON data, bytes, typed arrays, `Map`, `Set`, `Date`, bigints),
  versioned with the files and left out of file diffs.
- **Commits:** with `autocommit` on (the default) every call that
  changes the session commits. Otherwise `ws.commit(info)` does.
  `ws.log()`, `ws.diff(a, b)`, `ws.discard()`, `ws.refresh()`.
- **Checkout** restores the whole session (files, cache, working
  directory) as a new commit `{tool: 'checkout', target}`; the commits
  after the target stay in the log. With `paths`, it takes just those
  files from the target.
- **Fork** makes a child session from the current commit, or from
  `at`. `inherit: 'fresh'` leaves out the conversation and compaction's
  record.
- **Tags** never move: `ws.tags` names a session's commits, and
  `store.tags` the store's, outliving the sessions they name.
  `tags.at(name)` opens a frozen view.
- **One call at a time:** a workspace runs the calls that change it in
  order, so one call's writes and its commit never interleave with
  another's. `ws.exclusive(fn)` runs a host's own multi-step call the
  same way. Several workspaces on one session (two tabs) each commit;
  the one that loses a race merges onto the other's commit, and throws
  `CommitConflictError` only when the two changed the same thing in
  ways no merge rule settles.

## The kernel

`ws.runCode(code)` runs TypeScript in a worker (a browser Web Worker,
or Node `worker_threads`) as one call, committed as `{tool: 'run_ts'}`
when it changed anything:

```ts
const result = await ws.runCode(`
  import { summarize } from './lib/stats.ts'
  const rows = JSON.parse(await fs.read('data.json', 'utf8'))
  await fs.write('summary.json', JSON.stringify(summarize(rows)))
  return rows.length
`)
// result: { stdout, stderr, images, value: '120', error: null, commit, … }
```

- **Code** is the body of an async function: top-level `await`, and a
  top-level `return` shows its value. Types are stripped by
  ts-blank-space (or the profile's `transform`).
- **Its bindings:** `fs` (the session's files, every method async, with
  `read(path, 'utf8')` and string writes), `cache`, `env` (the
  profile's variables), `console` (`log`/`info` to stdout, `warn`/
  `error` to stderr, images shown as images), and the host objects.
- **Nothing carries over between runs** but the files and the cache,
  as in nontainer: each run gets a fresh scope.
- **Imports:** the world's own modules by path (relative to the working
  directory, or absolute), `'host'`, URLs, and bare names the profile's
  `resolve` maps to URLs (``(name) => `https://esm.sh/${name}` ``).
- **Stopping:** a run longer than the profile's timeout (30 seconds by
  default) is stopped with a `TimeoutError`, and `ws.interrupt()` stops
  one with a `CancelledError`. Either way the worker is terminated, what
  the code wrote is committed, and the next run starts a fresh worker.

## The profile

What the host grants a session, given to `store.open(id, {profile})`,
kept in memory only, and inherited by forks:

```ts
const ws = await store.open('alice', {
  profile: {
    hostObjects: {
      db: myDatabase, // its public methods, callable from code
      sessions: hostFactory((ws) => new Delegation(ws)), // made per world
    },
    variables: { SUPABASE_URL: 'https://…' }, // env in code
    secrets: { GITHUB_TOKEN: '…' }, // never in the world: host commands only
    code: { timeout: 60, resolve: (name) => `https://esm.sh/${name}` },
  },
})
```

- **Host objects** are called over async messages: code writes
  `await db.query(…)`. Methods whose names start with `_` aren't
  reachable, and arguments and results cross by structured clone.
- **`hostFactory(make)`** makes an object per world (`make(ws)` as each
  workspace opens, forks included), so it knows which session it serves.
- **`withCall(fn)`** declares a method that receives a `HostCall` first:
  its `ws` is the calling workspace as part of the code's call, so the
  method can fork or commit without waiting behind the call that's
  waiting for it.

## Layout

| key | value |
|---|---|
| `__file__<abs path>` | a file's bytes |
| `__meta__<abs path>` | `{size, createdAt, modifiedAt, isDir}` |
| `__cwd__` | the working directory |
| `__cache__/<key>` | a cache entry |
| `__conversation__/…`, `__compaction__/…` | the turn's records |

Content and metadata are separate keys, so unchanged content keeps its
stored blob.

## License

MIT
