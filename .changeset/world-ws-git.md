---
"@agex-ts/world": minor
---

**`ws-git`, the agent's git as a terminal command.** Give `commands: {'ws-git': wsGit}` in the profile.
- **The verbs:** stage, add, unstage, commit, reset, status, diff, log, show, checkout, tag, stash, branch, merge, revert, cherry-pick, worktree, sparse-checkout and help, over `ws.index` and the merge verbs.
- **Parity:** it's a word-for-word port of nontainer's, checked against nontainer's recorded script corpus (`tests/wsgit-corpus/`, synced by `scripts/sync-corpus.mjs`), and diffs print Python difflib's hunks.

**Supporting changes:**
- **Stashes:** the index records a stash's branch.
- **Forks:** `ws.fork({at})` reads the agent's own tags.
- **Store tags** are labelled `@store/tag/<name>@<commit>` when attached or taken.
- **Messages:** the agent-git messages now match nontainer's text.
