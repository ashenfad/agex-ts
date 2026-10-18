---
"@agex-ts/kvsql": minor
---

**Content hash.** `contentHash()` hashes a database's schema and rows, the same for any copy holding the same. Each snapshot records it, and a copy moving to a new epoch from the point its snapshot was taken compares its own first, refusing with `DivergedError` if they differ.
