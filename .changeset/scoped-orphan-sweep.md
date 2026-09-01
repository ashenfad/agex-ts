---
"@agex-ts/kvgit": patch
---

Fix a data-corruption race in `VersionedKV.cleanOrphans`, and add `deepClean` for the reclamation it can no longer do safely.

The sweep used to find orphaned HAMT nodes by scanning the whole `kvgit:keyset:` namespace for anything the mark phase hadn't reached. Because `store.keys()` is an async iterable, that scan interleaves with the event loop, so a commit landing between the `__commit_root__` scan and the node scan kept its commit metadata but lost its nodes — leaving a live branch HEAD whose keyset root was missing, and whose keys then read back as absent. No second thread or process was needed; a single JS context could hit it, and tabs sharing an IndexedDB or processes sharing a SQLite file widen the window. The same design leaked blobs permanently: once a namespace scan had deleted an orphan's nodes, no later pass could walk that orphan's keyset to find its blobs.

`cleanOrphans` now collects every deletion candidate by walking an orphaned commit's own keyset, and takes its nodes and blobs in the same walk. Blob keys are `<commitHash>:<userKey>` and HAMT leaves carry that pointer, so node hashes are commit-scoped and never dedup across unrelated commits — which means a commit that lands mid-sweep is in no orphan's tree and cannot become a candidate. The race is closed by construction: no lock, no timestamps, no storage-layout change.

What the incremental path can no longer reclaim is HAMT nodes that *no* commit points at — an interrupted write, a crash between a node write and its CAS, damage from an older sweep — since there is no orphan keyset to find them through. The new `VersionedKV.deepClean()` does that with the old full-namespace scan. It is a separate method rather than a flag because it **requires a quiescent store**: its scan runs after the mark phase and will delete artifacts written by a concurrent writer, including ones a live HEAD has since come to depend on. Use `cleanOrphans` for routine cleanup and schedule `deepClean` for maintenance windows.

No API breakage: `cleanOrphans` keeps its signature, its return value, and its `minAge` semantics.
