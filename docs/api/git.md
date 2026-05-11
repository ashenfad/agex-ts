# Git

`agex-git` adds a `git`-style command to the agent's `terminal_action`, letting the agent checkpoint / branch / diff / merge its workspace files. Branches and commits are *virtual* — they live in the same kvgit substrate as the agent's state, so a `git commit` is a true snapshot of file content + agent memory together.

Ships as a separate package (`agex-git`) — opt in by calling `registerGit(agent)` once during setup.

## Prerequisites

The agent must use the unified kvgit substrate — file content shares one `VersionedKV` with cache, event log, and metadata. Configure with `state: { type: 'versioned', ... }` and `fs: { type: 'kvgit' }` on `createAgent`. The kvgit `Staged` is what `VirtualGit` operates over; `registerGit` errors at command-invocation time if the agent's `fs` isn't a `KvgitFS`.

## Setup

```ts
import { createAgent } from 'agex-ts'
import { registerGit } from 'agex-git'
import { workerRuntime } from '@agex-ts/runtime-worker'
import { connectAnthropic } from '@agex-ts/anthropic'

const agent = await createAgent({
  name: 'analyst',
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
  runtime: workerRuntime({ workerUrl: new URL('./worker.js', import.meta.url) }),
  state: { type: 'versioned', storage: 'indexeddb' },
  fs: { type: 'kvgit' },
})
registerGit(agent)
```

`registerGit` does two things:

1. Mounts a usage skill at `/skills/git/SKILL.md` so the agent can `cat /skills/git/SKILL.md` for the in-depth reference.
2. Registers `git` as a host terminal command. The agent runs it inside `terminal_action` like any other shell tool.

## What the agent sees

Available subcommands, all callable from `terminal_action`:

| Subcommand | Purpose |
|---|---|
| `git status` | Branch + staged/unstaged + recent commits. |
| `git log [--oneline] [-n N] [path]` | Walk the virtual ancestry; first-parent through merges. |
| `git diff [<ref>] [<ref>] [-- path]` | 0/1/2 refs against HEAD / working tree, with optional path filter. |
| `git show <ref>:<path>` | File content at a specific commit. Empty ref = `HEAD`. |
| `git add <path>... \| . \| -A` | Stage paths (the index is metadata-backed and persists across calls). |
| `git rm [-r] <path>...` | Remove from the working tree and stage the deletion. |
| `git commit -m '<message>'` | Selective when index is non-empty; full otherwise. |
| `git reset --hard <ref>` | Restore working tree to `<ref>`; rewinds the virtual branch ref. |
| `git branch [-d \| -D] [<name>]` | List / create / delete (safe / forced). |
| `git checkout [-b] [-f] <name>` | Switch branches; `-b` creates first; `-f` discards pending. |
| `git merge <source>` | Already-up-to-date / fast-forward / 3-way "source wins". |

Refs accepted everywhere a ref is taken: `HEAD`, `HEAD~N` (`N >= 0`), branch names, hash prefixes (≥ 7 chars). Branch names take precedence over hash prefixes when ambiguous.

## Key differences from real git

- **`git add` is optional** — `git commit` with an empty index commits every modified file. Use `git add` when you want to commit only specific files.
- **`git commit -m '...'` is required** — `-m` is mandatory; there's no editor flow.
- **Local only** — no `push` / `pull` / `fetch` / `remote`.
- **Only `reset --hard`** — no `--soft` / `--mixed`.
- **Merges are "source wins" on conflict** — no three-way text merge. When both branches changed the same file, the source's version wins. Use branches for independent experiments rather than parallel edits to the same file.
- **`git reset` doesn't lose data** — kvgit's physical commit chain only moves forward. Resetting rewinds the *virtual* branch ref; the pre-reset commits remain reachable via their hashes.
- **Branch ops only touch virtual refs** — kvgit's own branches (event log, REPL state, agent memory) are never moved by `git checkout` / `git branch`.

## Programmatic API

For tests and library callers that want to drive git without going through `terminal_action`, the same operations are exposed as a `VirtualGit` class:

