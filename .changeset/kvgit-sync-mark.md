---
"@agex-ts/kvgit": patch
---

**A branch syncing is marked:** a push marks it before reading it, `hasSyncHead` says whether a branch has a sync head or the mark, and `deleteBranchUnlessSynced` deletes one only without either, in one step against a push taking it up. `pullBranch` no longer claims a sync head whose commit a sweep took, so a branch deleted here pulls afresh.
