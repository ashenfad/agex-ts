---
"@agex-ts/kvsql": minor
---

**Checkpoints and restore:** `checkpoint(label)` names the log's position with a kvgit tag, the database takes one itself before each schema change (keeping the last 10), and `restore(id)` brings the database back to one by moving the log forward: one transaction undoing the changes since, or, across a schema change or epochs, a new epoch from the database rebuilt at the checkpoint. Database names ending in `-restore` are now refused.
