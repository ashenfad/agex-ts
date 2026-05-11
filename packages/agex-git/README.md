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

Read-only operations land via `VirtualGit`: `currentBranch` /
`listBranches` / `head` / `resolveRef` / `status` / `log` / `show` /
`diff`. Mutating operations (`add` / `rm` / `commit` / `reset` /
`branch` / `checkout` / `merge`) and the termish-ts CLI adapter ship
in follow-up commits.

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
