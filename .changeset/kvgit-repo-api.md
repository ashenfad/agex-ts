---
"@agex-ts/kvgit": minor
---

Add the Python kvgit 0.4 API: `Repo` (commit records, `log`, `diff`, `mergeBase`, `gc`), `Worktree` (pending writes, merging commit), lazy `Snapshot`, and `branches` and `tags` collections, with tags stored as Python stores them. Errors derive from `KvgitError`, with new `UnknownCommitError`, `UnknownTagError`, `BranchExistsError`, `TagExistsError`, `CorruptHeadError` and `StorageVersionError`. Branch names under `refs/tags/` are refused, `resetTo` swaps HEAD and its backup in one write, and `VersionedKV` and `Staged` stay as they are.
