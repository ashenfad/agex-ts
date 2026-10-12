# @agex-ts/termish

Pure-TypeScript shell parser + builtin commands operating over an async `FileSystem`. A port of [agex-py's `termish`](https://github.com/ashenfad/termish), redesigned around async storage so it composes with browser-side and Node-side filesystems alike.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A virtual terminal that runs inside your application. Parses shell text (`ls -la | grep .ts`), executes against a pluggable `FileSystem`, supports custom commands, and accepts literal heredocs such as `cat <<'EOF' > file`. Used by agex-ts to power agent `terminal` emissions.

## The shell

- **Pipes and redirects carry bytes**, so binary content survives
  `cat`, `head -c`, `tee`, `gzip -c` and the rest. The transcript is
  decoded as UTF-8 once, at the end.
- **stderr is real:** `2>file`, `2>>file` and `2>&1` route it, and
  `/dev/null` discards (it is never written as a file). A failure that
  execution goes on past (`cmd; next`, `cmd || fallback`) shows its
  diagnostic in the transcript, as a terminal would.
- **Exit codes:** a command's own, 127 for a command not found, and
  `$?` for the last one. `TerminalError` carries `exitCode`, `stderr`
  and the transcript so far (`partialOutput`).
- **Variables:** `$NAME`, `${NAME}` and `$?`, from the `env` passed to
  `execute` and shared with commands as `ctx.env`. Single quotes keep
  them literal; a value with spaces is never split into words.
- **Comments:** an unquoted `#` at the start of a word.
- **Refused, with advice:** loops, conditionals, `case`, function
  definitions and `$(...)` are parse errors that say what to use
  instead (xargs, `find -exec`, `&&` / `||`).

Heredoc bodies are extracted before tokenization, so quotes, pipes, redirects,
and backslashes inside them are literal. Bare, single-quoted, and double-quoted
delimiters have identical no-expansion semantics. Closing delimiters may be
indented for agent ergonomics. Here-strings (`<<<`) and tab-stripping heredocs
(`<<-`) are not supported.

## Backends shipped in v1

| Adapter | Sub-path | When to reach for it |
|---|---|---|
| `MemoryFS` | `@agex-ts/termish/fs/memory` | Tests, ephemeral use, browser-side state with no persistence |
| `RealFS` | `@agex-ts/termish/fs/real` | Hits the actual disk on Node — wraps `node:fs/promises` + tracks cwd |
| `KvgitFS` | `@agex-ts/termish/fs/kvgit` | Versioned shell sessions backed by `@agex-ts/kvgit` (peer dep) |
