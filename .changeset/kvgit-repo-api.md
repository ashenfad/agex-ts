---
"@agex-ts/kvgit": minor
---

Add the Python kvgit 0.4 API: `Repo` (commit records, `log`, `diff`, `mergeBase`, `gc`), `Worktree` (pending writes, merging commit), lazy `Snapshot`, and `branches` and `tags` collections, with tags stored as Python stores them. Errors derive from `KvgitError`, with new `UnknownCommitError`, `UnknownTagError`, `BranchExistsError`, `TagExistsError`, `CorruptHeadError` and `StorageVersionError`. Empty branch names and names under `refs/tags/` are refused, deleting a branch or tag is conditional on the head it read (a `ConcurrencyError` if it changed), `resetTo` swaps HEAD and its backup in one write, and `VersionedKV` and `Staged` stay as they are.
