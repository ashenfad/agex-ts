# kvgit remotes: git-native session sync

> **Status:** ephemeral design doc, June 2026. Not yet implemented. Supersedes
> nothing; informed by a live API spike against a scratch repo (2026-06-11).

## Motivation

agex-studio sessions are kvgit branches. Today the only way a session leaves a
device is the gist publish flow: walk the branch, ZIP every reachable object,
base64 the whole thing, upload. Every publish re-ships the entire history —
including the shared prefix that never changes — and there is no pull-side
story beyond "re-import the whole blob."

The goal: **auto-sync sessions across devices**, incrementally, with no backend
beyond the user's own GitHub account (a property the project already commits
to: static site, user-supplied PAT).

The core observation: kvgit is git-shaped — a content-addressed commit DAG over
keysets and blobs — and a GitHub repo is a passive object store with CAS-able
refs. Sync should exchange *only the delta* between two histories, and the
delta computation already exists in spirit (`_walkReachable` + `skipNodes` in
studio's `ts-bundle.js`).

## Decisions (made, with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | One private repo, one git branch per kvgit session branch | Mirrors studio's local model (one store, `chat-*` branches). Branches share object storage, so forked sessions stay cheap remotely. Branch list = session list (new-device discovery). Per-ref CAS isolates sessions. |
| D2 | **Semantic mapping**: each kvgit commit is a literal git commit | DAG fidelity (merges included), browsable history on github.com, HAMT nodes never cross the wire, conflict semantics collapse into git's. Snapshot-mapping (one git commit per sync) was considered and rejected; see "Alternatives." |
| D3 | Transport-agnostic `Remote` protocol in kvgit core; GitHub Git Data API as the first transport | Three implementations at birth: GitHub, bundles-as-degenerate-remote, future kvgit-py. Merge is **not** in the protocol — reconciliation is always local (git's own lesson). |
| D4 | Remote may be **passive** | The repo runs no kvgit code; protocol assumes only object storage + CAS-able refs. Any store with conditional writes (S3 If-Match, a tiny server) qualifies later. |
| D5 | GitHub is **not** a `KVStore` backend | Wrong latency grain (HAMT walks assume near storage), would ship kvgit internals (HAMT nodes, `__commit_root__` files) into the repo, and double-versions kvgit's own bookkeeping. Sync is replication, not storage. |
| D6 | Auth = fine-grained PAT scoped to the one sync repo, contents read/write | Token lives in localStorage; single-repo scope bounds the blast radius. Repo created manually via prefilled `github.com/new` link (least-privilege is the feature, not the workaround). Gist publishing keeps its classic `gist`-scope token (fine-grained PATs don't cover gists). |
| D7 | Sidecar manifests are **per-commit deltas**, not full keysets | A full-keyset sidecar is O(total keys) per commit (~600 KB/commit for a 5k-key session) — worse than the HAMT nodes we eliminated. Deltas are O(changed keys). Cost: materializing a session requires full-history replay; shallow fetch is a non-goal for v1. |
| D8 | v1 sync is **fast-forward only**; divergence is surfaced, not auto-merged | See "Divergence policy." |

## Spike findings (verified live, 2026-06-11)

- `POST /git/trees` with `base_tree` accepts nested `a/b/c` paths and
  synthesizes intermediate trees in one call.
- Binary blobs via base64 (NUL bytes included) work.
- `POST /git/commits` honors explicit author/committer dates exactly (even a
  1-second skew between them) and accepts multiple parents.
- `PATCH /git/refs/...` with `force: false` is a true server-side CAS:
  non-fast-forward updates rejected with 422 "Update is not a fast forward."
- Creating a commit whose parent doesn't exist → 422. **Pushes must replay
  ancestry in topological order.**
- Tree path validation: `.git` path components rejected ("malformed path
  component"); colons, spaces, and unicode are accepted.

A corollary worth its weight: because we set commit dates explicitly, **git
SHAs are deterministic** — re-creating the same blob/tree/commit returns the
same SHA. Push is therefore naturally idempotent and resumable; an interrupted
catch-up leaves unreachable objects (GitHub GC's problem) and simply re-runs.

## The `Remote` protocol

Defined over kvgit's *logical* model (commits, keyset entries, blobs), never
its storage layout. Sketch:

```ts
interface RemoteRef {
  branch: string
  head: string            // kvgit commit hash
}

/** One kvgit commit in wire form. */
interface WireCommit {
  hash: string            // kvgit commit hash (40-hex)
  parents: string[]
  time: number            // epoch ms (== __commit_time__)
  info: CommitInfo | null
  updates: Map<string, Uint8Array>   // key -> value bytes
  removals: Set<string>
  meta: Map<string, { createdAt: number }>  // fidelity for carried meta
  /** Merge commits only: keys adopted from the non-first parent WITHOUT
   *  rewriting bytes. Their keyset pointers reference the ancestor commit
   *  that owns the blob (`<owner>:<key>`), and contentHash covers the
   *  pointer map — so replay must reproduce these pointers exactly, not
   *  re-derive them from the first parent. size/createdAt ride along so
   *  the replayer can rebuild the carried keyset entry without consulting
   *  any parent keyset. */
  carries: Map<string, { owner: string, size: number, createdAt: number }>
}

interface Remote {
  listRefs(): Promise<RemoteRef[]>

  /** Commits reachable from `want` but not from any of `have`,
   *  in topological order (parents first). */
  fetch(want: string, have: Set<string>): AsyncIterable<WireCommit>

  /** CAS: fails (returns false) if the remote ref is not at `expectedOld`.
   *  `expectedOld === null` means "branch must not exist". */
  push(
    branch: string,
    expectedOld: string | null,
    newHead: string,
    commits: AsyncIterable<WireCommit>,
  ): Promise<boolean>
}
```

Notes:

- **Merge is absent by design.** Failed push → `fetch` the divergence → local
  three-way merge via existing kvgit machinery → push the merge commit.
- **Bundles become a degenerate Remote**: `fetch` with `have = ∅` is export;
  applying pushed commits is import. The existing bundle code (which today
  re-declares kvgit's private storage-key constants in studio — a layering
  smell) collapses into this interface.
- `WireCommit.updates` carries *value bytes*, not blob pointers. Blob storage
  keys (`<commit>:<key>`) are reconstructed during replay — the importer knows
  which commit wrote each key because it's processing that commit.
- **Integrity check for free**: the importer re-runs `contentHash` over the
  replayed state; the result must equal `WireCommit.hash`. A transport bug or
  tampered repo fails loudly at import.

### What kvgit core needs

1. **Delta walk**: `walkDelta(versioned, want, have) -> AsyncIterable<WireCommit>`
   — the generalization of `_walkReachable`, seeded with the reachable sets of
   `have`. Lives in core because it touches the storage layout
   (`__commit_root__` etc.).
2. **Replay/apply**: `applyWire(versioned, commits, { branch })` — writes
   commit records + blobs, rebuilds HAMTs locally (commit hashes don't cover
   HAMT node bytes, so local reconstruction is safe; root hashes are local-only
   pointers).
3. **Remote-tracking state**: last-known remote head per branch, stored in the
   same KVStore under a reserved prefix (proposal: `__sync_head__<branch>`),
   so it's atomic with the data it describes. (Does not collide with the
   `__branch_head__` prefix scan.)
4. **Sync orchestration**: `pull(remote, branch)`, `push(remote, branch)`,
   `sync(remote, branch)` composing the above with `latestHead()`/merge.

## GitHub wire format (the `@agex-ts/kvgit/github` transport)

One git commit per kvgit commit, on branch `<session-branch>` (same name as
local, e.g. `chat-ab12cd34`). `main` holds a README + repo marker
(`agex-sync.json`: format version, creation info).

### Commit anatomy

- **Message**: first line human-readable (e.g. the kvgit info's title or
  `"kvgit commit <hash7>"`), then a trailer block:

  ```
  Kvgit-Hash: <40-hex>
  Kvgit-Format: 1
  ```

- **Committer date** = `__commit_time__` (canonical). Author date = same.
- **Parents** = kvgit parents, mapped through the kvgit↔git SHA table.
- **Tree** = parent's tree + this commit's delta (built with `base_tree`).

### Tree layout

- Each key's current value is a blob at a path. Paths are a *rendering*;
  the sidecar is authoritative (see below). Layout rule:
  - Keys are split on `/` and nested naturally (VFS keys become a browsable
    file tree — a feature).
  - A path segment is escaped if it is `.git`, `.`, `..`, empty, or ends in
    a way git rejects (trailing `/`, etc.). Escaping is percent-style and
    bijective.
  - **File/dir collision rule** (keys `a` and `a/b` can't both be tree
    paths): when a key's natural path is shadowed by another key's directory
    (or vice versa), the *file-shaped* key relocates to a reserved flat zone
    `_kv/<percent-encoded-full-key>`. Deterministic given the keyset; the
    sidecar records actual paths, so readers never guess.
- `.kvgit/` directory at root:
  - `.kvgit/commit.json` — the per-commit sidecar (below).

### Sidecar: `.kvgit/commit.json` (per-commit delta)

```jsonc
{
  "format": 1,
  "kernel": "ts",                  // encoder discriminator, like bundles
  "hash": "<kvgit commit hash>",
  "parents": ["<kvgit hash>", ...],
  "time": 1760000000000,
  "info": { ... } | null,
  "updates": {                      // key -> placement + meta fidelity
    "<key>": { "path": "<tree path>", "createdAt": 1760000000000 }
  },
  "removals": ["<key>", ...],
  "carries": {                      // merge commits only; see WireCommit
    "<key>": { "owner": "<kvgit hash>", "size": 123, "createdAt": 1760000000000 }
  }
}
```

- Proportional to the *change*, not the keyset. Blob sizes are derivable from
  fetched bytes; blob pointers from replay; `createdAt` is carried explicitly
  because kvgit stamps it slightly before commit time (exact fidelity is
  cheap, so keep it).
- `kernel` matters because py-kvgit and ts-kvgit blob bytes are mutually
  unreadable (pickle vs JSON polymorphic codec) — same caveat as bundles. A
  device must route a branch to the matching kernel; record it per-branch and
  refuse cross-kernel checkouts.

### Push algorithm

```
walkDelta(local, localHead, {remoteTracking})  → wire commits, topo order
for each wire commit:
    for each update: ensure git blob exists      // skip via local SHA-1 cache
    POST /git/trees  (base_tree = parent's tree) // delta entries + sidecar
    POST /git/commits (explicit dates, parents via SHA map)
PATCH /git/refs/heads/<branch>  sha=<tip>, force:false   // ONE CAS at the end
on 422: fetch + merge locally (or surface divergence; see policy), retry
```

Per-turn cost: ~10–20 requests. Catch-up of N commits: ~N×(2+blobs) requests —
throttled (see rate limits) with a progress UI. Resumable because SHAs are
deterministic.

### Pull algorithm

```
GET /repos/.../commits?sha=<remote tip>&per_page=100     // walk back to known SHA
                                                          // (100 commits/request)
for each new commit (oldest first):
    GET .kvgit/commit.json at that SHA                    // contents API, 1 req
    for each update: fetch blob                           // contents API ≤1MB,
                                                          // git/blobs/<sha> above
applyWire(local, commits)                                 // rebuild HAMTs, verify hashes
advance __sync_head__; fast-forward local branch if applicable
```

## Divergence policy (v1)

Auto-sync is **fast-forward only**, both directions. When local and remote
have both advanced:

- Surface a "diverged" state on the session (badge + modal), with choices:
  1. **Keep both**: pull remote as a forked session (`chat-xxxx (device B)`),
     local continues as-is. Always safe, no merge code on the critical path.
  2. **Merge** (later milestone): kvgit three-way with registered merge fns.
- Why deferred: the *structural* merge is solved (CAS-fail → fetch → existing
  `commit({onConflict:'merge'})` → push), but the *semantic* merge functions
  need design. Verified hot spot: agex-ts events are one key per event
  (disjoint across devices — trivially carried), but **`__event_log__` is a
  single index key holding the ordered key array** — both sides rewrite it
  every turn. It needs a list-union merge fn (old/ours/theirs → old +
  both sides' additions, timestamp-ordered). VFS file conflicts and cache keys
  need LWW-vs-conflict decisions. Also semantically: two divergent agent
  conversations merged into one log may be *worse* UX than a fork even when
  the merge succeeds mechanically.
- With push-after-turn + pull-on-focus, true divergence should be rare for a
  single human; fork-on-divergence is an honest v1.

## Session roster & lifecycle across devices

**Principle (decided): the repo syncs session *visibility*, not just content.**
The ref namespace is the roster. Three states, mirrored locally:

| Remote ref | Meaning | Local mirror |
|---|---|---|
| `refs/heads/chat-x` | live | in the session drawer |
| `archived/chat-x` | deleted-but-recoverable | removed (surfaced via a "trash" view) |
| no ref | hard-deleted (retention expired) | gone |

- **New session locally** → branch pushed on first sync (CAS with
  `expectedOld: null`); it *appears* on other devices at their next roster
  sync. `chat-<hex8>` collision odds across devices ≈ 0.
- **Roster sync is eager; content is lazy.** `listRefs` is one cheap call, so
  the session list updates immediately. Materializing a branch is a
  full-history replay (D7), so remote-only sessions render as cloud stubs and
  fetch on open (or throttled background backfill). Stub display info
  (title/name) comes from reading the branch-meta key's blob at the tip via
  the contents API — no central index file (`sessions.json` on `main` would
  reintroduce cross-session CAS contention; refs-as-roster avoids it).
- **Deletion = archive.** Deleting a synced session renames its ref to
  `archived/<branch>` (create new ref + delete old). Other devices observe at
  next roster sync and remove it locally. **Restore** = rename back (if a live
  ref with the same name exists — ≈ never — suffix). **Hard delete** = delete
  the archived ref after a retention window (default 30 days, or manual).
  Surfaced as **"Empty trash"** (bulk) and per-item "Delete forever":
  `DELETE /git/refs/archived/<branch>`. Unreachable objects are reclaimed by
  GitHub's GC on its own schedule (not user-triggerable; unreachability is the
  part we control). Objects still reachable from other refs — e.g. a live fork
  sharing the archived session's history — survive automatically; that's just
  git reachability, no bookkeeping needed. Empty-trash vs restore race: a
  device restoring from local content simply re-pushes; a device restoring a
  cloud stub finds the ref gone and fails cleanly (UI should say so).
- **Local-only sessions** (sync toggle off) never enter the roster; deleting
  them is purely local. Mental model for UI copy: *synced sessions live in the
  repo; deleting one deletes it everywhere (recoverable from trash). Local
  sessions never left this device.*
- **Archive-vs-extend race**: device A archives while device B holds unpushed
  turns. B's push CAS fails (ref missing), B finds `archived/chat-x` → a
  *lifecycle* conflict, surfaced like divergence: restore-and-push, keep as a
  local-only fork, or discard. Simultaneous archives collapse benignly (the
  second rename fails → treat as already archived).
- **Per-device tokens** recommended (independently revocable); same token on
  both devices also works.
- **Terminology guard**: "sync" (private repo, automatic, roster-wide) and
  "publish" (gist, explicit, snapshot artifact) are different verbs in the UI.
  Conflating them would make users think deleting a session unpublishes a
  gist, or that publishing syncs devices.

## Studio integration (summary; lives outside this doc's scope)

Settings → Sync wizard: (1) prefilled `github.com/new?name=agex-sync&visibility=private`
link, tick "Add a README" (empty repos 409 on ref creation — bootstrap quirk);
(2) fine-grained PAT instructions (Only select repositories → the sync repo;
Contents: read & write); (3) paste token — auto-discover the repo via
`GET /user/repos` (fine-grained tokens list only accessible repos). Per-session
sync toggle; push debounced after turn commit; pull on focus + TTL (reuse the
`gist-update.js` cadence pattern); status glyph (synced / ahead / behind /
diverged). Multi-tab: sync engine takes a Web Lock so tabs don't race.

## Known weak points & open questions

1. **GitHub secondary rate limits** on content-creating POSTs (documented as
   ~80/min-ish, separate from the 5000/hr primary). Catch-up pushes must
   throttle (~1 req/s) — a 500-commit backlog is tens of minutes. Acceptable
   (one-time, progress bar), but verify the real numbers. ⚠ unverified
2. **No shallow fetch.** D7 (delta sidecars) means a new device replays full
   history. Inherent to wanting full history locally anyway (time travel), but
   a 2,000-commit session is ~2,000+ requests to clone. Future: periodic full
   keyset snapshot sidecars every N commits would enable shallow + backfill.
3. **Blob size ceiling** on `POST /git/blobs` — believed generous (≫ contents
   API's limits) but unverified; base64 inflates transfer 33%. Large VFS files
   are the risk case. ⚠ unverified
4. **`createdAt`/meta fidelity** — carried in sidecar, but HAMT root hashes
   will differ across devices regardless (local-only pointers; commit hashes
   don't cover node bytes). Confirmed safe by reading `kv.ts`, but worth a
   test asserting nothing compares roots cross-device.
5. **Roster edge cases** — archive/restore is decided (see lifecycle
   section), but the residuals need stress-testing: retention default for
   `archived/*` pruning, interaction with re-import-from-gist (an imported
   copy of an archived session is a *new* branch — should it warn?), and
   whether a fork of a synced session defaults to synced or local-only.
6. **Multi-tab + multi-device races** — ref CAS handles devices; Web Locks
   handles tabs; the *local* kvgit CAS handles writer/sync interleaving. The
   three compose but deserve an explicit test matrix.
7. **Privacy** — session content (event log, VFS, cache) lands in a private
   repo under the user's account. Same trust envelope as today's secret
   gists, but sync is *continuous* and *automatic*; the wizard copy must say
   so plainly.
8. **`gh`-style fine-grained PAT verification** — `GET /user/repos` returning
   only the token's accessible repos, and `github.com/new` prefill params:
   both believed true, both load-bearing for the wizard. ⚠ unverified
9. **kvgit-py portability** — this doc's "GitHub wire format" section should
   graduate into a language-neutral spec under `docs/` once stable; Python
   implements the spec, not the code. Blob bytes stay kernel-opaque (no
   cross-kernel session reading — same as bundles).
10. **Repo growth** — git keeps all pushed objects; abandoned divergent tips
    become unreachable after merges and GitHub GC reclaims them eventually,
    but a long-lived sync repo never shrinks below its live content. Likely
    fine (sessions are MBs); revisit if real usage says otherwise.

## Alternatives considered (and why not)

- **Whole-bundle re-push (status quo)**: re-ships unchanged history every
  time; ~10 MB gist API ceiling caps session size.
- **Delta bundles in the gist** (`delta-<from>-<to>.agex.b64` files + PATCH):
  cheap to build, no new auth — but no CAS (check-then-act races), file-count
  limits, and it's a dead end for the DAG/browsability/merge story. Was the
  v1 candidate until the Git Data API spike de-risked the real thing.
- **Per-object gist files**: same transfer win as delta bundles, worse limits.
- **Snapshot mapping** (one git commit per sync, tree of hash-named kvgit
  objects): fewer requests, simpler paths — but ships HAMT nodes, loses DAG
  fidelity/browsability, and the remote-is-derivable-from-local property
  makes the riskier format recoverable anyway (wipe & re-push per session).
- **GitHub-as-KVStore**: see D5.
- **isomorphic-git over smart HTTP**: GitHub sends no CORS headers on git
  endpoints; a proxy would custody tokens. Rejected on the no-backend
  principle.
- **OAuth / GitHub App** ("sign in and we create the repo"): needs a token
  exchange backend. Filed as a future onboarding upgrade (~50-line stateless
  worker) if wizard friction measurably hurts.

## Verification checklist (before implementation hardens)

- [ ] Secondary rate limit numbers for `git/blobs|trees|commits` POSTs
      (not actively probed — client defaults to 750ms write spacing
      ≈ 80/min and honors Retry-After; revisit if real syncs trip it)
- [~] `POST /git/blobs` max payload size — 1MB verified live; true
      ceiling unprobed (don't hammer the API to find it)
- [ ] `GET /user/repos` scope behavior with fine-grained PATs
- [ ] `github.com/new` prefill params still honored
- [x] Empty-tree commit creation — canonical `EMPTY_TREE_SHA` accepted
      (live test, kvgit/github)
- [x] Commits list API pagination on private repos — verified live
- [ ] Web Locks API availability matrix (Safari?)
- [x] Ref rename mechanics for `archived/*` tombstones — create+delete
      rename, slashed-ref listing, and restore verified live

## Post-M3 follow-up: unify the two tokens (artifacts repo)

Studio now has sync (private repo, fine-grained PAT) and publish
(secret gist, classic PAT). The two-token seam is an artifact of
gists specifically — fine-grained PATs don't cover the gist API. The
escape: publish bundles to a public `agex-artifacts` repo via the
contents API instead.

- One fine-grained token covers both repos (sync private + artifacts
  public) — the classic PAT and its wizard step disappear.
- Share links improve: `raw.githubusercontent.com/<u>/agex-artifacts/
  main/<slug>.agex.b64` is CDN-served, rate-limit-free, and the
  existing `?src=` receive path accepts it today. Pinning via
  `/<commit-sha>/` paths is truly immutable (better than gist-commit
  pinning for the gallery).
- The repo's file listing replaces the gist-comment manifest.

Decision gate before building: secret gists are UNLISTED ("anyone
with the link"); a public repo is browsable from the profile. That
privacy-semantics change needs a deliberate yes. Migration is gentle:
`?gist=` receive + legacy links stay supported forever; new publishes
target the new backend.

## Milestones

1. **M1 — kvgit core**: `walkDelta` + `applyWire` + `Remote` interface +
   `__sync_head__` tracking + sync orchestration. Bundle code refactored onto
   `walkDelta` (kills the constant-duplication smell). Memory-backed
   `Remote` impl for tests.
2. **M2 — `@agex-ts/kvgit/github` subpath**: the transport. Sidecar format, path
   escaping, SHA map, throttling. Integration-tested against a real scratch
   repo (CI-gated behind a token).
3. **M3 — studio UX**: wizard, toggles, badges, debounce/focus scheduling,
   diverged-state fork flow.
4. **M4 — spec + py**: extract wire format into `docs/` spec; kvgit-py
   implementation.
5. **(later)** — semantic merge fns (`__event_log__` list-union first),
   merge UI, snapshot sidecars for shallow fetch, OAuth onboarding.

## Implementation plan (PR-sized work items)

Dependency chains: 1→2→3(→4); 5→6→7→8→9; 10 ∥ M2; 11 needs 3+8; 12 needs
9+11. Sizes are relative (S/M/L).

### M1 — kvgit core (`packages/kvgit-ts`)

- **PR 1 (M): key-layout extraction + `walkDelta`.**
  Extract the storage-key constants from `versioned/kv.ts` into an internal
  `versioned/layout.ts` (no behavior change). Add `WireCommit` to `types.ts`
  (incl. `carries`). Implement `walkDelta(versioned, want, have)` yielding
  topo-ordered `WireCommit`s: reverse `history()`, per-commit keyset diff vs
  first parent (reuse `Keyset.diff` / `walk` with skip-sets), blob reads for
  updates, carry detection for merge commits (pointer ≠ first-parent pointer
  and not an update). **Hard bit**: merge-commit carry semantics — add a
  hash-fidelity test (build DAG with three-way merge, walk it, assert
  pointers reproducible).
- **PR 2 (M): `applyWire` + `__sync_head__`.**
  Replay: reconstruct commit records + blob writes (pointer map maintained
  per commit, carries honored), rebuild HAMT via `Keyset.updated` per commit,
  **verify recomputed `contentHash` equals the claimed hash** (refuse on
  mismatch), single `setMany` per commit, branch-ref creation. Remote-tracking
  state under `__sync_head__<branch>` (confirm prefix-scan non-collision with
  `__branch_head__`, as with the `_prev` precedent).
- **PR 3 (M): `Remote` interface + `MemoryRemote` + orchestration.**
  `listRefs/fetch/push` interface; in-memory implementation for tests;
  `pull`/`push`/`sync` composing walk+apply+CAS with a result type
  distinguishing `fast-forwarded | up-to-date | diverged | lifecycle-conflict`.
  Property tests: two stores round-tripping through `MemoryRemote` converge to
  identical commit hashes; sync is idempotent; divergence detected, never
  auto-merged.
- **PR 4 (S, optional, parallel after 1): bundles onto `walkDelta`.**
  Move bundle export/import into kvgit-ts as the degenerate Remote
  (`fetch` with `have = ∅`); studio's `ts-bundle.js` becomes a thin import.
  Deletes the duplicated key constants. Not on the critical path — schedule
  whenever convenient.

### M2 — `@agex-ts/kvgit/github` (subpath export, like `./backends/*`)

> Packaging decision revised during PR 5: folded into kvgit-ts as a
> subpath export rather than a separate npm package — no private
> coupling either way, but one less artifact to version/publish while
> pre-alpha. Splitting back out later is mechanical if ever needed.

- **PR 5 (M): GitHub client + verification spikes.**
  Subpath skeleton, fetch wrapper (auth, JSON, base64), throttle tuned to
  secondary rate limits, retry/backoff, error taxonomy (401 token / 403
  rate-limit / 422 validation), local git-SHA-1 (WebCrypto) for blob dedup.
  Burn down the verification checklist here as integration tests (blob size
  ceiling, secondary limit numbers, empty-tree commit, commits-list
  pagination).
- **PR 6 (S): path escaping + sidecar codec.**
  Pure functions, no I/O. Property tests: escaping bijective; file/dir
  collision rule deterministic; `.git`/`..`/empty segments guarded; sidecar
  round-trips.
- **PR 7 (L): `GithubRemote.push`.**
  Topo replay → blobs (dedup via SHA cache) → trees (`base_tree`) →
  deterministic commits (explicit dates) → single trailing ref CAS.
  Resumability test: kill mid-push, re-run, assert identical final SHAs and
  no duplicate objects.
- **PR 8 (L): `GithubRemote.fetch` + `listRefs`.**
  Commits-list walk-back to known SHA, sidecar reads, blob fetch (contents
  API with `git/blobs` fallback past 1 MB), `WireCommit` assembly. End-to-end
  test vs PR 7: push from store A, fetch into store B, hashes identical.
- **PR 9 (S): roster ops.**
  Archive (ref rename), restore (collision-suffixed), empty-trash /
  delete-forever, stub-metadata read (branch-meta blob at tip). Race tests:
  double-archive, restore-after-empty.

### M3 — studio (`agex-studio`)

- **PR 10 (M, parallel with M2): settings + wizard.**
  Sync section in settings: prefilled repo-creation link, fine-grained PAT
  instructions, token paste → repo auto-discovery → validation → marker file.
  No sync engine yet — connect/disconnect only.
- **PR 11 (L): sync engine wiring.**
  Per-session toggle, debounced push-after-turn, pull-on-focus + TTL (reuse
  the `gist-update.js` cadence pattern), Web Lock for tab exclusivity, status
  state machine (synced/ahead/behind/diverged), cloud stubs in the drawer
  with fetch-on-open.
- **PR 12 (M): lifecycle UI.**
  Trash view over `archived/*`, restore, empty trash, archive-vs-extend
  conflict modal, diverged-state fork flow. UI copy enforcing the
  sync-vs-publish terminology guard.

### M4 — portability

- **PR 13 (S)**: extract the wire format into a language-neutral spec under
  `docs/` once M2 stabilizes. kvgit-py implementation tracks the spec in its
  own repo/timeline.
