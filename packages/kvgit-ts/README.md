# @agex-ts/kvgit

Versioned key-value store with branches, commits, and three-way merges. A TypeScript port of [agex-py's kvgit](https://github.com/ashenfad/kvgit), redesigned around async storage so it works equally well in Node and the browser.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A `Map<string, T>` with git-like history. Every `commit()` creates a checkpoint; branches are first-class; sessions can fork cheaply because the underlying HAMT shares structure across versions. Three-way merges are pluggable per key.

## Design

The canonical type contracts live in [`src/types.ts`](./src/types.ts). For how @agex-ts/kvgit is used inside agex-ts, see [agex-ts's State & Sessions concepts doc](../../docs/concepts/state-and-sessions.md).

## Repo and worktrees

The API follows Python kvgit 0.4's, made async:

```ts
import { Repo, jsonCodec } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'

const repo = await Repo.open(new Memory(), { codec: jsonCodec })
const wt = await repo.worktree('main', { create: true })
wt.set('greeting', { text: 'hello' }) // pending until commit
await wt.commit({ info: { title: 'first' } })

await repo.tags.create('v1', wt.head)
const snap = await repo.snapshot({ tag: 'v1' })
await snap.get('greeting') // { text: 'hello' }
for await (const c of repo.log({ branch: 'main' })) console.log(c.hash, c.info)
```

- **`Repo`** owns the store and the settings every worktree shares: the
  codec (`bytesCodec` by default, or `jsonCodec`), default merge
  functions, HEAD recovery and the clock. It reads commit records
  (`getCommit`, `log`, `diff`, `mergeBase`), makes snapshots, repairs
  HEADs and runs `gc`.
- **`Worktree`** is one branch checked out for work: writes stay
  pending until `commit()`, reads see them, and a commit that loses the
  race to another worktree on the same branch merges onto the new tip
  with the effective merge functions (the call's, then the
  worktree's, then the repository's).
- **`Snapshot`** is a read-only view pinned to one commit. It looks
  keys up in the tree a batch at a time, so reading a few keys stays
  cheap however many the commit holds; `raw` gives the stored bytes.
- **`repo.branches`** and **`repo.tags`** are live collections. A tag
  never moves, and keeps its commit and its ancestry alive through
  `gc`. Tags are stored as Python kvgit stores them (a branch head under
  `refs/tags/`, plus a record of when and why), so either reads the
  other's.
- **Merging.** `wt.merge({ branch | commit | tag })` fast-forwards when
  this branch hasn't moved since the two forked (as git does;
  `fastForward: false` writes a merge commit anyway), is a no-op for a
  commit the branch already contains, and otherwise writes a two-parent
  merge commit `[ours, theirs]`. `wt.apply(base, target)` lands the
  change from `base` to `target` as one ordinary commit, with
  `cherryPick(commit)` and `revert(commit)` built on it.
- **Merge rules** come from the repository, the worktree and the call,
  in that order, each by key (`mergeFns`), by key prefix
  (`mergePrefixes`, longest match wins) or as a default. A rule is a
  merge function over decoded values, consulted only where both sides
  changed a key (it may answer with a `MergeChoice` to keep one side),
  or a `MergeChoice` itself: a standing policy giving one side every
  key it covers that either side changed. `postCheck` can refuse a
  merged value as a conflict.
- The common ancestor is found by generation: commits record their
  parents' generations, so the search for two tips that forked
  recently reads a few records whatever the history below.
- Errors derive from `KvgitError`: `UnknownBranchError`,
  `UnknownTagError`, `UnknownCommitError`, `BranchExistsError`,
  `TagExistsError`, `CorruptHeadError`, `StorageVersionError`,
  `MergeConflict` and `ConcurrencyError`.

`Worktree` and `Repo` sit on `VersionedKV`, which stays available (as
does `Staged`) for the code that still uses it.

## Storage format

Stores use kvgit storage v4, the format Python kvgit 0.4 writes, byte
for byte: a store either one writes, the other reads, and a commit
either one makes gets the same hash in both. Blobs are keyed by the
SHA-256 of their bytes (`kvgit:blob:<sha256>`), HAMT nodes by their
entries, and a commit hash covers its parents, keyset root, time and
info. Records are JSON as Python's `json.dumps` writes it, which
[`src/pyjson.ts`](./src/pyjson.ts) reproduces.

Two consequences for callers:

- **Commit info is hashed as Python would write it.** JS has one
  number type, so a whole number in `info` is written as an integer.
  Wrap a value that must be a float in `PyFloat` (`new PyFloat(2)`
  writes `2.0`).
- **Commit times are seconds**, as a float. `VersionedKV.open` takes a
  `now` option (seconds) for a deterministic clock; it defaults to the
  wall clock.

The golden test ([`tests/golden-v4.test.ts`](./tests/golden-v4.test.ts))
replays a scripted history and compares every key and byte against
what Python kvgit wrote for it
([`scripts/golden-v4.py`](./scripts/golden-v4.py)).

## Garbage collection

Resetting a branch, deleting one, or losing a race leaves commits
nothing points at. `repo.gc({ minAge, deep })` (or `vk.cleanOrphans` /
`vk.deepClean` on an engine handle) reclaims them, with everything only
they held: records, blobs and HAMT nodes.

**It is safe beside concurrent writers,** as in Python kvgit:

- A sweep runs under the store's GC lease (`__gc_lease__`, a record
  with an owner and an expiry). Every write that adds something a sweep
  must see (a commit's batch, a head, a tag, a synced commit) is
  conditional on the lease record its writer read after waiting any
  live sweep out, so it lands before a sweep starts or after it ends,
  never during. A writer that starts mid-sweep waits, and then lands
  intact, even holding content an orphan held.
- A commit's batch carries an in-flight marker (`__inflight__<commit>`)
  that the write publishing its head removes, so a sweep that starts
  between the two keeps it. A marker lapses after ten minutes, which is
  what eventually releases the commit of a writer that died before
  publishing.
- `minAge` (seconds for `repo.gc`, default an hour) is policy only: how
  long abandoned work lingers. Any value is safe, 0 included.
- Lease and marker expiries are always wall-clock time: they coordinate
  writers in different handles and processes. A `now` option pins only
  commit and tag times and the `minAge` cutoff.
- The lease expires (`leaseTtl`, default ten minutes), so a sweep that
  dies holding it delays writers by the rest of its term and no longer.
  A second sweep waits for the first, or with `wait: false` throws
  `GcBusy` (`deepClean` doesn't wait).

`deep` also scans the `kvgit:keyset:` and `kvgit:blob:` namespaces for
content no commit references at all: leftovers from an interrupted
write, or the blobs of an orphan whose keyset is unreadable, which no
orphan keyset points at.

## HEAD recovery

A branch HEAD lives in one key, `__branch_head__<branch>`, and a backup
of the value it held before its current one lives in
`__branch_head_prev__<branch>`. If HEAD is unreadable — truncated
bytes, a hash whose commit metadata is gone — head resolution falls
back in tiers: the backup first, then the optional
`recoverFromCorruptHead` callback you can pass to `VersionedKV.open`,
then nothing. That third tier is caller-supplied here (kvgit-py's
built-in commit scan is not ported), so out of the box a branch
recovers only as far back as its backup.

A recoverer is not a trusted tier. Its answer is accepted only if it
is a string naming a commit whose `__commit_root__` is present in this
store; anything else is logged with what was returned, and the branch
is reported unrecoverable. Head resolution promises a valid commit or
`null`, and an unchecked answer is worse than no answer — `repairHead`
would make it durable, replacing obviously corrupt HEAD bytes with a
plausible hash that names nothing, on a store whose backup is already
gone.

Two rules govern this.

**Reads never write.** Resolving a damaged branch on a read path —
opening a handle, `peek`, `switchBranch`, `refresh`, the mark phase of
a sweep — recovers in memory and leaves the store exactly as it found
it. The mark phase is the one place that stops at the backup tier even
when the handle carries a recoverer: GC must not decide reachability
from a guess, so a branch whose HEAD does not resolve marks nothing
and keeps its commits as young orphans until `minAge` and an explicit
`repairHead` settle what it points at. A read-only consumer can therefore read a damaged store, two
concurrent readers cannot race each other repairing the same branch to
different answers, and the damage stays visible instead of being
quietly papered over. The cost is that the fallback runs on every read
until someone repairs it.

Two things persist a recovery:

- `repairHead(store, branch)` — or `vk.repairHead()` — the explicit
  maintenance call, and the one to reach for. It returns the commit
  HEAD names when it returns, which is not necessarily the one it
  recovered: if another writer repaired, advanced or deleted the
  branch in between, the answer describes the store rather than the
  attempt. `null` means the branch does not exist or nothing was
  recoverable.
- A successful write. A CAS against a damaged HEAD always fails, which
  would leave the branch permanently unwritable, so a writer that
  finds HEAD unresolvable replaces it with the recovered commit and
  retries once. The replacement is itself a CAS against the exact
  damaged bytes, so two writers racing it cannot both win; a HEAD that
  merely *moved* — an ordinary lost race — is never touched, and a
  HEAD that is *absent* is never recreated, since that is the
  deleted-branch resurrection `deleteBranch` drops the backup to
  prevent.

**The backup is exactly the HEAD the swap replaced.** A HEAD swap
writes `__branch_head__` and `__branch_head_prev__` in one atomic
`casMany` (a compare-and-swap across keys, which every backend
provides), conditional on HEAD still holding the value the writer
read. A writer that loses the race writes neither, so the backup never
names a commit HEAD did not hold, and no crash, concurrent writer or
delete can land between the swap and the backup.

## Sync & remotes

kvgit histories can be replicated between stores (cross-device session
sync, bundles). The durable design decisions, in case you're extending
this layer:

- **Sync is replication, not storage.** A remote is *not* a `KVStore`
  backend — `KVStore` is the near-storage boundary (HAMT walks assume
  cheap reads), while a remote is a far peer that exchanges history.
  Don't implement a remote by putting a slow store behind `KVStore`;
  implement the wire layer.
- **The unit of transfer is the commit, in wire form** (`WireCommit`
  in [`src/types.ts`](./src/types.ts)): parents and their
  generations, time, info, changed value bytes, removals. Produced by `walkDelta(store, { want, have })`
  ([`src/sync/walk.ts`](./src/sync/walk.ts)) — commits reachable from
  `want` but not `have`, parents-first. `have = ∅` is a full export
  (bundles are the degenerate case). Replayed by
  `applyWire(store, commits)` ([`src/sync/apply.ts`](./src/sync/apply.ts)),
  which recomputes every commit hash from the replayed state and
  refuses mismatches before writing.
- **HAMT nodes never cross the wire.** A receiver rebuilds each
  commit's keyset over its first parent's, keying each changed value's
  blob by its bytes, so the rebuilt root is the sender's; it then
  recomputes the commit hash from that root, the time and the info
  (see `commitHash` in
  [`src/versioned/layout.ts`](./src/versioned/layout.ts)) and refuses
  a mismatch. A merge commit's delta lists every key that differs from
  its first parent, the ones it took from the other side included, so
  replay never consults a second parent. The one commit not checked
  this way is the root commit, whose hash is fixed: it is checked by
  its shape (no parents, no info, an empty keyset). See the fidelity
  tests in [`tests/sync-walk.test.ts`](./tests/sync-walk.test.ts) and
  the refusal tests in
  [`tests/sync-apply.test.ts`](./tests/sync-apply.test.ts).
- **Merge never crosses the wire either.** Remotes move objects and
  CAS refs; reconciliation always happens locally via the existing
  three-way machinery (`commit()` / merge fns). Remotes can therefore
  be *passive* — any object store with compare-and-swap on refs
  qualifies; no kvgit code needs to run on the far side. The protocol
  is `Remote` (`listRefs` / `fetch` / `push`) in
  [`src/sync/remote.ts`](./src/sync/remote.ts), with `MemoryRemote`
  as the reference implementation.
- **Sync is fast-forward only.** `pullBranch` / `pushBranch` /
  `syncBranch` ([`src/sync/sync.ts`](./src/sync/sync.ts)) move refs
  only along their own ancestry and report `'diverged'` otherwise —
  objects may transfer on divergence (useful for a later merge), but
  no ref moves and nothing merges automatically. A vanished
  previously-synced remote ref reports `'remote-gone'` (lifecycle
  conflict) for the caller to resolve.
- **Parent order is significant.** A commit that merges after losing
  its race has `parents[0]` "theirs" (the head that won) and
  `parents[1]` "ours"; a branch merge has `[ours, theirs]`, so linear
  history stays on the merging branch. Wire deltas diff against
  `parents[0]`.
- `__sync_head__<branch>` holds remote-tracking state (which remote
  commit a branch was last synced to) via `getSyncHead` /
  `setSyncHead` / `clearSyncHead` in
  [`src/sync/apply.ts`](./src/sync/apply.ts).

The storage layout and commit-identity primitives live in
[`src/versioned/layout.ts`](./src/versioned/layout.ts) — the single
source of truth shared by `VersionedKV` and the sync layer. If you
change the layout or hash inputs, both move together and the storage
version sentinel must bump.

### GitHub transport (`@agex-ts/kvgit/github`)

The first real transport syncs through a plain GitHub repo — no
backend, no git protocol (GitHub's smart-HTTP endpoints don't send
CORS headers), just the CORS-friendly Git Data REST API with a
user-supplied PAT. Designed for a fine-grained token scoped to one
dedicated sync repo with Contents read/write — least privilege for a
token that lives in browser storage. A repo, not a gist: gists lack
the Git Data API and CAS-able refs.

What's in the subpath ([`src/github/`](./src/github)):

- **`GithubClient`** — throttled, retrying REST client scoped to one
  repo. Mutations are serialized with minimum spacing
  (`writeIntervalMs`, default 750ms ≈ GitHub's ~80 content-writes/min
  secondary limit); reads run free against the 5,000/hr primary
  limit. `server`/`rate-limit`/network failures retry with backoff
  honoring `Retry-After`; `auth`/`permission`/`validation` never
  retry (see the `GithubError` taxonomy in
  [`src/github/errors.ts`](./src/github/errors.ts)). Git Data
  primitives: binary-safe blobs, trees with `base_tree` + nested
  paths, commits with explicit dates (deterministic SHAs → resumable
  pushes), refs with CAS semantics (`createRef`/`updateRef` return
  `false` on lost races only).
- **`GithubRemote`** — the `Remote` implementation. Push renders each
  kvgit commit as a real git commit (blobs → `base_tree` trees →
  commits with deterministic dates → one trailing ref CAS); fetch
  walks the commits list back to the receiver's frontier, reads
  sidecars + blobs via the contents API, and reassembles
  `WireCommit`s. Incremental pushes need per-branch **transport
  state** (frontier tree + key→path assignments), persisted locally
  under `__ghsync__<repo>__<branch>`; fetch rebuilds it
  opportunistically as it walks, and `rebuildTransportState(branch)`
  recovers it from remote sidecars alone. Verified live end to end:
  two stores ping-ponging a session through a real repo, incremental
  deltas both directions, interrupted-push resume, lost-state
  recovery.
- **Each value crosses once.** Values are keyed by content, so a
  sidecar records each changed value's hash. A push references a value
  the repo already holds (one this store pushed or fetched on any
  branch: a rename, a copy, a revert, what a merge took from another
  branch) by its git SHA instead of sending it again, and sends the
  bytes after all if the repo has since collected that blob. A fetch
  reads a value the local store already holds instead of downloading
  it, and downloads a value several fetched commits share once.
- **Roster ops** — the session-lifecycle layer over the ref
  namespace: `archiveBranch` / `restoreBranch` (ref renames between
  `refs/heads/*` and `archived/*`), `deleteForever` / `emptyTrash`
  (tombstone pruning; GitHub GC reclaims objects), `listArchivedRefs`
  (the trash view), and `readKeyAtTip` (one key's bytes at a tip
  without materializing — the cloud-stub primitive; probes the
  natural path then the relocation slot). Concurrent archives
  collapse benignly; restore suffixes on a retaken name.
- **`gitBlobSha1`** — local git blob hashing (WebCrypto SHA-1);
  knowing a blob's SHA before upload is the push-side dedup
  primitive. Verified live: the local SHA predicts the remote one.
- **Live verification suite**
  ([`tests/github-live.test.ts`](./tests/github-live.test.ts)) —
  env-gated (`KVGIT_GH_TOKEN` + `KVGIT_GH_REPO`, scratch repo);
  pins the API behaviors the design rests on: nested-path tree
  synthesis, exact dates, multi-parent commits, topological-order
  rejection, empty-tree commits, `force:false` CAS, commits-list
  pagination, and `archived/*` rename tombstone mechanics.
