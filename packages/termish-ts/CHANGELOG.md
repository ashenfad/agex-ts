# @agex-ts/termish

## 0.3.1

### Patch Changes

- b26bbb7: **A failed command's name appears once, and `TerminalError.displayStderr` says what reached the screen:** a stderr that already starts with the command's name (`ls: cannot access ...`) is no longer prefixed again, and `displayStderr` is `''` for a silent or redirected failure; `xargs` also keeps its earlier runs' warnings when a later run fails.

## 0.3.0

### Minor Changes

- 326eedf: Breaking: Node 22 or later is required (Node 20 is past its end of life, and the AI SDK's packages need 22).
- 701d47f: **awk:** a new builtin running a bounded awk (patterns, fields, arrays, `printf`, `sub`/`gsub`/`split`/`match` and the usual builtins); `getline`, `system()`, `rand()`, user-defined functions and pipes in `print` are refused by name.
- 06eb396: Breaking: `grep` and `sed` read POSIX BRE unless given `-E`, and `grep` exits 1 when nothing matches (2 on an error). New builtins: `test` and `[`, and `zcat`/`gzcat`; `gzip` and `gunzip` read stdin when given no files. `xargs` and `find -exec` run their commands from argv rather than re-parsed shell text, so an argument with spaces or metacharacters arrives whole and output passes through as bytes; what those commands say on stderr is shown (a failed `-exec ... +` batch makes find exit 1), and their output keeps the caller's guards, such as `cat` refusing binary for the transcript.
- 992eacf: **`EACCES`:** a new `FsErrorCode` ("Permission denied"), for a filesystem that refuses a path rather than lacking it.
- af5df2b: **Escapes:** an escaped operator, glob, quote or `#` is a literal word character, so `\;` before a pipe parses (`find ... -exec cat {} \; | wc -l`), `echo a \| b` prints `a | b`, and `echo \*` prints `*`. A quote after an even run of backslashes opens (`echo \\'$NAME'` prints `\$NAME`). **`MemoryFS`** never makes a path both a file and a directory: `mkdir -p` below a file throws `ENOTDIR`, and `rename` follows rename(2) (a file never replaces a directory nor a directory a file, a directory replaces only an empty one, and never moves into itself); `mv` says so in GNU's words. **`readMany`:** an optional `FileSystem.readMany(paths)` reads several whole files at once, keyed by the paths as given, leaving out what isn't a file; `grep` reads in batches of 256 through it, `MemoryFS` has it, and the conformance kit checks it where it's there.
- 07ed17d: Export the `FileSystem` conformance checks as `@agex-ts/termish/conformance`, so a host adapter can be checked without a test framework: `checkFileSystem(makeFs)` throws an `FsConformanceError` naming the first failing check, and `fsConformanceCases` lists the checks for a runner to register one by one. Ported from termish's `check_filesystem`, the checks now also cover a missing path reading false from `exists`, `isFile` and `isDir`, append creating a file, `listDetailed` paths and basenames (recursive too), `list()` and `listDetailed()` defaulting to cwd, a relative read, and `glob()` over the filesystem.
- 778df2f: Breaking: unquoted words glob as bash does (segment by segment, dotfiles only for a dotted pattern, `**` across directories, a trailing `/` for directories only, `[...]` classes, matches kept relative or absolute as typed), and `glob()` follows the same rules. `ls` orders operands as GNU does: a missing one is reported (exit 2) and the rest listed, files first, then each directory under a header. Adapters throw `FsError` with POSIX codes, so diagnostics read `No such file or directory` and the like on every filesystem.
- 610e7eb: Breaking: pipes and redirects carry bytes. `ctx.stdin` is an object (`text()`, `bytes`), and `ctx.stdout` gains `writeBytes`. `TerminalError` takes an options object and carries `exitCode` and `stderr`. stderr redirects (`2>`, `2>>`, `2>&1`) are real, `/dev/null` discards, a failure execution continues past shows its diagnostic, a missing command exits 127, and `$NAME`, `${NAME}` and `$?` expand from the new `env` option. Comments are supported, and control flow, function definitions and `$(...)` are refused with advice. Ported from termish 0.2.2's interpreter core.
- a05bdb1: **Breaking: an unset variable is an error:** `$NAME` with `NAME` unset stops the script with `NAME: unbound variable`, as under bash's `set -u`; `${NAME:-word}` and `${NAME-word}` give a default.
  **Brace expansion:** `{a,b}` lists and `{1..3}`, `{a..e}`, `{01..10}`, `{1..10..2}` sequences expand before variables and globs, and a brace with nothing to expand stays literal.
  **`$PWD` and `$HOME`:** `$PWD` is always the current directory, and world's terminal sets `HOME` to the session's root unless the profile does.
  **Parse errors say where:** each gives its line and column, every unsupported construct in a script is reported at once, and `$((...))` and `NAME=value` get messages of their own.
- 1c9308b: **Small commands:** `date`, `seq`, `du`, `stat`, `realpath`, `paste`, `comm`, `rev`, `md5sum`/`sha256sum`, `which`, `command` and `help`, which lists every command (a host's too) and shows how one is used.

### Patch Changes

- 50a53b7: **`&` and `<<-` are refused, with advice:** a background job (or bash's `&>`) no longer runs with `&` as a literal argument, and a tab-stripping heredoc no longer fails as an unterminated `-EOF`. The refusals' advice says "compute it in code" rather than naming a host's tool, and `help` describes `awk`.

## 0.2.0

### Minor Changes

- fe74fd6: Support literal heredocs in parsed and executed terminal commands, including
  quoted delimiters, pipelines, multiple bodies, and multiline VFS writes through
  output redirection.
