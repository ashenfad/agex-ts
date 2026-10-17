---
"@agex-ts/kvsql": minor
---

**The changeset log:** `openLog({ dir, name, repo, branch })` records each `query` or `transaction([...])` in the database file, flushes them in batches as entries on a kvgit branch, and replays the log on open, so an empty directory rebuilds the database.
