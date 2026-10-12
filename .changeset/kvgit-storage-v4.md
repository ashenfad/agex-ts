---
"@agex-ts/kvgit": minor
---

Breaking: storage v4, byte-compatible with Python kvgit 0.4. Blobs and HAMT nodes are keyed by content, commit hashes cover parents, keyset root, time (seconds, a float) and info, and records are JSON as Python writes it (`PyFloat` marks a float in commit info). A HEAD swap and its backup land in one atomic `casMany`, new on every backend. `WireCommit` drops `meta` and `carries` and gains `parentGens`, and the GitHub sidecar moves to format 2. `cleanOrphans` now needs a quiescent store, and `deepClean` also reclaims unreferenced blobs. Older stores are refused.
