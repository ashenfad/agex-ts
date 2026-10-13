---
"@agex-ts/world": minor
---

**Skills:** a profile's `skills` are mounted read-only at `<root>/skills/<name>/` on every open, never committed; `skillCatalog` lists them with any the agent writes there, and `toolInstructions` (now async) carries it. A directory that holds only mount points reads as a directory.
