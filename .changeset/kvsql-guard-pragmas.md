---
"@agex-ts/kvsql": patch
---

**The guard refuses setting `recursive_triggers` and `case_sensitive_like`,** which change what statements do on one connection only.
