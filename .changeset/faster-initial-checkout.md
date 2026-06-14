---
'@agex-ts/kvgit': patch
---

Speed up initial branch checkout over the GitHub remote. `GithubRemote.fetch` now walks the remote in `GET_CHUNK`-sized windows, fetching each window's sidecars and update blobs concurrently (bounded to `GET_CHUNK` in-flight requests) before yielding its commits in order — instead of one serial round-trip per commit gated behind the consumer's apply. A from-scratch pull of N commits costs roughly `N/GET_CHUNK` request waves rather than N back-to-back round-trips, while peak memory stays at a single window of blobs. Behavior is otherwise unchanged: full history is preserved, hashes are still verified on apply, and transport state still folds across the window seam.
