---
"@agex-ts/kvgit": patch
---

**`keys(prefix)` and `items(prefix)` find every key under the prefix on SQLite and IndexedDB:** the scan stopped at the prefix plus U+FFFF, so SQLite missed keys with a character outside the BMP after the prefix (an emoji, say), and both missed keys with U+FFFF there; the scan now runs up to the least string past the prefix, and is open above when there is none.
