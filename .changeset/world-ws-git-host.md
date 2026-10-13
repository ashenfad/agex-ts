---
"@agex-ts/world": minor
---

**The agent's git (`ws.index`):** nontainer's ws-git host verbs, as metadata over the session's history.
- **The index and commits:** `stage`, `unstage`, `discard`, `status`, `commit` (the staged set, or everything modified, holding exactly that), `log`, `checkout`, `resolve`, and the agent's own `tags`.
- **Untouched by framework commits:** commits the framework makes between the agent's leave its composition alone.
- **Forks:** a fork starts with a fresh state that records where it began.
- **The log:** the bookkeeping commits ws-git makes are left out of `ws.log()` unless you ask with `{kind: 'all'}`; `{kind: 'agent'}` gives the agent's commits alone.
- **Reserved tools:** `ws.commit` refuses the `ws-git` tool names.

**Merges:** `ws.merge(session)`, `ws.revert(commit)` and `ws.cherryPick('session@commit')`.
- **Engine:** they share one three-way engine on kvgit's merge and apply.
- **What they bring:** files, merged as text, with conflict markers left outstanding until resolved or `ws.index.abortMerge()`. The cache, the conversation and the agent's git stay this session's.
- **What they take:** each takes only committed work on both sides.
