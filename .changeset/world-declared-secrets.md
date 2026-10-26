---
"@agex-ts/world": patch
---

**A secret can be declared without a value:** `{ origins }` alone names a secret the host holds elsewhere, listed and referenced as any other, while `curl`, `httpHost()` and `request()` refuse a request carrying it and `secrets.get` throws `DeclaredSecretError`, so only a host object that forwards the request can have it filled.
