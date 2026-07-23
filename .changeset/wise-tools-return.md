---
"agex-ts": patch
---

Preserve provider-assigned tool-call IDs and original arguments through
parsing, dispatch, and conversation rendering so stateful OpenAI-compatible
endpoints receive the exact call required to continue a parked tool.
