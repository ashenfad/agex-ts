---
"@agex-ts/kvsql": minor
---

**`transact(fn)` and procedures:** a function runs as one transaction through `tx.query`, so a write can depend on what it read, and `serve(open, { procedures })` lets clients `call(name, args)` such functions by name.
