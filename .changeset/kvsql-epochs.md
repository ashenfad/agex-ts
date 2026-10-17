---
"@agex-ts/kvsql": minor
---

**Epochs:** a log on a branch named `<name>/<n>` starts its next epoch from a gzipped snapshot of the database (`newEpoch()`, or by itself once the log or one transaction is large next to the snapshot), deletes the old one, and opens on its newest epoch, rebuilding a missing or stale file from the snapshot. Breaking: the default branch is `kvsql/<id>/0`.
