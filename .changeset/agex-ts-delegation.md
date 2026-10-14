---
"agex-ts": minor
---

**Delegation:** `agent.session(ws, { sessions: true })` offers the world's `sessions` tool over the workspace's helper. Each delegate runs as a session of the asking agent (`Runner`) until nothing it waits on is outstanding, and answers ride the next tool result or open a woken turn. A new agent for the next turn finds the same jobs; `session.close()` waits for them.
