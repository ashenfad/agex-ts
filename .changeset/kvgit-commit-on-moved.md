---
"@agex-ts/kvgit": minor
---

**`commit({ onMoved: 'raise' })`.** A commit whose branch moved since the worktree's head throws the new `BranchMovedError` (a `ConcurrencyError` carrying the `head` it found) instead of merging (with nothing to commit too), writes nothing and keeps the pending changes; the default, `'merge'`, is unchanged.
