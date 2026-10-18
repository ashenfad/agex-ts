---
"@agex-ts/kvgit": patch
---

**`IndexedDB.deleteDatabase` waits out a closing connection:** it no longer rejects on the first `blocked` event, which IndexedDB fires even for a connection closed just before while its last transaction finishes; a connection still open after `blockedMs` (default 5 s) rejects as before.
