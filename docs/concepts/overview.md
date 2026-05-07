# Concepts

agex-ts has a small set of core ideas that make sense to read together:

- **[The Big Picture](big-picture.md)** — why agex-ts is shaped this way. The library-shape thesis, the typed-function contract, the worker-isolated runtime, and how these compare to JSON-tool frameworks and shell-based code agents.
- **[Sandboxing](sandboxing.md)** — what isolation actually means in agex-ts. Web Worker by default, the `RuntimeAdapter` contract, URL-shipped registrations, and where the trust boundary sits.
- **[State & Sessions](state-and-sessions.md)** — kvgit-backed substrate, sessions as separate `VersionedKV`s, the polymorphic encoder that puts both state and files in one atomic commit, and how rollback / branches work.
- **[Chapters](chapters.md)** — agent-directed context compaction. Boundary-based folding, `/chapters/<slug>/` browsability, nested chapters, and why this differs from generic LLM-summarization compaction.

If you'd rather see how to use the API, jump to [the API reference](../api/overview.md). For a hands-on walkthrough, start at the [quick start](../quick-start.md).
