---
"@agex-ts/world": patch
---

**A failed terminal command's stderr appears once, as it was written:** `stderr` is empty after `2>&1`, `2>/dev/null`, `2>file` or a silent failure such as `grep` with no match (no more `grep: exited with code 1`), and reads `ls: ...` rather than `ls: ls: ...`.
