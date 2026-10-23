---
"@agex-ts/world": patch
---

**`ws-git stage` is `ws-git add` under its own name, and a verb given arguments it doesn't take answers in one line:** `stage -A`, `stage .` and `stage <dir>` work as `add` does, and an argument error prints what was wrong, the verb's synopsis and `see 'ws-git help'` instead of the whole usage text.
