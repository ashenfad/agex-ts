---
"@agex-ts/world": minor
---

**The tools:** `worldTools(ws)` gives `terminal`, `file_write`, `file_edit`, `view_image` and `run_ts`, with nontainer's names, schemas and result text. Results are MCP-shaped via `toMcpResult`.

**The shell:** `ws.terminal(script)` runs termish over the world's files, committed as `terminal`.
- `$NAME` expands the profile's variables.
- The profile's `commands` (a handler, or `commandFactory` for one made per world with the secrets) run beside termish's own.

**`ws.files.edit`:** nontainer's edit engine (exact, trailing-whitespace and indent-flexible matching, "already applied", "did you mean these lines?"), checked against it by golden cases.

**`curlCommand()`:** a host-granted `curl` that fills secrets into URLs and headers, refuses oversized responses, and tells a CORS refusal from a dead network.

**`httpHost()`:** the same requests for code, through `http.fetch`.

**Secrets:**
- Code passes `secret('NAME')`, a reference that `http` fills.
- `hostFactory` factories receive the secrets, so a host-built client can hold one.
- A secret given as `{value, origins}` is filled only for those origins, and its requests follow no redirect.
- A command made with `commandFactory` gets a workspace that is part of the shell call it runs in.

**Code errors:** they show the code's own frames at its own line numbers, and an error from a host call points at the line that made it.
