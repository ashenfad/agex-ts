# @agex-ts/termish

Pure-TypeScript shell parser + builtin commands operating over an async `FileSystem`. A port of [agex-py's `termish`](https://github.com/ashenfad/termish), redesigned around async storage so it composes with browser-side and Node-side filesystems alike.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A virtual terminal that runs inside your application. Parses shell text (`ls -la | grep .ts`), executes against a pluggable `FileSystem`, supports custom commands, and accepts literal heredocs such as `cat <<'EOF' > file`. Used by agex-ts to power agent `terminal` emissions.

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
