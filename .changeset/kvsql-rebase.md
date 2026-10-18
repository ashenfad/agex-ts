---
"@agex-ts/kvsql": minor
---

**Rebase.** `rebase(onto?, { keep? })` (on the database and its client) moves this copy's own changes, pending and unsynced, after entries another copy wrote, renumbered after them, in one file transaction. A conflict or a schema change on either side changes nothing; `keep: 'mine' | 'theirs'` settles it, the other side kept as a checkpoint. Opening and flushing rebase pending transactions onto a moved branch by themselves, and `RebaseRequiredError` now means they conflict (with `conflicts` and `schemaChange`).
