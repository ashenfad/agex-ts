---
"@agex-ts/termish": patch
---

**A failed command's name appears once, and `TerminalError.displayStderr` says what reached the screen:** a stderr that already starts with the command's name (`ls: cannot access ...`) is no longer prefixed again, and `displayStderr` is `''` for a silent or redirected failure; `xargs` also keeps its earlier runs' warnings when a later run fails.
