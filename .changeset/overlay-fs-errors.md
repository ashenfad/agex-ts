---
"agex-ts": patch
---

The read-only `/skills` and `/chapters` overlays throw `FsError` with POSIX codes (`ENOENT`, `EISDIR`, and `EROFS` for a write), so their diagnostics read as the other filesystems' do.
