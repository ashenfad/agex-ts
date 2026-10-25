---
"agex-ts": patch
---

**`readRuns(ws)` reads a workspace's runs without an agent:** a page restoring a chat's history reads them from the workspace alone, where it needed a session, and so a model, to call `runs()`.
