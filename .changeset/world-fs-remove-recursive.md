---
"@agex-ts/world": patch
---

**`fs.remove` in code takes `fs.rm`'s `{ recursive, force }`:** a folder goes with everything under it, and a missing path is fine with `force`, where `recursive` was ignored and a folder failed `Is a directory`; `rmdir` takes `recursive` too, and both refuse an option they don't know.
