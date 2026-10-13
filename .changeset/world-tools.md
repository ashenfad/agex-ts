---
"@agex-ts/world": minor
---

**The tools:** `worldTools(ws)` gives `terminal`, `file_write`, `file_edit`, `view_image` and `run_ts`, with nontainer's names, schemas and result text. Results are MCP-shaped via `toMcpResult`.

**The shell:** `ws.terminal(script)` runs termish over the world's files, committed as `terminal`.
- `$NAME` expands the profile's variables.
- The profile's `commands` (a handler, or `commandFactory` for one made per world with the secrets) run beside termish's own.

**`ws.files.edit`:** nontainer's edit engine (exact, trailing-whitespace and indent-flexible matching, "already applied", "did you mean these lines?"), checked against it by golden cases.

**`curlCommand()`:** a host-granted `curl` that fills secrets into URLs and headers, refuses oversized responses, and tells a CORS refusal from a dead network.

**Code errors:** they show the code's own frames at its own line numbers, and an error from a host call points at the line that made it.
