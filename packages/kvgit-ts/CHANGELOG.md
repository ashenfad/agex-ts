# @agex-ts/kvgit

## 0.1.3

### Patch Changes

- d660ff6: Validate what an injected `recoverFromCorruptHead` returns, and thread the recoverer through `peek`.

  The last-resort recovery tier is caller-supplied, so its answer is no more trustworthy than anything else read out of a damaged store — but it was returned unchecked, while the current-HEAD and prev-HEAD tiers both verify that what they read is a string naming a commit whose `__commit_root__` is present. A recoverer that guessed wrong therefore handed back a hash naming nothing, and `repairHead` then made it durable: obviously corrupt HEAD bytes replaced with a plausible hash pointing at no commit, which is harder to diagnose than the damage it replaced, on a store whose prev-HEAD backup is already gone by the time this tier runs. The same check now applies to the third tier, and a rejected candidate is logged with what was actually returned instead of being dropped silently. A recoverer naming a real commit is honoured exactly as before.

  `peek` resolved the target branch without the handle's recoverer, so a branch that every other read path on the same handle could recover read back as absent through `peek`. It now passes it like the rest.

  The orphan sweep still resolves branch HEADs without the recoverer, and that is deliberate rather than an omission: GC must not decide reachability from a guess, since a wrong answer marks the wrong commits live and walks a guessed tip as though it were the branch's own history. That is now stated at the call site and pinned by a test.

  No API change: `CorruptHeadRecoverer` keeps its signature. A recoverer that was returning valid commit hashes is unaffected; one that was returning junk now leaves the branch reported unrecoverable rather than papering over it.

- c271f52: Fix two defects in branch-HEAD recovery, and add `repairHead` as the explicit repair path.

  `__branch_head_prev__<branch>` — the backup a damaged branch recovers _to_ — was written before the CAS that moves HEAD, so it landed whether or not the swap did. A writer that lost the race left its own stale `expected` as the branch's recovery target: it clobbered the winner's backup, and where `expected` came from a corrupt-HEAD recovery rather than a real HEAD, it made a commit that was never HEAD durable, so later reads would recover the branch onto a lineage it never had. The backup is now written after the swap succeeds. It still does **not** guarantee a backup exactly one commit back — the swap and the backup write are two steps, and a crash or a lost timeslice between them lets an older writer's backup land last — but it always names a commit HEAD really held. Recovery may lose more than one commit; it cannot invent a lineage. `pullBranch`'s fast-forward had the same ordering and gets the same fix.

  Head resolution no longer writes. It repaired a damaged HEAD in place on every read path — opening a handle, `peek`, `switchBranch`, `refresh`, the mark phase of a sweep — which a read-only consumer cannot do at all, and which let two readers race each other repairing the same branch to different answers. The `repair` option is gone from the internal resolver; recovery is returned to the caller and forgotten.

  Two things persist a recovery instead. The new `repairHead(store, branch)` (and `vk.repairHead()`) is the explicit maintenance call: it resolves as a read would, then writes the answer back with a CAS against the damaged bytes, and returns the commit HEAD names when it returns — re-resolving if that CAS lost, so the answer describes the store rather than the attempt. And the write path heals itself: a CAS against corrupt HEAD bytes always fails, so without repair-on-read a damaged branch would be permanently unwritable. A writer that finds HEAD unresolvable now swaps in the recovered commit — again by CAS against the exact damaged bytes — and retries once. A HEAD that merely moved is left alone, and an absent HEAD is never recreated, since that is the deleted-branch resurrection `deleteBranch` drops the backup to prevent.

  No API breakage: `repair` was never part of the public surface, and `repairHead` is new.

  The prev-HEAD tier is also gated on `__branch_head__` existing. An absent HEAD is not damage — `deleteBranch` removes the key — so a backup that outlives its branch must not bring the branch back. Moving the backup write after the CAS opened a route to exactly that, when a writer descheduled between the two resumes after a concurrent delete and recreates only the backup. `pullBranch`'s fast-forward shares the fix.

