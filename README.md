# agex-ts

TypeScript agents that act by writing code and running a shell, in a
versioned world: one kvgit branch holds a session's files, cache,
working directory and conversation, so a rewind is a checkout and a
fork is O(1). The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex) and
[nontainer](https://github.com/ashenfad/nontainer), kept aligned with
them on meaning rather than bytes, and browser-native: code runs in a
Web Worker, storage is IndexedDB.

> **Status:** being rebuilt on the `rebuild` branch, step by step:
> [`plan.md`](plan.md) is the plan and its decisions. The foundation is
> done (termish-ts, kvgit-ts, the world); agex-ts, the loop, is being
> rewritten over it. Nothing releases until the rebuild is done, when
> every package releases at once. `main` and the published 0.x packages
> are the previous design.

## Packages

| Package | Purpose |
|---|---|
| [`agex-ts`](packages/agex-ts) | The loop: sessions and typed tasks over a world. Being rewritten. |
| [`@agex-ts/world`](packages/world) | The world: sessions as branches, the workspace, the code kernel, the tools, the turn, the inbox, delegation, the agent's git (`ws-git`), skills, compaction's record. nontainer's semantics. |
| [`@agex-ts/kvgit`](packages/kvgit-ts) | Versioned key-value storage with branches, merges and sync; Python kvgit's v4 format, byte for byte. |
| [`@agex-ts/termish`](packages/termish-ts) | A shell interpreter over an async filesystem protocol. |

## Working from a clone

The packages' `dist/` directories are gitignored, and packages test
against each other's builds, so build once after a fresh clone:

```bash
pnpm install
pnpm -r build
pnpm test
```

## Contributing

Bug reports, ideas, and pull requests welcome: see
[GitHub Issues](https://github.com/ashenfad/agex-ts/issues).
