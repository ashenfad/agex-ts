---
"agex-ts": minor
---

Batch truncation is now observable, and successful file ops are acknowledged. When a recoverable error truncates a multi-emission action, the trailing emissions that never ran render an explicit skip notice ("Not executed — an earlier action in this turn raised an error…") instead of "(no observation)". This also fixes a latent bug where a dropped `write_file`/`edit_file` rendered a synthesized "wrote <path>" success line, falsely reporting a call that never executed as succeeded — naming the skipped calls lets the agent re-issue only those rather than replaying the whole batch (which silently double-applies the ones that did run). Successful `write_file`/`edit_file` now emit a `✓ write_file: <path>` / `✓ edit_file: <path>` `SystemNote`, mirroring agex-py's `sync_loop`: the renderer skips `systemNote` events so the LLM's view is unchanged, but the embedder receives a discrete in-turn success signal via `onEvent`.
