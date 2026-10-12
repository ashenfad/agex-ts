---
"@agex-ts/termish": minor
---

Breaking: unquoted words glob as bash does (segment by segment, dotfiles only for a dotted pattern, `**` across directories, a trailing `/` for directories only, `[...]` classes, matches kept relative or absolute as typed), and `glob()` follows the same rules. `ls` orders operands as GNU does: a missing one is reported (exit 2) and the rest listed, files first, then each directory under a header. Adapters throw `FsError` with POSIX codes, so diagnostics read `No such file or directory` and the like on every filesystem.
