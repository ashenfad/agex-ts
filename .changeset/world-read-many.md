---
"@agex-ts/world": minor
---

**`readMany`:** the world's filesystems read a batch of files at once (`WorldFS` in two of the store's reads, its records and then their contents), through views and attachments, so `grep -r` over a session no longer reads file by file.
