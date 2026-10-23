---
"@agex-ts/world": patch
---

**`fs.write` in code creates parent directories:** as `file_write` does, while a write under a file still fails `ENOTDIR` and one on a frozen workspace `EROFS`; `file_write` under a file now says `Not a directory` rather than `File exists`.
**`fs.mkdir` takes `{ recursive: true }`:** Node's spelling, which makes missing parents and accepts an existing directory; `mkdir`, `list` and `listDetailed` refuse an option they don't know instead of ignoring it.
**Code's filesystem errors say where a relative path went:** `No such file or directory: app/x.js (resolved to /workspace/app/systems/app/x.js; cwd /workspace/app/systems)`.
**Tool text says a turn's calls run in order:** several `file_edit`s to one file may share a turn.
