---
"@agex-ts/termish": minor
---

**Escapes:** an escaped operator, glob, quote or `#` is a literal word character, so `\;` before a pipe parses (`find ... -exec cat {} \; | wc -l`), `echo a \| b` prints `a | b`, and `echo \*` prints `*`. A quote after an even run of backslashes opens (`echo \\'$NAME'` prints `\$NAME`). **`MemoryFS`** never makes a path both a file and a directory: `mkdir -p` below a file throws `ENOTDIR`, and `rename` follows rename(2) (a file never replaces a directory nor a directory a file, a directory replaces only an empty one, and never moves into itself); `mv` says so in GNU's words. **`readMany`:** an optional `FileSystem.readMany(paths)` reads several whole files at once, keyed by the paths as given, leaving out what isn't a file; `grep` reads in batches of 256 through it, `MemoryFS` has it, and the conformance kit checks it where it's there.
