---
"@agex-ts/kvsql": minor
---

**SQLite on a file:** `openDatabase(dir, name)` opens a crash-safe database (PERSIST rollback journal) on an OPFS directory (`OpfsDirectory`, in a dedicated worker) or in memory (`MemoryDirectory`) through the package's own VFS, and `CrashingDirectory` crashes any directory at a chosen write, truncate or sync for crash tests.
