---
"@agex-ts/kvgit": patch
---

Validate what an injected `recoverFromCorruptHead` returns, and thread the recoverer through `peek`.

The last-resort recovery tier is caller-supplied, so its answer is no more trustworthy than anything else read out of a damaged store — but it was returned unchecked, while the current-HEAD and prev-HEAD tiers both verify that what they read is a string naming a commit whose `__commit_root__` is present. A recoverer that guessed wrong therefore handed back a hash naming nothing, and `repairHead` then made it durable: obviously corrupt HEAD bytes replaced with a plausible hash pointing at no commit, which is harder to diagnose than the damage it replaced, on a store whose prev-HEAD backup is already gone by the time this tier runs. The same check now applies to the third tier, and a rejected candidate is logged with what was actually returned instead of being dropped silently. A recoverer naming a real commit is honoured exactly as before.

`peek` resolved the target branch without the handle's recoverer, so a branch that every other read path on the same handle could recover read back as absent through `peek`. It now passes it like the rest.

The orphan sweep still resolves branch HEADs without the recoverer, and that is deliberate rather than an omission: GC must not decide reachability from a guess, since a wrong answer marks the wrong commits live and walks a guessed tip as though it were the branch's own history. That is now stated at the call site and pinned by a test.

No API change: `CorruptHeadRecoverer` keeps its signature. A recoverer that was returning valid commit hashes is unaffected; one that was returning junk now leaves the branch reported unrecoverable rather than papering over it.
