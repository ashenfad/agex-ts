# agex-ts rebuild: plan

Status: under way, 2026-10-13. F1 (termish-ts) and F2 (kvgit-ts) are
done; F3 (the world package) is under way, at W1.

The Python side was rebuilt as three layers: kvgit (versioned storage),
nontainer (the world: workspace, kernel, turn, delegation) and agex (the
loop). Its shape and the reasons for it are in agex's `docs/design.md`.
This plan brings the TypeScript side to the same layers, in order:

1. **The foundation:** termish-ts and kvgit-ts to parity with termish
   0.2.2 and kvgit 0.4.2, and a new world package with nontainer's
   semantics, limited to what a serverless studio needs.
2. **agex-ts,** redesigned as a loop over the world package, matching
   agex 0.13 where it makes sense.
3. **agex-studio,** rebuilt on the new agex-ts.

`roadmap.md` stays the list of deferred work on today's agex-ts. Its two
entries (overflow protection, per-clone budgets) are superseded by this
plan: compaction folds within a run, and delegation is redesigned.

## Ground rules

- **Breaking changes are free, storage included.** No back-compat
  readers or migrations. Existing agex-studio apps are ported by hand.
  API compatibility only where it costs nothing.
- **agex-studio keeps working throughout.** It stays on the published
  0.x packages (kvgit-ts 0.1.3, termish-ts 0.2.0, agex-ts 0.5.0) until
  the studio phase moves it.