```ts
import { Staged, VersionedKV } from 'kvgit-ts'
import { Memory } from 'kvgit-ts/backends/memory'
import { polymorphicDecoder, polymorphicEncoder } from 'termish-ts/fs/kvgit'
import { VirtualGit } from 'agex-git'

const vkv = await VersionedKV.open(new Memory())
const staged = new Staged(vkv, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
const vg = new VirtualGit(vkv, staged)

await vg.commit('initial')
await vg.createBranch('feature')
await vg.checkout('feature')
// ... edit files via Staged or KvgitFS ...
await vg.commit('feature work')
await vg.checkout('main')
const merged = await vg.merge('feature')  // returns AgentCommit | null
```

`VirtualGit` constructor:

```ts
new VirtualGit(
  vkv: Versioned,
  staged: Staged,
  opts?: { cwd?: () => string },
)
```

The optional `cwd` provider is what `registerGit` passes (`() => ctx.fs.getcwd()`) so relative paths follow the agent's `cd` state. Library callers usually want the default (`'/'`) and pass absolute paths.

### Method index

| Method | Returns |
|---|---|
| `currentBranch()` | `Promise<string>` |
| `listBranches()` | `Promise<string[]>` (sorted) |
| `head()` | `Promise<string \| null>` |
| `resolveRef(ref)` | `Promise<string>` |
| `status()` | `Promise<Status>` |
| `log({maxCount?, path?})` | `Promise<AgentCommit[]>` |
| `show(commitHash, path)` | `Promise<Uint8Array>` |
| `diff({a?, b?, path?})` | `Promise<string>` |
| `add(paths)` | `Promise<void>` |
| `rm(paths, {recursive?})` | `Promise<void>` |
| `commit(message)` | `Promise<AgentCommit>` |
| `reset(target, {hard?})` | `Promise<void>` |
| `createBranch(name)` | `Promise<void>` |
| `deleteBranch(name, {force?})` | `Promise<void>` |
| `checkout(name, {create?, force?})` | `Promise<void>` |
| `merge(source, {force?})` | `Promise<AgentCommit \| null>` |

### Errors

All operation errors derive from `AgentGitError`:

| Error | When |
|---|---|
| `BranchExists` | `createBranch` / `checkout -b` on an existing name |
| `BranchNotFound` | `deleteBranch` / `checkout` / `merge` on an unknown name |
| `BranchNotMerged` | `deleteBranch` without `force` on an unmerged branch |
| `UnbornBranch` | `createBranch` / `merge` when current has no commits |
| `PendingChanges` | `checkout` / `merge` with unsaved working-tree edits |
| `NothingToCommit` | `commit` when working tree matches HEAD |
| `PathSpecError` | `add` / `rm` on a path that doesn't exist anywhere |

Plus `InvalidRef` (from ref resolution) and `FileNotFoundError` (from `show`).

The CLI handler translates each into a `TerminalError` with a `git <subcommand>: <message>` prefix.

## Result types

```ts
interface AgentCommit {
  readonly hash: string
  readonly shortHash: string  // first 7 chars of hash
  readonly message: string
  readonly virtualBranch: string | null
  readonly virtualParents: ReadonlyArray<string>
  readonly files: ReadonlyArray<string> | null  // null when commit didn't carry the annotation
}

interface Status {
  readonly branch: string
  readonly staged: ReadonlyArray<string>    // sorted
  readonly unstaged: ReadonlyArray<string>  // sorted
  readonly isClean: boolean
}
```

Paths in `staged` / `unstaged` / `files` are user-facing (no `f:` prefix, no leading `/` — matches real git's relative-to-root display convention).

## How it's structured

Branches and commits are virtual: the agent's state lives in a metadata blob (`__agex_git__`) at a no-prefix kvgit key, while file content lives at `f:`-prefixed keys (`KvgitFS`'s scheme). A virtual `git commit` calls `staged.commit({keys: ...})` with the modified file keys plus the updated metadata blob — both land in one atomic kvgit commit. Real kvgit branches are never moved by virtual operations, so framework state (event log, REPL namespace) survives every `git checkout` / `git branch` / `git reset` untouched.

`git reset --hard <ref>` and `git checkout` rewrite the working tree by writing through `Staged` (the same `_apply_file_view` pattern agex-py uses), so the next substrate-level commit carries the change forward as a forward kvgit commit. kvgit HEAD only ever moves forward; the *virtual* branch ref in the metadata blob can rewind, but no commits are ever dropped from physical history.
