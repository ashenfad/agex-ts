---
"agex-ts": minor
---

Breaking: a command registered with `agent.terminal()` reads its input as `ctx.stdin.text()` or `ctx.stdin.bytes`, writes with `ctx.stdout.write(text)` or `ctx.stdout.writeBytes(data)`, and shares the shell's variables as `ctx.env`, matching @agex-ts/termish.
