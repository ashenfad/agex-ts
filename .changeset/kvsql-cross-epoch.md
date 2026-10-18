---
"@agex-ts/kvsql": minor
---

**Rebase across epochs.** `rebase(undefined, { synced })` moves a database with changes of its own onto a newer epoch another device started: its changes since `synced` apply to a copy rebuilt at the epoch's tip, which replaces the file. Keeping `'mine'` starts a newer epoch from the database's own file, which also lets a rebase keep this copy's side over a schema change in the log. Opening no longer rebuilds over a file with changes the newer epoch may not hold: it stays on its own epoch (`recovery.stayed`). `adopt(tip)` takes in entries another device pushed to the old epoch while this one started the new one.
