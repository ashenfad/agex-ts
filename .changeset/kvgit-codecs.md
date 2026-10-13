---
"@agex-ts/kvgit": minor
---

Add `cborCodec`, the polymorphic codec: values round-trip with their JS types (objects, arrays, `Uint8Array` as byte strings, bigint, `Map`, `Set`, `Date`, typed arrays, `undefined`) in standard CBOR that Python's `cbor2` reads. `Repo.open` takes a codec or its name (`'bytes'`, `'json'`, `'cbor'`); `resolveCodec` maps a name to its codec. Depends on `cbor-x`; its optional native decoder is not built. `Repo.open` types its values by the codec (`Uint8Array` for bytes, `unknown` or the caller's type for a named JSON or CBOR codec), and the `Memory` backend now copies values in and out, so mutating an array read from or written to the store can't change a commit.
