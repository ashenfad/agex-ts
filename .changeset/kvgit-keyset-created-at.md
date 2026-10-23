---
"@agex-ts/kvgit": patch
---

**A keyset entry written before storage v4 keeps its `created_at`:** decoding dropped it, so re-encoding an untouched entry in a merge or a rewritten node gave different bytes, tree and commit hash than Python kvgit.
