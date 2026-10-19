---
"@agex-ts/termish": patch
---

**`&` and `<<-` are refused, with advice:** a background job (or bash's `&>`) no longer runs with `&` as a literal argument, and a tab-stripping heredoc no longer fails as an unterminated `-EOF`. The refusals' advice says "compute it in code" rather than naming a host's tool, and `help` describes `awk`.
