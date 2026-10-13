---
"@agex-ts/world": minor
---

**A new package: the world.** Sessions as branches of one kvgit repository, each with its files, cache and working directory, with nontainer's semantics:
- **A commit per mutating call,** with nontainer's commit info.
- **Checkout as an appended restore commit.**
- **Forks:** O(1) branches, full or fresh.
- **Tags:** per session and per store.
- **Calls that change a session run one at a time.**

`WorldFS` passes termish's filesystem conformance kit on memory and IndexedDB.
