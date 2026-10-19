# agex-ts

TypeScript agents that act by writing code and running a shell, in a
versioned world: one kvgit branch holds a session's files, cache,
working directory and conversation, so a rewind is a checkout and a
fork is O(1). The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex) and
[nontainer](https://github.com/ashenfad/nontainer), kept aligned with
them on meaning rather than bytes, and browser-native: code runs in a
Web Worker, storage is IndexedDB.

> **Status:** pre-alpha. Rebuilt in October 2026 as layers matching the
> Python side (kvgit, nontainer, agex); the packages release together.
> [`docs/design.md`](docs/design.md) has the decisions behind it, and
> why.

## Packages

| Package | Purpose |
|---|---|
| [`agex-ts`](packages/agex-ts) | The loop: sessions, typed tasks, agent-defined tasks, delegation and folding over a world, on any AI SDK model. |
| [`@agex-ts/world`](packages/world) | The world: sessions as branches, the workspace, the code kernel, the tools, the turn, the inbox, delegation, the agent's git (`ws-git`), skills, compaction's record. nontainer's semantics. |
| [`@agex-ts/kvgit`](packages/kvgit-ts) | Versioned key-value storage with branches, merges and sync; Python kvgit's v4 format, byte for byte. |
| [`@agex-ts/termish`](packages/termish-ts) | A shell interpreter over an async filesystem protocol. |
| [`@agex-ts/kvsql`](packages/kvsql) | SQLite in the browser on an OPFS file, with a kvgit changeset log for checkpoints and sync. |

## A taste

```ts
const store = await Store.open(new Memory())
const ws = await store.open('notes')
const agent = new Agent({ model: anthropic('claude-haiku-5-5') })

await agent.session(ws).say('Write a haiku about rivers to /workspace/haiku.txt')
const factor = agent.task({
  name: 'factor',
  instructions: 'Factor n into its primes, smallest first.',
  params: { n: z.number().int() },
  returns: z.array(z.number().int()),
})
await factor({ n: 391 }) // [17, 23]
```

[`packages/agex-ts`](packages/agex-ts) has the rest, and its
`examples/quickstart.mjs` runs end to end.

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
