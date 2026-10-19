---
"@agex-ts/kvsql": patch
---

**Older epochs that synced are kept** (and every epoch after them) until the sync deletes them, so what another device pushed to one can still be taken in after a sweep of the store; others still go at once. `onEpochsDeleted` (and a worker storage's `epochsDeleted`) hears of the epochs deleted, for scheduling that sweep.
