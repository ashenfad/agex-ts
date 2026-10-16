---
"@agex-ts/kvgit": patch
---

**A commit costs what it changes.** A handle updates its in-memory keyset in place instead of copying it, so a one-key commit on 100,000 keys takes 0.2 ms rather than 27.

**A commit that fails partway leaves the handle as it found it.** An error after a lost race, such as a failed landing write or store read, used to leave the handle on the unpublished commit.

**A handle's commits, merges and refreshes run one at a time.** Concurrent calls on one `VersionedKV` used to interleave and corrupt its in-memory state.
