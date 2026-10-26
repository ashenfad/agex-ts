---
"@agex-ts/world": patch
---

**A secret can be declared without a value:** `{ origins }` alone names a secret the host holds, listed and referenced as any other, and the world's own requests refuse to carry it (`DeclaredSecretError`).
