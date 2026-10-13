---
"@agex-ts/world": minor
---

**Values:** what crosses the worker and what is stored, by value.
- **Live parts are refused where they'd cross:** a function, a class's instance, a promise, a symbol or a getter in a host call's arguments or result fails the call, naming where (`at [0].client: a live Client`), rather than arriving changed. `findLive(value)` asks first.
- **Stored values:** `encode` and `decode` make one blob of a value on the session's CBOR codec (`world-value/1`), and `copy` copies by the same rules. What the encoding wouldn't keep as itself is refused with `Unencodable`; the cache now refuses it too.
- **Declared types are Standard Schemas:** `check(value, schema)` gives the validated value or throws a `Mismatch` with its path, and `jsonSchemaOf(schema)` is the library's JSON Schema.

**`typedHost(obj, contract)`** types a host object's methods: only the contract's methods are reachable, arguments are checked on the host (a `TypeError` at the call in the code), the method gets what the schemas return, and the result is checked before it goes back.
