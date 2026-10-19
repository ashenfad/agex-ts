# @agex-ts/termish

Pure-TypeScript shell parser + builtin commands operating over an async `FileSystem`. The TypeScript counterpart of Python's [`termish`](https://github.com/ashenfad/termish), redesigned around async storage so it composes with browser-side and Node-side filesystems alike.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

## Concept

A virtual terminal that runs inside your application. Parses shell text (`ls -la | grep .ts`), executes against a pluggable `FileSystem`, supports custom commands, and accepts literal heredocs such as `cat <<'EOF' > file`. `@agex-ts/world` runs it as an agent's `terminal` tool.

```ts
import { execute } from '@agex-ts/termish'
import { MemoryFS } from '@agex-ts/termish/fs/memory'

const fs = new MemoryFS()
await execute("mkdir -p /notes && echo hello > /notes/a.txt", fs)
await execute('cat /notes/*.txt | wc -l', fs, {
  env: { HOME: '/notes' },
  maxOutputChars: 20_000, // bound what reaches a model
}) // '1\n'
```

`execute(text, fs, options?)` parses and runs a script and resolves to
its transcript; it throws `ParseError` for a script it won't run, and
`TerminalError` (`exitCode`, `stderr`, `partialOutput`) when the last
pipeline fails. `toScript` and `executeScript` split the two steps.
The options:

- **`commands`:** your own commands, a `Map` or an object of handlers,
  overriding builtins of the same name.
- **`env`:** the variables `$NAME` expands from, shared with commands as
  `ctx.env` (a change a command makes is visible after).
- **`signal`:** an `AbortSignal`; an aborted script exits 130.
- **`maxOutputChars`:** caps the transcript (and a `TerminalError`'s
  `partialOutput`), ending it with a marker that says how much was cut
  and how to read the rest.

### Your own commands

A command is an async handler of a `CommandContext`: `args` (without
the command's name), `stdin` (`bytes`, or `text()`), `stdout` (`write`
text, `writeBytes`), the `fs`, `env`, `signal`, the `commands` in
effect (for a command that runs others), and `agentSink` (whether its
output reaches the caller rather than a pipe or a file). It resolves to
nothing for success, or to `{ exitCode, stderr }`; throwing
`TerminalError` stops the script. A `description` string on the handler
is what `help` shows for it.

```ts
const greet = Object.assign(
  async ({ args, stdout }: CommandContext) => stdout.write(`hello ${args[0] ?? 'world'}\n`),
  { description: 'greet someone' },
)
await execute('greet you | tr a-z A-Z', fs, { commands: { greet } })
```

### The builtins

- **Files and paths:** `pwd`, `cd`, `ls`, `mkdir`, `touch`, `cp`, `mv`,
  `rm`, `basename`, `dirname`, `realpath`, `stat`, `du`, `file`
- **Output:** `echo`, `printf`, `cat`, `head`, `tail`, `tee`
- **Text:** `wc`, `sort`, `uniq`, `cut`, `tr`, `grep`, `sed`, `awk`,
  `diff`, `paste`, `comm`, `rev`, `find`, `xargs`
- **Archives:** `gzip`, `gunzip`, `zcat`, `gzcat`, `tar`, `zip`, `unzip`
- **Checksums, numbers and time:** `md5sum`, `sha256sum`, `seq`, `date`
- **The shell:** `help`, `which`, `command`, `test`, `[`, `true`, `false`

No `jq`, `ln`, `rmdir` or `mktemp`; `help` lists what a script can run,
a host's own commands included.

## The shell

- **Pipes and redirects carry bytes**, so binary content survives
  `cat`, `head -c`, `tee`, `gzip -c` and the rest. The transcript is
  decoded as UTF-8 once, at the end.
- **stderr is real:** `2>file`, `2>>file` and `2>&1` route it, and
  `/dev/null` discards (it is never written as a file). A failure that
  execution goes on past (`cmd; next`, `cmd || fallback`) shows its
  diagnostic in the transcript, as a terminal would.
- **Exit codes:** a command's own, 127 for a command not found, and
  `$?` for the last one. `TerminalError` carries `exitCode`, `stderr`
  and the transcript so far (`partialOutput`).
- **Variables:** `$NAME`, `${NAME}` and `$?`, from the `env` passed to
  `execute` and shared with commands as `ctx.env`. Single quotes keep
  them literal; a value with spaces is never split into words. An unset
  variable stops the script (`NAME: unbound variable`), as under bash's
  `set -u`; `${NAME:-word}` and `${NAME-word}` give a default. `$PWD` is
  the current directory; a host should pass `HOME`.
