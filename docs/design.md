# Design history

The decisions behind agex-ts as rebuilt in October 2026, and why they
were made. How things work now is in each package's README; this keeps
the reasons, which the code doesn't. The full rebuild plan
(`plan.md`) and the first design for sync over GitHub
(`kvgit-remotes.md`) are in the repository's history, at `1f0879d`:

```bash
git show 1f0879d:plan.md
git show 1f0879d:kvgit-remotes.md
```

## The rebuild

The Python side had been rebuilt as three layers: kvgit (versioned
storage), nontainer (the world: workspace, kernel, turn, delegation)
and agex (the loop). The rebuild gave TypeScript the same layers:
`@agex-ts/kvgit`, `@agex-ts/world` and `agex-ts`, with
`@agex-ts/termish` as the world's shell, and agex-studio rebuilt on
them.

- **Breaking changes were free, storage included.** No back-compat
  readers or migrations: agex-studio's apps were ported by hand.
- **The Python corpora are the spec.** nontainer's harness corpus and
  agex's shape corpus are generated JSON, written so TypeScript could
  run them: the world runs the first, agex-ts the second. kvgit and
  termish take golden fixtures from Python the same way. A Python change
  that moves them is a TypeScript change too.
- **Parity goes both ways.** Where TypeScript was ahead (sync, the
  GitHub transport, termish's abort signal and output cap) it kept the
  lead.
- **Don't wait for Python's shape to freeze.** The vendored corpus is
  pinned to an agex commit; a later change to the shape arrives as a
  corpus diff to port.
- **Built on a branch, released together.** Every step was a PR into
  `rebuild` while agex-studio stayed on the published 0.x packages;
  `main` then took the rebuild, and every package releases at once.

## Storage

- **kvgit takes Python's v4 format, byte for byte:** content-addressed
  blobs, the `kvgit/4` commit hash, times in seconds. Breaking was free
  then, and it lets a session cross between TypeScript and Python later
  (by sync, a server, a device), with golden fixtures pinning it. It
  took one canonical JSON for hashing (Python's `json.dumps` escapes
  non-ASCII and JavaScript doesn't, so node hashes diverged), and a
  portable codec: pickle can't cross, so a session crosses where both
  sides have its codec.
- **kvgit takes Python's 0.4 API, async:** `Repo`, `Worktree`,
  `Snapshot`, `Commit`, branches and tags, typed errors, merge policy.

## The world

- **`@agex-ts/world` has nontainer's semantics, not all of nontainer:**
  no dud, Postgres, app serving or isolation rungs, which a serverless
  studio doesn't need.
- **Agent code reaches files by async calls** over RPC
  (`await fs.readFile(...)`). A snapshot copied in, or OPFS's sync
  handles, would cost more than an `await`, which TypeScript agent code
  writes anyway.
- **A commit per mutating call,** plus one at the turn's end stamped
  with how the run ended, as in nontainer. The old studio committed once
  per turn.
- **Skills live in the world:** a profile entry mounts skill files
  read-only under `/skills` and lists each skill in the tool text, so
  the loop never grew an overlay of its own.

## The loop

agex-ts became a small loop over the world, and **simplification was
the goal:** the world owns everything that isn't the loop, so the loop
should come out near Python agex's size. The old agex-ts was 11.6k
lines with five sibling packages beside it.

- **One async API.** Python's pairs (`say`/`asay`, `run`/`arun`) are one
  Promise-returning call each, with no private event loop.
- **One rung.** Agent code always runs in the world's worker, so every
  value crosses encoded and there's no in-process path.
- **Task types are Standard Schemas,** given as an object of parameters,
  since TypeScript has no runtime signatures. The model is shown a
  TypeScript declaration rendered from their JSON Schema. Agent code
  declares an agent-defined task's types as JSON Schema literals, the
  corpus's own form.
- **No reconfigure.** An agent holds no state, so a change of model or
  primer is a new `Agent` for the next turn; what must outlive it
  belongs to the workspace or the embedder.
- **Compaction is one large fold; chapters come later as ranged folds**
  on the same record, with their originals browsable under `/chapters`.
  The old chaptering was built on the old event log and went with it.
- **The providers are the AI SDK's, without its core.** A spike passed
  every provider through `doStream` directly, which keeps the loop
  agex-ts's own.
- **What went:** the worker runtime, git, provider and other sibling
  packages, the event log, the fixed action tools, `fn`/`cls`
  registration, the overlays, per-session stores, `spawn` and its
  clones. The world's kernel, tools, profile, sessions-as-branches,
  delegation and agent-defined tasks replaced them.

## Apps and services

What agex-studio's agent builds shaped the world's tools.

- **No agent-written backend.** On the Python side, nontainer's handlers
  exist for authority, shared state, server compute and a test loop.
  Without a server the first three fall away, and the test loop comes
  from logic kept in plain modules. An app is a static page, modules
  tested on their own, and data files in the world.
- **The user brings every service,** as they bring the model key: the
  model through their key (apps call it through the studio's bridge and
  never see it), sync and publishing through their GitHub token, shared
  state through their own Supabase project, live multiplayer peer to
  peer.
- **Fetch while building.** Static data is fetched into the world,
  cleaned and committed: versioned, reviewable, and working offline. A
  page goes to the network at run time only for what must be live.
  `curl` is a host command for this; since a browser reports a CORS
  refusal like any network error, it retries with `no-cors` to tell the
  two apart.
- **Live services get stand-ins:** the skills teach wrapping them in a
  small module with an in-memory fake, so tests never touch a real
  project.
- **Variables and secrets** were designed and deferred: a variable is
  public configuration, readable by code; a secret never enters the
  world, and only a host command making a request to one of its allowed
  origins uses it.
- **The Python kernel went** from the studio, with its Pyodide bridge.
  A shared kvgit format would let one store serve both kernels if it
  comes back.

## Sync over GitHub

The constraint: no backend. The studio is a static site, and the user
brings a fine-grained token scoped to one private sync repo.

- **Not git's own protocol.** GitHub's smart-HTTP endpoints send no CORS
  headers, so isomorphic-git would need a proxy holding the token.
- **GitHub isn't a store.** Its latency doesn't suit HAMT walks, and it
  would hold kvgit's internals. Sync replicates; it doesn't store.
- **First design (June 2026): each kvgit commit as a real git commit,**
  written through the Git Data REST API, each carrying a sidecar with
  that commit's changes. It shipped as `GithubRemote`, and taught:
  - a ref update with `force: false` is a true server-side
    compare-and-swap;
  - a commit's parents must exist first, so pushes replay history in
    order, and explicit dates make git SHAs deterministic, so a push
    can safely run again;
  - content-creating requests are rate limited (about 80 a minute), so a
    long backlog took many minutes to push, and a new device replayed
    every commit to clone;
  - the contents API transcodes what it takes for text, so it couldn't
    pull a world session.
- **Now (October 2026): one pack per push.** `PackRemote` sends each
  push's commits as one gzip(CBOR) pack, landed by one GraphQL
  `createCommitOnBranch` whose expected head is the compare-and-swap.
  The session list is one query, a pull one read per pack it lacks,
  and archiving and the trash one atomic `updateRefs`. Packs are read by
  their blob SHA, around the transcoding. See "Pack sync over GitHub" in
  [kvgit's README](../packages/kvgit-ts/README.md).
- **Rejected along the way:** re-pushing a whole bundle to a gist (about
  10 MB at most, and unchanged history every time), delta bundles in a
  gist (no compare-and-swap), and an OAuth app that creates the repo
  (it needs a backend for the token exchange).
- **App databases sync on top** (`@agex-ts/kvsql`): a log of changesets
  per database, in epochs, each starting from a snapshot. Its README has
  the details; agex-studio's `roadmap/app-db.md` has its design.
