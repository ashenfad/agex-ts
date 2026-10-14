---
"@agex-ts/world": minor
---

**Values and planes:** `Profile.values` binds data by name in code, sent with each run so every run gets a fresh copy, and a value with a live part is refused. `ws.plane(name)` keeps a harness's own records in the session under `__plane__/<name>/`, out of code's and the tools' sight, carried by commits, forks and checkouts.
