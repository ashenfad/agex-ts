---
"@agex-ts/kvgit": patch
---

**`IndexedDB.open` adds a `storeName` the database lacks:** opening a second store in an existing database left it uncreated, so the first read or write threw `NotFoundError`; the open now bumps the database's version to create it, waiting up to the new `blockedMs` option (default 5 s) for other connections to the database to close.
