---
"@agex-ts/termish": patch
---

**`help sed` lists what sed supports, and sed names what it doesn't:** `{...}` blocks, `!`, hold space, `N`, branches, `-i.bak` and the like (and a pattern holding a newline, which never matches) fail with a message naming the construct and pointing at `help sed`. Only `\n` ends a line, `\0` in a replacement is the whole match, and spaces may separate an address from its command.
