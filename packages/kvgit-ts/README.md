# kvgit-ts

Versioned key-value store with branches, commits, and three-way merges. A TypeScript port of [agex-py's kvgit](https://github.com/ashenfad/kvgit), redesigned around async storage so it works equally well in Node and the browser.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A `Map<string, T>` with git-like history. Every `commit()` creates a checkpoint; branches are first-class; sessions can fork cheaply because the underlying HAMT shares structure across versions. Three-way merges are pluggable per key.

## Design

See [`design.md` §6](../../design.md) and [`implementation.md`](../../implementation.md) at the repo root for scope, decisions, and lessons.

The canonical type contracts live in [`src/types.ts`](./src/types.ts).
