---
"@agex-ts/kvgit": minor
---

Breaking: sessions sync over GitHub as one pack per push. `PackRemote` (in `@agex-ts/kvgit/github`) lands each push as one gzip-CBOR pack with one GraphQL `createCommitOnBranch`, its expected head the compare-and-swap; a pull reads only the packs the receiver lacks, by blob SHA; `roster()` lists every session, live and archived, with its head and metadata in one query; archive, restore and emptying the trash are one atomic `updateRefs` each; older packs fold into one past `maxPacks`, and `repack` folds them all. The format is specified in the README. `GithubRemote`, its sidecars and the Git Data methods of `GithubClient` are removed: it could not pull a world session, since the contents API alters values it takes for text. `GithubClient` gains `graphql` and `getBlobRaw`.
