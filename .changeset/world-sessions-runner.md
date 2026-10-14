---
"@agex-ts/world": minor
---

**A runner per call:** `runAction`, `sessionsTool` and `worldTools` take a `runner` (`ActionOptions`, `ToolOptions.runner`), which runs the delegates that call asks for over the helper's own. A tool call takes a `signal` (`CallOptions`), aborted when its turn ends: an ask that waits stops waiting (`AskOptions.signal`), and its delegate runs on. `Sessions.close()` waits on every call, a second as well as the first.
