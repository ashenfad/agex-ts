---
"@agex-ts/kvgit": minor
---

**Delete a remote branch.** `Remote.deleteBranch` (optional; `MemoryRemote` and `PackRemote` have it) deletes a ref only at the head expected, and `deleteRemoteBranch` deletes one only if nobody pushed to it since it last synced, reporting `'moved'` otherwise.

**Syncs cost the change, not the history.** Pushes, pulls, pack fetches and folds search down by generation from both tips and stop where they meet, rather than walking the whole history below; `ancestryDelta` and `isAncestor` are exported.
