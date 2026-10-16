---
"@agex-ts/kvgit": patch
---

**Values are stored at their own size:** the IndexedDB backend copies a view out of its larger buffer before storing it, `cborCodec.encode` returns an exact buffer rather than a view into cbor-x's scratch, and `Memory` copies Node `Buffer`s out instead of keeping a view, so a browser store no longer takes about four times its size on disk.
