# agex-git

Agent-view git over a `kvgit-ts` `Staged`. Surfaces `git status`,
`git commit -m '...'`, `git branch`, `git checkout`, `git log`,
`git diff`, `git merge` (etc.) inside the agent's `terminal_action`
sandbox — operating on VFS files, leaving the underlying kvgit
substrate (event log, REPL state, agent memory) untouched.

This package is a port of agex-py's `agent_git` onto the unified
kvgit substrate that ships with agex-ts. Branches and commits are
*virtual* — they live in a metadata blob (`__agex_git__`) at a
no-prefix kvgit key, while file content lives at the `f:` / `d:`
prefixed keys `KvgitFS` writes. A `git commit` from the agent's
perspective is a kvgit `Staged.commit()` that captures both file
content and the updated metadata blob atomically.

## Status

Functionally complete. `VirtualGit` library API + termish-ts CLI
adapter both shipped:

- **Read-only**: `currentBranch` / `listBranches` / `head` /
  `resolveRef` / `status` / `log` / `show` / `diff`
- **Working-tree**: `add` / `rm` / `commit` / `reset`
- **Branches**: `createBranch` / `deleteBranch` / `checkout` /
  `merge` (3-way "source wins" + fast-forward + already-up-to-date)
- **CLI**: `registerGit(agent)` mounts the skill at
  `/skills/git/SKILL.md` and registers `git` as a host terminal
  command — agents run `git status`, `git commit -m '...'`,
  `git log --oneline`, etc. inside `terminal_action`.

## Quick start

```ts
import { createAgent } from 'agex-ts'
import { registerGit } from 'agex-git'

const agent = await createAgent({
  name: 'my-agent',
  state: { type: 'versioned', storage: 'memory' },
  fs: { type: 'kvgit' },
  // ...
})
registerGit(agent)
```

For programmatic use (without termish), drive `VirtualGit` directly:

```ts
import { VirtualGit } from 'agex-git'

const vg = new VirtualGit(staged.versioned, staged)
await vg.commit('initial')
```

## Public surface

```ts
import {
  VirtualGit,
  Metadata,
  METADATA_KEY,
  DEFAULT_BRANCH,
  resolveRef,
  walkVirtualAncestry,
  allAncestors,
  mergeBase,
  unifiedDiff,
  isBinary,
  // Errors
  AgentGitError,
  InvalidRef,
  FileNotFoundError,
  // Result types
  type AgentCommit,
  type Status,
} from 'agex-git'
```

See agex-py's `agent_git` for the conceptual model.
