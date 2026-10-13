---
"@agex-ts/world": minor
---

**Skills:** `installSkill` writes a skill into the workspace at `<root>/skills/<name>/`, committed; a profile's `skills` are mounted read-only there on every open; `skillCatalog` lists them all, and `toolInstructions` (now async) carries it. A directory that holds only mount points reads as a directory.
