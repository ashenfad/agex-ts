---
"@agex-ts/kvgit": patch
---

Deleting a tag is also conditional on its `__tag_info__` record, so a stale delete can't remove a tag deleted and made again at the same commit (the new record carries the time it landed). A branch made again at the same commit stays indistinguishable to a stale delete, as with git, and is now documented.
