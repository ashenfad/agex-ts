---
"@agex-ts/kvgit": minor
---

**Lazy worktrees.** `repo.worktree(name, { lazy: true })` opens without loading the commit's keyset and reads it on demand through a bounded node cache, so opening a branch of a million keys takes under a millisecond instead of seconds, and holds no memory for keys it hasn't read. Commits write the same tree as an eager worktree.