- d83f06c: Fix a data-corruption race in `VersionedKV.cleanOrphans`, and add `deepClean` for the reclamation it can no longer do safely.

  The sweep used to find orphaned HAMT nodes by scanning the whole `kvgit:keyset:` namespace for anything the mark phase hadn't reached. Because `store.keys()` is an async iterable, that scan interleaves with the event loop, so a commit landing between the `__commit_root__` scan and the node scan kept its commit metadata but lost its nodes — leaving a live branch HEAD whose keyset root was missing, and whose keys then read back as absent. No second thread or process was needed; a single JS context could hit it, and tabs sharing an IndexedDB or processes sharing a SQLite file widen the window. The same design leaked blobs permanently: once a namespace scan had deleted an orphan's nodes, no later pass could walk that orphan's keyset to find its blobs.

  `cleanOrphans` now collects every deletion candidate by walking an orphaned commit's own keyset, and takes its nodes and blobs in the same walk. Blob keys are `<commitHash>:<userKey>` and HAMT leaves carry that pointer, so node hashes are commit-scoped and never dedup across unrelated commits — which means a commit that lands mid-sweep is in no orphan's tree and cannot become a candidate. The race is closed by construction: no lock, no timestamps, no storage-layout change.

  What the incremental path can no longer reclaim is HAMT nodes that _no_ commit points at — an interrupted write, a crash between a node write and its CAS, damage from an older sweep — since there is no orphan keyset to find them through. The new `VersionedKV.deepClean()` does that with the old full-namespace scan. It is a separate method rather than a flag because it **requires a quiescent store**: its scan runs after the mark phase and will delete artifacts written by a concurrent writer, including ones a live HEAD has since come to depend on. Use `cleanOrphans` for routine cleanup and schedule `deepClean` for maintenance windows.

  No API breakage: `cleanOrphans` keeps its signature, its return value, and its `minAge` semantics.

## 0.1.2

### Patch Changes

- d109967: Speed up initial branch checkout over the GitHub remote. `GithubRemote.fetch` now walks the remote in `GET_CHUNK`-sized windows, fetching each window's sidecars and update blobs concurrently (bounded to `GET_CHUNK` in-flight requests) before yielding its commits in order — instead of one serial round-trip per commit gated behind the consumer's apply. A from-scratch pull of N commits costs roughly `N/GET_CHUNK` request waves rather than N back-to-back round-trips, while peak memory stays at a single window of blobs. Behavior is otherwise unchanged: full history is preserved, hashes are still verified on apply, and transport state still folds across the window seam.

## 0.1.1

### Patch Changes

- 5c222cc: Added the sync layer: kvgit histories can now replicate between stores and sync across devices through a GitHub repo.

  - **Wire form & replication**: `WireCommit` (the commit-shaped unit of transfer), `walkDelta(store, { want, have })` to stream a history delta, and `applyWire(store, commits)` to replay it — with every commit hash recomputed from replayed state and refused on mismatch.
  - **Remote protocol**: the transport-agnostic `Remote` interface (`listRefs` / `fetch` / `push`-with-CAS), `MemoryRemote` reference implementation, and fast-forward-only orchestration via `pullBranch` / `pushBranch` / `syncBranch` (divergence is detected and surfaced, never auto-merged). Remote-tracking heads via `getSyncHead` / `setSyncHead` / `clearSyncHead`.
  - **GitHub transport** (new `@agex-ts/kvgit/github` subpath): `GithubClient` (throttled, retrying Git Data API client with an error taxonomy), `GithubRemote` (each kvgit commit pushed as a real git commit — browsable sessions, incremental deltas, resumable interrupted pushes, transport-state rebuild from remote sidecars), roster lifecycle ops (`archiveBranch` / `restoreBranch` / `deleteForever` / `emptyTrash` / `listArchivedRefs`), and `readKeyAtTip` for reading a single key at a branch tip without materializing the session.
