---
"@agex-ts/kvgit": minor
---

Add `cborCodec`, the polymorphic codec: values round-trip with their JS types (objects, arrays, `Uint8Array` as byte strings, bigint, `Map`, `Set`, `Date`, typed arrays, `undefined`) in standard CBOR that Python's `cbor2` reads. `Repo.open` takes a codec or its name (`'bytes'`, `'json'`, `'cbor'`); `resolveCodec` maps a name to its codec. Depends on `cbor-x`; its optional native decoder is not built.
