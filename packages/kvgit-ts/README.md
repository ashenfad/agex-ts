# @agex-ts/kvgit

Versioned key-value store with branches, commits, and three-way merges. A TypeScript port of [agex-py's kvgit](https://github.com/ashenfad/kvgit), redesigned around async storage so it works equally well in Node and the browser.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A `Map<string, T>` with git-like history. Every `commit()` creates a checkpoint; branches are first-class; sessions can fork cheaply because the underlying HAMT shares structure across versions. Three-way merges are pluggable per key.

## Design

The canonical type contracts live in [`src/types.ts`](./src/types.ts). For how @agex-ts/kvgit is used inside agex-ts, see [agex-ts's State & Sessions concepts doc](../../docs/concepts/state-and-sessions.md).

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
  in [`src/types.ts`](./src/types.ts)): parents, changed value bytes,
  removals, carries, info. Produced by `walkDelta(store, { want, have })`
  ([`src/sync/walk.ts`](./src/sync/walk.ts)) — commits reachable from
  `want` but not `have`, parents-first. `have = ∅` is a full export
  (bundles are the degenerate case). Replayed by
  `applyWire(store, commits)` ([`src/sync/apply.ts`](./src/sync/apply.ts)),
  which recomputes every commit hash from the replayed state and
  refuses mismatches before writing.
- **HAMT nodes never cross the wire.** Commit hashes cover parents,
  the keyset pointer map, update bytes, and info — *not* HAMT node
  bytes (see `contentHash` in
  [`src/versioned/layout.ts`](./src/versioned/layout.ts)). Receivers
  rebuild the HAMT locally; root hashes are local pointers and must
  never be compared across stores.
- **Carries are the subtle part.** Merge commits adopt keys from the
  non-first parent *by pointer* (`<owning-commit>:<key>`), without
  rewriting bytes — and the pointer map participates in the commit
  hash. `WireCommit.carries` transports that provenance (plus the
  carried entry's `size`/`createdAt`, so replay never consults a
  parent keyset); a replayer that derived pointers from the first
  parent instead would change the hash. Replay must reproduce hashes
  exactly: recomputing `contentHash` over replayed state and comparing
  is the sync layer's integrity check (see the fidelity tests in
  [`tests/sync-walk.test.ts`](./tests/sync-walk.test.ts) and the
  refusal tests in
  [`tests/sync-apply.test.ts`](./tests/sync-apply.test.ts)).
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
- **Parent order is significant.** For three-way merges,
  `parents[0]` is "theirs" (the head that won the CAS race) and
  `parents[1]` is "ours" (`VersionedBase.threeWayMerge`). Wire deltas
  diff against `parents[0]`.
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
