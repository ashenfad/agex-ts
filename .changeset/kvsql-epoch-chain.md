---
"@agex-ts/kvsql": patch
---

**Epochs between syncs.** `rebase` and `adopt` follow the snapshots back through any epochs between, so a copy several epochs behind moves on (its epochs before gone or not), and pushes to an epoch two back are taken in; `synced: null` says the copy synced none of its epoch, so all of it is its own. A copy moving onto an epoch taken at its own position checks the content hash again.