- **Parity goes both ways.** Where TS is ahead (kvgit sync and the
  GitHub transport, termish's abort signal and output cap), it keeps
  its lead, and the Python side may take it later.
- **The Python corpora are the spec.** nontainer's harness corpus and
  agex's shape corpus are generated JSON, written so TS could run them.
  The world package runs the harness corpus; agex-ts runs the shape
  corpus. kvgit and termish get golden fixtures from Python the same
  way (kvgit-ts's `merge-golden.json` is the precedent).
- **The rebuild lands on `rebuild`, not `main`.** Each step is a PR into
  `rebuild`, so `main` stays the code agex-studio is built from. When
  the rebuild is done, `main` fast-forwards to it.
- **One step is one PR,** or a short stack, with a changeset. The user
  drives merges and releases.
- **Nothing releases until the rebuild is done.** Then every package
  releases at once, in lockstep, from `rebuild` (decided 2026-10-13).

## Decided

- **TS is async throughout, and Python's sync/async split doesn't
  carry.** Each Python pair (`say`/`asay`, `run`/`arun`) is one
  Promise-returning call. Agent code awaits host calls, as decided on
  the Python side ("host calls stay sync in Python, awaited in TS").
- **Python's async-code round doesn't gate this work.** TS agent code
  has always been able to `await`; what TS needs from Python is the
  rest of the shape, settled in agex 0.13.

## What the audit found

**termish-ts** (0.2.0) behaves like Python termish 0.1.7: everything
from 0.1.8 to 0.2.2 is missing.
- **Behind:** no variable expansion (`$VAR`, `$?`, an env); no stderr
  model (`2>`, `2>&1`, `/dev/null`) and no exit codes on errors;
  strings in pipes instead of bytes, so binary is corrupted (`gzip -c f
  > f.gz`); no ranged `read`; no `test`/`[`, `zcat`, `jq`; grep has no
  exit 1 on no match, and no BRE translation in grep or sed; a failure
  mid-pipeline aborts it; old glob and `ls` rules; no `#` comments; no
  explanatory errors for control flow or `$(...)`.
- **Ahead:** an abort signal, an output cap, a binary guard on `cat`,
  and `RealFS` and `KvgitFS` adapters.

**kvgit-ts** (0.1.3) matches Python kvgit 0.3.7-0.3.9: the
`Staged`/`VersionedKV` API, and a storage layout like Python's old v2.
- **Formats:** both use the same HAMT and ref keys, and the same root
  commit, but TS is "storage v1" (commit-scoped blobs, millisecond
  times, `createdAt`) and Python is v4 (content-addressed blobs,
  `kvgit/4` commit hashes, second times). Each refuses the other's
  version stamp. Values differ too: Python defaults to pickle, TS to
  JSON or termish's polymorphic codec.
- **Behind:** the `Repo`/`Worktree`/`Snapshot` API and `Commit` records;
  tags (as GC roots); GC under a lease beside writers; `cas_many`, so
  HEAD and prev-HEAD move in one write (TS writes prev after the CAS,
  not atomically); merge policy (`merge_prefixes`, `MergeChoice`),
  fast-forward merges, `cherry_pick`/`revert`/`apply`; typed errors;
  named and chunked codecs; a content cache. TS loads every keyset on
  open.
- **Ahead:** sync (`WireCommit`, `walkDelta`/`applyWire`, a `Remote`
  protocol, fast-forward push and pull) and the GitHub transport; idb
  and sqlite backends; HEAD healing on the write path. Sync is tied to
  the v1 layout and `contentHash`.

**The world layer** has no TS package: agex-ts owns its substrate.
- **Workspace:** one `Staged` holds files (`KvgitFS`), cache and the
  event log, so one commit covers all three, as in nontainer. But cwd
  is not persisted, nothing commits per call (agex-studio commits once
  per chat turn), and agex-ts's "session" is a separate store, not a
  branch: the studio maps branches to sessions itself.
- **Turn and conversation:** no turn object; a run's status is a
  terminal event, not a commit stamp; no `interrupted`. The
  conversation is agex's event log (`__event_log__`, `evt/...`) in the
  world, rebuilt into a prompt on every step.
- **Kernel:** `@agex-ts/runtime-worker` runs each code emission as a
  fresh `AsyncFunction` in a Web Worker or Node worker. Agent code
  reaches files and host functions through async RPC; nothing persists
  between emissions but files and the cache. Cancel terminates the
  worker; the timeout is wall-clock per emission.
- **Host objects and grants:** `agent.fn/cls/namespace` registrations
  on the agent (the 0.12 shape), checked against a JSON or Standard
  Schema on the host. No profile; the worker still has `fetch` and
  IndexedDB.
- **Values:** `structuredClone` across the worker, Standard Schema
  (zod) for task types, superjson in storage.
- **Delegation:** `spawn` clones are ephemeral (memory FS, depth 1),
  with no branches, jobs or answers.
- **Compaction:** agent-directed chaptering at task boundaries, lossless
  (originals browsable under `/chapters`).
- **Ordering:** no workspace queue or lock; one task per session is
  assumed.
- **agex-git** is a virtual `git` command the studio doesn't use.

**agex-studio** also runs a **Python kernel**: Pyodide 0.27.7 with the
old agex stack (0.12 era) from micropip, on its own OPFS store. The
rebuild drops it (below).

## Decided for the foundation (2026-10-12)

1. **kvgit-ts adopts Python's v4 format, byte for byte:** content-addressed blobs, the `kvgit/4` commit hash, second times, the
   same entry fields. Breaking is free now, and it lets a session cross
   between TS and Python later (sync, a server, a device), with golden
   fixtures from Python pinning it. Two things need settling with it:
   - **Canonical JSON for hashing:** Python's `json.dumps` escapes
     non-ASCII and JS doesn't, so node hashes diverge on non-ASCII
     keys. One rule, written down and tested on both sides.
   - **A portable codec:** pickle can't cross. The structure is
     identical whatever the codec; values cross where both sides have
     the codec, so a JSON-family codec (TS's polymorphic one, named and
     registered on both sides) is what makes a session portable.
2. **kvgit-ts takes Python's 0.4 API,** async: `Repo`, `Worktree`,
   `Snapshot`, `Commit`, `repo.branches`/`repo.tags`, typed errors, and
   merge policy. Every consumer is rewritten in later phases anyway.
3. **The world package is `@agex-ts/world`,** after the design's
   vocabulary (world, kernel, loop, host). It is nontainer's
   counterpart, but not a port of all of it: no dud, Postgres, apps
   serving or isolation rungs.
4. **Agent code keeps async file access** over RPC
   (`await fs.readFile(...)`). The alternatives (a snapshot copied in,
   OPFS sync handles) cost more than an `await`, which TS agent code
   writes anyway.
5. **Commits follow nontainer:** one per mutating call, plus one at the
   turn's end stamped with how the run ended. Today the studio commits
   once per turn.

## Decided for apps and services (2026-10-12)

What agex-studio's agent builds, and what it reaches, shape the world's
tools and the studio's bridge.

- **No agent-written backend.** nontainer's handlers exist for
  authority, shared state, server compute and a test loop. Without a
  server the first three fall away, and the test loop comes from logic
  kept in plain modules. An app is a static page, modules tested on
  their own, and data files in the world.
- **Everything is brought by the user,** as the model key already is:

  | need | provided by | how the app reaches it |
  |---|---|---|
  | a model, for building and for apps' AI calls | the user's own key | the studio holds it; an app calls through the bridge and never sees it |
  | sync and publishing | the user's GitHub token | the studio |
  | shared, persistent state | the user's Supabase project | from the page, with row-level security as the guard (`supabase-auth` skill) |
  | live multiplayer | free signaling, then WebRTC peer to peer | from the page (a `multiplayer` skill, to write) |
  | public data | CORS-friendly APIs | fetched while building and committed, or live from the page |

- **Fetch while building, by default.** Static data is fetched into the
  world, cleaned and committed: versioned, reviewable, and working
  offline on a tablet. A page goes to the network at run time only for
  what must be live (shared state, multiplayer, fresh data), and its
  README lists every service it depends on.
- **`curl` is a studio host command:** `-o`, `-L`, `-H`, `-X`, `-d`,
  `-s`/`-f` and a size cap, writing into the world. A browser reports a
  CORS refusal as the same network error as DNS, TLS or being offline,
  so on a failure it retries with `mode: 'no-cors'`: if that gets an
  (opaque) answer, the server is up and it names CORS as the likely
  cause; otherwise it reports a network failure. It fetches data while
  building, and tests the user's own services from the terminal
  (Supabase's REST API with the anon key, say), as `ws-curl` tests a
  handler.
- **Live services get stand-ins.** The skills teach wrapping Supabase or
  peer-to-peer access in a small module with an in-memory fake, so
  module tests and `testApp` never touch a real project, as
  `agex_stand_in` does for tasks on the Python side.
- **Variables and secrets.** The user gives the agent keys in the
  studio, never by pasting them into chat. There are two kinds, and
  the user picks which when adding one:
  - **A variable** is ordinary configuration, public by design: a
    Supabase URL and anon key, a public API's base URL. It is a shell
    variable (`$SUPABASE_URL`) and readable from code, lives in the
    world's profile (as nontainer's `Profile.variables` do), and a
    published app may embed it, which is how a page gets its anon key.
  - **A secret** (an API token, a service key) never enters the world.
    termish does not expand it and code cannot read it. Only a host
    command that makes a request uses it, at the request: `curl`
    substitutes `$NAME` in a header or URL, and code passes an opaque
    handle (`secret('NAME')`) that the host's `fetch` accepts as a
    header value. So the value never reaches a file, stdout, the
    model or agent JS, and a command that prints or writes `$NAME`
    gets the name, not the value.
  - **A secret is bound to the origins it may be sent to** (the
    project URL it came with), so `curl https://elsewhere -H "x:
    $TOKEN"` is refused rather than leaking it, and only the user's
    own service could echo it back.
  - **A backstop, not a guarantee:** committing, publishing, syncing
    and making a gist scan for each secret's exact value and refuse
    if they find it. An encoded copy gets past the scan, which is
    why the boundary above, not the scan, is what keeps secrets out.
  - Secrets stay on the device, as the model key does: never in a
    commit, the conversation, a published bundle, a gist or a sync.

## The foundation

### F1. termish-ts to parity (independent; can start at once)

In roughly this order, each with Python's tests ported as the spec:
Items 1-4 are merged (#67, #68, #69): the interpreter core, globbing,
`ls`, POSIX errors (`FsError`) and the builtins. The ranged `read` and
`makedirs` of item 1 were left out: nothing needed them.

1. **Bytes in pipes,** and a ranged `read` in the FS protocol (which
   also gains `makedirs`, matching Python's protocol). Fixes binary.
2. **Exit codes and stderr:** `TerminalError` carries an exit code (127
   for a missing command); `2>`, `2>>`, `2>&1`, `/dev/null`; the stderr
   of a failure execution continued past, and of successful commands;
   a failing command's stdout kept.
3. **Variable expansion:** `$VAR`, `${VAR}`, `$?`, an env passed in.
4. **Builtins and semantics:** `test`/`[`, `zcat`/`gzcat`; grep's exit
   codes; BRE translation for grep and sed; pipeline failure rules;
   glob and `ls` rules from 0.2.2; `#` comments; explanatory errors for
   control flow and `$(...)`.
5. **The FS conformance kit exported,** as Python's `check_filesystem`
   is.
6. **`jq`: not now** (decided 2026-10-12). It is 1.7k lines of Python,
   and the agent parses JSON in code. A small subset (`.`, `.key`,
   `.[]`, `.[n]`, `keys`, `length`) comes later if dogfooding shows
   agents reaching for `curl ... | jq`.

**Exit:** Python termish's behavioural tests (expansion, stderr, binary,
injection, BRE, globs) pass in TS, ported or as golden fixtures.

### F2. kvgit-ts on v4 and the 0.4 API

1. **F2a. Storage v4.** Content-addressed blobs, the v4 commit hash,
   the entry fields and times, the canonical JSON rule; golden fixtures
   generated by Python (stores, commit hashes, merge results) checked
   byte for byte. The backends keep `cas` and gain `casMany`, so HEAD
   and prev-HEAD publish in one write.
2. **F2b. The API.** `Repo`, `Worktree` (buffered writes, async
   commit), `Snapshot` (lazy per-key reads, not the whole keyset on
   open), `Commit`, branch and tag collections, typed errors.
3. **F2c. Merges.** Merge policy and functions returning
   `MergeChoice`, fast-forward by default, `cherryPick`/`revert`/
   `apply`, the generation-bounded LCA.
4. **F2d. GC beside writers.** Tags as roots, in-flight markers and the
   lease, so collection doesn't need a quiet store.
5. **F2e. Sync on v4.** `WireCommit`, the delta walk and the GitHub
   transport moved onto content-addressed blobs (which should make the
   delta simpler: a blob already present is never sent again).
6. **F2f. Codecs.** Named codecs, the polymorphic one among them, and a
   content cache if reads need it.

**Exit:** the Python golden fixtures pass; the shared KV conformance
suite passes on memory, idb and sqlite; sync round-trips on v4. Met
2026-10-13; kvgit-ts releases with the rest of the rebuild.

### F3. The world package

nontainer's semantics for a serverless studio. In order:
1. **W1. Store and workspace:** sessions as branches of one repo, files
   (`KvgitFS` on a `Worktree`), the cache, and a persisted cwd, all on
   one branch; fork, checkout, tags; a per-workspace queue, so a call's
   writes and its commit don't interleave with another's (the TS
   counterpart of nontainer's workspace lock).
2. **W2. The kernel:** `runtime-worker` moves under the world as its
   executor. Host objects are granted to the world, not the agent (a
   profile, inherited by forks), reached by async RPC with a declared
   surface. Cancel terminates the worker and restarts it; what the code
   wrote before it stopped is committed, as in nontainer. **Variables
   and secrets** come with the profile (see "Decided for apps and
   services").
3. **W3. The tools:** `terminal` (termish-ts with the world's host
   commands), the code tool, `file_write` and `file_edit`, with
   nontainer's names and MCP-shaped results. There is no `ws-curl` or
   `ws-pytest` (no handlers to call): an app is checked by a module test
   runner and by `testApp`. `curl` is a host command the studio grants,
   not a termish builtin, so termish stays network-free.
4. **W4. The turn:** `ws.turn(runId)`, a commit per mutating call and
   one at the end stamped with the run's status (`completed`,
   `cancelled`, `failed`, `interrupted`), and the harness-neutral
   conversation index (`__conversation__/`) with per-run bodies.
5. **W5. Values:** what crosses the worker and what is stored, by
   value: live parts refused where they would cross, a stored encoding,
   and values checked against a declared type (a Standard Schema).
6. **W6a. The inbox:** notes queued for a running agent, delivered on
   its next tool result (`turn.deliver`) or opening a woken turn
   (`turn.opening`), framed by who is speaking, settled when the turn
   ends. Corpus tier 3.
7. **G1-G3. ws-git, in full:** the agent's git over its own session,
   ported whole rather than as the three verbs an answer names.
   - **G1. The host verbs:** `ws.index` (the agent's staged set, its
     commits, log, head, checkout and bookmarks, apart from the
     framework's autocommits) and `ws.merge` / `revert` / `cherryPick`
     with conflict markers, a merge left outstanding and its abort, on
     kvgit-ts's merges and marker text merge.
   - **G2. Views and mounts:** a fork narrowed to some paths (`paths`),
     another session's tree mounted read-only (`worktree add`), and
     ignore patterns.
   - **G3. The `ws-git` command,** a terminal builtin, verb for verb,
     with a script corpus nontainer exports (scripts, their output and
     exit codes) run here verbatim, as the harness corpus is.
8. **W6b. Delegation:** nontainer's `Sessions` on ws-git: delegates as
   forked branches (narrowed by `paths`), jobs and answers, a runner
   per job, `untilSettled`, answers delivered through the inbox, and
   the `sessions` tool. Corpus tier 5.
9. **W7. Compaction's record:** the `__compaction__/` plane and its
   rules, so any loop's folds rewind and fork alike.

**Exit:** the world package runs nontainer's harness corpus (the tiers
it covers) from the generated JSON, and its own suite on memory and idb.

**Decided for the world (2026-10-13):**
- **nontainer's semantics, not its bytes.** Only kvgit's format is
  shared with Python. The world keeps its own keys (readable paths, not
  base32) and its own records, on the `cbor` codec, and follows
  nontainer's meaning: sessions as branches, a commit per mutating call
  with nontainer's commit info (`{tool: 'file_write'}` and the rest),
  checkout as an appended restore commit, tags scoped `<session>/<name>`
  and `@store/<name>`.
- **The queue isn't re-entrant.** A promise queue can't tell a callback
  from a new caller without `AsyncLocalStorage`, which browsers lack.
  Code inside a call uses the unqueued filesystem and cache, as
  nontainer's kernel does; W2 revisits it if a host object needs to call
  back into the workspace.
- **Left out of W1:** mounts, views (`paths` on fork), `put` and
  `attach`, `ignore`, and `ws-git`. Views, mounts, ignore and ws-git
  come with G1-G3 (decided 2026-10-13).
  `files.edit` comes with the `file_edit` tool in W3, with its
  agent-tolerant matching; the conversation rebind on fork and checkout
  comes with the conversation in W4.

**Decided for the kernel (2026-10-13):**
- **`ws.runCode`, committed as `run_ts`.** Named for its language, so a
  Pyodide `run_python` could sit beside it.
- **The script model.** Neither nontainer nor the old worker kept
  variables between calls, so the kernel holds no state: the files and
  the cache are what carry over, and close, fork and checkout have
  nothing to rebuild.
- **The kernel lives in the world,** ported from `runtime-worker`
  without the loop's parts (`taskSuccess`/`taskFail`, `inputs`,
  `spawn`, `Policy`). Host classes (`agent.cls`) are dropped. The old
  package stays for the old agex-ts until the agex-ts phase.
- **A stopped run keeps its writes.** A timeout (30 seconds by
  default, set in the profile) or `ws.interrupt()` terminates the
  worker; what the code wrote is committed, as in nontainer.
- **Re-entrancy is explicit.** A host method declared `withCall` gets
  the calling workspace as part of the code's call, so it can fork or
  commit inline (nontainer's delegation from code needs this); other
  calls queue.

**Decided for the tools (2026-10-13):**
- **Five tools,** with nontainer's names, schemas and result text:
  `terminal`, `file_write`, `file_edit`, `view_image`, `run_ts`. `run_ts`
  is always its own tool; there is no terminal-only mode and no `node`
  in the shell.
- **The edit engine is nontainer's,** checked against `editing.py` by
  golden cases (`scripts/golden-editing.py`), with agex-ts's near-miss
  notes (look-alike characters, Unicode form) added.
- **Results are MCP-shaped:** `toMcpResult` gives text, image and
  resource-link blocks, with `isError` set for a failure the agent can
  act on (nontainer leaves it false).
- **Secrets:** the shell expands a secret to a reference to itself,
  and code's `secret('NAME')` gives the same reference. Only the host's
  own code holds values: commands made with `commandFactory`, host
  objects made with `hostFactory` (a client built with a key), and the
  `http` host object, which with `curl` fills references in a URL or
  header and scrubs echoes from what comes back. A secret given as
  `{value, origins}` is filled only for those origins and its requests
  follow no redirect; a plain string is unbound, the host's choice.
- **Code errors** show the code's own frames at its own line numbers,
  with hints re-keyed to this kernel.
- **Later:** `test_app` and a module test runner (the studio phase),
  and the `sessions` tool (W6).

**Decided for the turn (2026-10-13):**
- **nontainer's turn API,** async: `ws.turn(runId, {resume, harness})`,
  `turn.end(status, {body, record, message})`, `ws.runTurn(fn)` for the
  exceptions-to-status mapping. A turn never changes autocommit; its end
  commits only what's left.
- **The conversation index** keeps nontainer's fields (in camelCase)
  and a body per run; a full fork rebinds it to the child, a checkout of
  a pre-fork commit reclaims it, a fresh fork wipes it.
- **The corpus runs in TS:** `@agex-ts/world/conformance` bundles
  nontainer's exported scenarios verbatim (`scripts/sync-corpus.mjs`)
  with a port of its runner. A reference harness in the tests passes
  tiers 0 to 2; the inbox (tier 3) comes with W6a, delegation (tier 5)
  with W6b, and compaction (tier 4) with its record (W7).

**Decided for ws-git's host verbs (G1, 2026-10-13):**
- **nontainer's fiction, ported:** the blob, partial commits with their
  restore, the agent's graph through `virtualParents`, bookkeeping kept
  out of `ws.log()` by default, merges and applies recorded in the
  graph, an outstanding merge until its markers go, and abort.
- **On kvgit-ts's engine:** `merge` (never fast-forwarding), `apply`
  for revert and cherry-pick, its marker text merge, keyed commits.
- **Where the TS world differs:** a commit's info is camelCase
  (`virtualParents`, `restoreOf`); a delegate's first commit is measured
  from the `base` its blob recorded at the fork, rather than by walking
  to the fork's commit; a directory record stays while this side has
  files under it (the TS filesystem keeps directories as records); and
  a record two sides changed alike, with content merged to other bytes,
  has its size corrected in the merge's bookkeeping commit.

**Decided for views and mounts (G2, 2026-10-13):**
- **nontainer's semantics:** a narrowed fork's view (the write rule, the
  record and its seed, merged as ours, not inherited by a whole-tree
  fork), `diff`'s seed grouping, `checkout(ref, {paths})` from any ref
  with directory mirroring, `files.attach`, and ignore patterns (outside
  the root, and a `.gitignore` subset) left out of everything that
  decides what work is.
- **The filesystem the agent and the host see is composed:** the
  session's own (`WorldFS`), a `ViewFS` over it, an `AttachFS` over
  that. The workspace's own verbs use the session's filesystem beneath.
- **Left out:** nontainer's app-runtime authoring directories
  (`app/logs`, `app/screenshots`) have no runtime here yet; symlinks
  (the world's filesystem has none); a frozen view isn't narrowed.
- **termish gains `EACCES`** for the view's refusals.

**Decided for the ws-git command (G3, 2026-10-13):**
- **A word-for-word port,** checked against a script corpus nontainer
  records and exports (nontainer#251): 37 scripts, every command's
  stdout, stderr and exit code, commit ids named by first appearance.
  The world's test replays them; one step is a known difference
  (nontainer's hint names its Python spelling, `paths=None`).
- **A profile command, not built in:** `commands: {'ws-git': wsGit}`,
  as nontainer's `register_wsgit` is the embedder's call.
- **Diffs print Python's hunks:** difflib's `unified_diff` over
  kvgit's `SequenceMatcher` port (now exported), checked against
  CPython's output.
- **The world's agent-git messages are nontainer's,** word for word,
  since ws-git prints them.

**Decided for delegation (2026-10-13):**
- **Two steps around ws-git.** The inbox (W6a) comes first; ws-git is
  ported whole (G1-G3), for parity with nontainer, before delegation
  (W6b), so a delegate's answer names real verbs and `ask` takes
  `paths` from the start.
- **Async throughout.** A runner is `async run(session, task, {signal,
  forkedAt, budget})`; cancelling a job aborts its signal. nontainer's
  thread and coroutine twins (`ask`/`aask`, `wait`/`await_ready`) are
  one Promise-returning set.
- **ws-git's parity is checked by a corpus,** exported from nontainer
  as the harness corpus is.
- **nontainer's `Sessions`, ported (W6b):** the job table and its
  verbs, the remainder committed for a delegate, `changed` measured
  from where parent and child last met, `forkFrom`, `resume`, the
  retention sweep, `untilSettled`, `answerNotes`, and the `sessions`
  tool with nontainer's description and result text. Corpus tier 5
  passes on the reference harness, through a port of
  `CorpusDelegates`.
- **Where the TS helper differs:** one async API; a runner returns a
  string or the parts of an answer only it knows (`text`, `status`,
  `artifacts`, `provenance`); times are milliseconds since the epoch,
  and `sweep`'s `idle` is seconds, as `store.delete`'s `minAge` is;
  `cancel` stops the run (its signal) as well as discarding the answer;
  the sessions tool marks a refusal `isError`, as the world's other
  tools do; the conformance clock's `next` is async, so a
  `delegate_answers` event waits for the answer before the next reply;
  `Sessions.of` finds a session's helper by store and session, so a
  `HostCall`'s workspace finds it too, and an ask from code passes
  `{call}`.

**Decided for compaction's record (W7, 2026-10-13):**
- **nontainer's record and helpers, ported:** a `Fold` per key under
  `__compaction__/fold/`, never rewritten, pending until the turn's
  next commit; `inForce` by anchor; `Policy`, the summary texts word
  for word, `reduce`, `transcript`, `chunks`, `estimateTokens`, and the
  inserted-message mark. The plane's rules (ours in a merge, wiped by a
  fresh fork) were already in place from W1 and G1.
- **The algorithm stays each loop's,** as in nontainer: the reference
  harness folds as nontainer's does, and corpus tier 4 passes on it, so
  the reference harness passes every scenario.
- **Where the TS record differs:** camelCase fields (`tokensBefore`),
  `at` in milliseconds, the mark is `compaction:` rather than
  nontainer's own name, and the record lives on `ws.compaction` (with
  `folds`, `inForce`, `record`) rather than module functions over a
  workspace.

**Decided for values (2026-10-13):**
- **A declared type is a Standard Schema** (zod, valibot, arktype), as
  agex-ts's tasks already use, not a type system of the world's own:
  TS types don't exist at runtime. How strict a check is (coercion and
  all) is the schema's choice. Its JSON Schema, for showing a model, is
  the library's own (Standard JSON Schema).
- **The stored encoding is the world's CBOR codec** behind a format
  header (`world-value/1`), not a port of `nt-value/1`: values are
  nontainer's semantics, not its bytes. Decoding runs no code, so the
  type checks the shape after it rather than guarding it.
- **Typed host objects** are nontainer's stubs: `typedHost(obj,
  contract)` exposes the contract's methods, checks each argument on the
  host (a mismatch is a `TypeError` at the call), hands the method what
  the schemas return, and checks the result.
- **Live parts are refused where they'd cross,** naming where (`at
  [0].client: a live Client`): structured clone would turn a class's
  instance into a plain object.
- **Tables are left out:** the code's `apache-arrow` isn't the host's
  module, so a table needs Arrow IPC at the boundary and the library on
  both sides. They come with the first task that needs one.

## Then agex-ts

Redesigned as a loop over the world package, matching agex 0.13: an
`Agent` as a recipe (model, primer, settings, limits); two front doors,
`agent.session(ws)` and `agent.task(...)`, returning an `Outcome`; the
`task` host object (`success`, `fail`, `needsInput`) and resuming; the
run record and `TurnEvent`s; providers behind a small protocol;
compaction within a run; agent-defined tasks through an `agex` host
object; delegation through the `sessions` tool. Its own plan is written
when the foundation is done, against the shape corpus. Open there:
whether agent-directed chapters survive beside folding.

**Decided for the redesign (2026-10-13):**
- **Providers are the Vercel AI SDK's** (`@ai-sdk/anthropic`,
  `@ai-sdk/openai`, `@ai-sdk/google`, OpenRouter's
  `@openrouter/ai-sdk-provider`), used as transport only behind agex's
  own provider protocol, as Python agex uses pydantic-ai. They replace
  `@agex-ts/anthropic`, `openai` and `gemini`, whose interface is tied
  to the old fixed tool set. A spike in the studio comes first:
  browser access (CORS), thinking signatures round-tripping, cache hits
  matching today's, and the bundle's size.
- **Task types are Standard Schemas,** the world's declared types (W5).

## Then agex-studio

Rebuilt on the new agex-ts, with its apps ported by hand. Decided and open there:
- **The Python kernel is dropped** in the rebuild (decided
  2026-10-13), with its Pyodide bridge. It may come back as an option
  if a need for both languages together appears; a matching kvgit
  format (decision 1) would let one store serve both kernels then.
- **Sync** moves onto kvgit-ts v4 (F2e) and the world's branches.
- **agex-git** is folded into the world as its ws-git, or dropped.
- **The bridge** is the app's whole server-side surface, designed on
  purpose: agent-defined tasks on the viewer's own key with a per-page
  budget, storage and cache. Live network access from a page is direct,
  to the services in "Decided for apps and services".
- **Skills:** `interactive-app` and `supabase-auth` carry over; new ones
  teach fetching while building, stand-ins for live services, and the
  `multiplayer` pattern (signaling, then peer to peer).
- **Variables and secrets** get their settings screen, beside the model
  key.

## Risks

- **Two moving targets.** The Python shape isn't frozen. The foundation
  ports settled parts (kvgit 0.4, termish 0.2, nontainer 0.11's
  semantics); agex-ts waits until the parts it ports are pinned by the
  shape corpus.
- **The studio on old packages for a long time.** Fixes it needs in
  that time land on the 0.x line, or wait.
- **Byte compatibility is easy to lose.** Golden fixtures generated by
  Python, run in TS CI, are the guard; a Python change that moves them
  is a TS change too.
