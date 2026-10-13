---
"@agex-ts/kvgit": minor
---

Garbage collection is safe beside concurrent writers, as in Python kvgit: a sweep runs under the store's GC lease, every commit batch, head, tag and synced commit lands only while no lease is live, and a commit's batch carries an in-flight marker until its head is published. `repo.gc` takes `wait` and `leaseTtl`, a busy lease throws the new `GcBusy` (`deepClean` doesn't wait), and `minAge` is policy only. `applyWire` marks the commits it writes (`inFlight` in its result) and `publishHead` moves a head and drops their markers in one write; `pullBranch` and `MemoryRemote.push` use it, so a pull's head and its backup now land together.
