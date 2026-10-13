---
"@agex-ts/world": minor
---

**Turns:** `ws.turn(runId, {resume, harness})` frames one agent run.
- **Ending:** `turn.end(status, {body, record, message})` stores the run's body in the conversation and commits what's left, stamped `{tool: 'turn', runs: {[runId]: status}}`.
- **Helpers:** `ws.runTurn(fn)` maps an error to `cancelled` or `failed`.

**The conversation** lives in the branch, under `__conversation__/`, read with `ws.conversation`. A full fork rebinds it to the child, a checkout reclaims a commit from before a fork, and a fresh fork starts without it.

**`@agex-ts/world/conformance`:** nontainer's harness corpus, bundled verbatim, with a TS port of its runner. A reference harness passes every scenario of tiers 0 to 2.
