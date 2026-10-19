---
"@agex-ts/kvsql": patch
---

**Free pages given back.** A new database file is in incremental auto-vacuum mode, and `reclaimPages` shrinks it once its free pages are 1 MiB and a quarter of it; a logged database does so after each flush and new epoch (which drop a transaction's pending copy) and at open. Files in another mode keep it.
