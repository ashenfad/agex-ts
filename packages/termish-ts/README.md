# termish-ts

Pure-TypeScript shell parser + builtin commands operating over an async `FileSystem`. A port of [agex-py's `termish`](https://github.com/ashenfad/termish), redesigned around async storage so it composes with browser-side and Node-side filesystems alike.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A virtual terminal that runs inside your application. Parses shell text (`ls -la | grep .ts`), executes against a pluggable `FileSystem`, supports custom commands. Used by agex-ts to power agent `terminal` emissions.

## Design

See [`design.md`](../../design.md) and the `termish-ts` section of [`implementation.md`](../../implementation.md) at the repo root for scope, decisions, and lessons.

## Backends shipped in v1

| Adapter | Sub-path | When to reach for it |
|---|---|---|
| `MemoryFS` | `termish-ts/fs/memory` | Tests, ephemeral use, browser-side state with no persistence |
| `RealFS` | `termish-ts/fs/real` | Hits the actual disk on Node — wraps `node:fs/promises` + tracks cwd |
| `KvgitFS` | `termish-ts/fs/kvgit` | Versioned shell sessions backed by `kvgit-ts` (peer dep) |
