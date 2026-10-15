---
"@agex-ts/termish": minor
"@agex-ts/world": minor
---

**Breaking: an unset variable is an error:** `$NAME` with `NAME` unset stops the script with `NAME: unbound variable`, as under bash's `set -u`; `${NAME:-word}` and `${NAME-word}` give a default.
**Brace expansion:** `{a,b}` lists and `{1..3}`, `{a..e}`, `{01..10}`, `{1..10..2}` sequences expand before variables and globs, and a brace with nothing to expand stays literal.
**`$PWD` and `$HOME`:** `$PWD` is always the current directory, and world's terminal sets `HOME` to the session's root unless the profile does.
**Parse errors say where:** each gives its line and column, every unsupported construct in a script is reported at once, and `$((...))` and `NAME=value` get messages of their own.
