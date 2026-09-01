---
"@agex-ts/kvgit": patch
---

Fix two defects in branch-HEAD recovery, and add `repairHead` as the explicit repair path.

`__branch_head_prev__<branch>` — the backup a damaged branch recovers *to* — was written before the CAS that moves HEAD, so it landed whether or not the swap did. A writer that lost the race left its own stale `expected` as the branch's recovery target: it clobbered the winner's backup, and where `expected` came from a corrupt-HEAD recovery rather than a real HEAD, it made a commit that was never HEAD durable, so later reads would recover the branch onto a lineage it never had. The backup is now written after the swap succeeds. It still does **not** guarantee a backup exactly one commit back — the swap and the backup write are two steps, and a crash or a lost timeslice between them lets an older writer's backup land last — but it always names a commit HEAD really held. Recovery may lose more than one commit; it cannot invent a lineage. `pullBranch`'s fast-forward had the same ordering and gets the same fix.

Head resolution no longer writes. It repaired a damaged HEAD in place on every read path — opening a handle, `peek`, `switchBranch`, `refresh`, the mark phase of a sweep — which a read-only consumer cannot do at all, and which let two readers race each other repairing the same branch to different answers. The `repair` option is gone from the internal resolver; recovery is returned to the caller and forgotten.

Two things persist a recovery instead. The new `repairHead(store, branch)` (and `vk.repairHead()`) is the explicit maintenance call: it resolves as a read would, then writes the answer back with a CAS against the damaged bytes, and returns the commit HEAD names when it returns — re-resolving if that CAS lost, so the answer describes the store rather than the attempt. And the write path heals itself: a CAS against corrupt HEAD bytes always fails, so without repair-on-read a damaged branch would be permanently unwritable. A writer that finds HEAD unresolvable now swaps in the recovered commit — again by CAS against the exact damaged bytes — and retries once. A HEAD that merely moved is left alone, and an absent HEAD is never recreated, since that is the deleted-branch resurrection `deleteBranch` drops the backup to prevent.

No API breakage: `repair` was never part of the public surface, and `repairHead` is new.

The prev-HEAD tier is also gated on `__branch_head__` existing. An absent HEAD is not damage — `deleteBranch` removes the key — so a backup that outlives its branch must not bring the branch back. Moving the backup write after the CAS opened a route to exactly that, when a writer descheduled between the two resumes after a concurrent delete and recreates only the backup. `pullBranch`'s fast-forward shares the fix.
