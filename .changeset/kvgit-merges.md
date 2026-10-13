---
"@agex-ts/kvgit": minor
---

Add Python kvgit 0.4's merges: `Worktree.merge` (fast-forward by default, `fastForward: false` for a merge commit, a no-op for a commit already contained), `apply`, `cherryPick` and `revert`, with `postCheck`. Merge rules may be a `MergeChoice` (a standing policy for one side) as well as a function, which may itself answer with a `MergeChoice`, and may be registered by key prefix. The common ancestor is found by generation, falling back to a full walk. Breaking: `onConflict: 'skip'` is now `'abandon'`, `resolveMerge` takes each side's changes and returns changes to ours, a commit that fast-forwards reports no carried keys, and `mergeHeads` fast-forwards when it can. Merge results match Python's byte for byte.
