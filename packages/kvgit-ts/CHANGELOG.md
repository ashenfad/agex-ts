# @agex-ts/kvgit

## 0.1.1

### Patch Changes

- 5c222cc: Added the sync layer: kvgit histories can now replicate between stores and sync across devices through a GitHub repo.

  - **Wire form & replication**: `WireCommit` (the commit-shaped unit of transfer), `walkDelta(store, { want, have })` to stream a history delta, and `applyWire(store, commits)` to replay it — with every commit hash recomputed from replayed state and refused on mismatch.
  - **Remote protocol**: the transport-agnostic `Remote` interface (`listRefs` / `fetch` / `push`-with-CAS), `MemoryRemote` reference implementation, and fast-forward-only orchestration via `pullBranch` / `pushBranch` / `syncBranch` (divergence is detected and surfaced, never auto-merged). Remote-tracking heads via `getSyncHead` / `setSyncHead` / `clearSyncHead`.
  - **GitHub transport** (new `@agex-ts/kvgit/github` subpath): `GithubClient` (throttled, retrying Git Data API client with an error taxonomy), `GithubRemote` (each kvgit commit pushed as a real git commit — browsable sessions, incremental deltas, resumable interrupted pushes, transport-state rebuild from remote sidecars), roster lifecycle ops (`archiveBranch` / `restoreBranch` / `deleteForever` / `emptyTrash` / `listArchivedRefs`), and `readKeyAtTip` for reading a single key at a branch tip without materializing the session.