- **Braces:** `{a,b}` lists and `{1..3}`, `{a..e}`, `{01..10}`,
  `{1..10..2}` sequences expand before variables and globs; a brace
  with nothing to expand (`{}`, `{x}`) stays literal.
- **Globbing as bash does it:** `*`, `?` and `[...]` match within one
  path segment, dotfiles only for a pattern starting with a dot, `**`
  across directories, a trailing `/` for directories only. Matches
  keep the word's form (relative or absolute), and a word that matches
  nothing stays as typed. `ls` orders its operands as GNU does.
- **Comments:** an unquoted `#` at the start of a word.
- **Conditionals:** `test` and `[` (file, string and integer tests,
  `!`, `-a`, `-o`, parentheses), for branching with `&&` and `||`.
- **What's here:** `help` lists every command, a host's own included
  (one describes itself with a `description` string on its handler),
  and `help NAME` shows how one is used; `which` and `command -v` say
  whether a command exists.
- **GNU regexes:** `grep` and `sed` read POSIX BRE (`\+`, `\{n\}`,
  `\(...\)`, `\|`) unless given `-E`; `grep` exits 1 when nothing
  matches and 2 on an error.
- **Refused, with advice:** loops, conditionals, `case`, function
  definitions, variable assignment, `$(...)` and `$((...))` are parse
  errors that say where they are (line and column) and what to use
  instead (xargs, `find -exec`, `&&` / `||`). Every one in a script is
  reported at once, and nothing runs.

Heredoc bodies are extracted before tokenization, so quotes, pipes, redirects,
and backslashes inside them are literal. Bare, single-quoted, and double-quoted
delimiters have identical no-expansion semantics. Closing delimiters may be
indented for agent ergonomics. Here-strings (`<<<`) and tab-stripping heredocs
(`<<-`) are not supported.

## Filesystems

A `FileSystem` (the protocol, from the main entry or
`@agex-ts/termish/fs/protocol`) is async and keeps its own cwd; its
`readMany` and `isSymlink` are optional. Every adapter throws `FsError`
with a POSIX code (`ENOENT`, `EISDIR`, `ENOTDIR`, `EEXIST`,
`ENOTEMPTY`, `EINVAL`, `EROFS`, `EACCES`), so builtins report the
standard text (`cat: /x: No such file or directory`) whatever the
filesystem. A host adapter should do the same; `describeFsError` also
maps Node's codes.

| Adapter | Sub-path | When to reach for it |
|---|---|---|
| `MemoryFS` | `@agex-ts/termish/fs/memory` | Tests, ephemeral use, browser-side state with no persistence |
| `RealFS` | `@agex-ts/termish/fs/real` | Node only: `new RealFS({ root })` makes an absolute, existing host directory the virtual `/`, and refuses paths that would leave it |
| `KvgitFS` | `@agex-ts/termish/fs/kvgit` | Files in a `@agex-ts/kvgit` `Staged` (`new KvgitFS(staged, { cwd? })`, its values encoded with `fileRecordEncoder`/`fileRecordDecoder`, or the `polymorphic*` pair to keep other values beside them); `.staged` to commit. Install `@agex-ts/kvgit` beside it |

`@agex-ts/termish/glob` has the glob matching the shell uses (`glob`,
`globMatch`, `compileGlob`, `hasGlobChars`), also on the main entry.

## Checking your own adapter

`@agex-ts/termish/conformance` holds the checks the shipped adapters pass, with
no test framework behind them. Hand `checkFileSystem` a factory that returns a
fresh, empty filesystem with its cwd at `/`; it runs every check, each against
a new filesystem, and throws an `FsConformanceError` on the first failure,
naming the check, the method and what was expected:

```ts
import { checkFileSystem } from '@agex-ts/termish/conformance'

await checkFileSystem(() => new MyFS())
```

To see each check as its own test, register `fsConformanceCases` with your
runner instead. Each case has a `group`, a `name` and `run(fs)`:

```ts
import { fsConformanceCases } from '@agex-ts/termish/conformance'
import { describe, it } from 'vitest'

describe('MyFS conformance', () => {
  for (const c of fsConformanceCases) {
    it(`${c.group} > ${c.name}`, async () => c.run(new MyFS()))
  }
})
```
