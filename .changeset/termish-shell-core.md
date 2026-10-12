---
"@agex-ts/termish": minor
---

Breaking: pipes and redirects carry bytes. `ctx.stdin` is an object (`text()`, `bytes`), and `ctx.stdout` gains `writeBytes`. `TerminalError` takes an options object and carries `exitCode` and `stderr`. stderr redirects (`2>`, `2>>`, `2>&1`) are real, `/dev/null` discards, a failure execution continues past shows its diagnostic, a missing command exits 127, and `$NAME`, `${NAME}` and `$?` expand from the new `env` option. Comments are supported, and control flow, function definitions and `$(...)` are refused with advice. Ported from termish 0.2.2's interpreter core.
