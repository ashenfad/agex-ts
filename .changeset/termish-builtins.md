---
"@agex-ts/termish": minor
---

Breaking: `grep` and `sed` read POSIX BRE unless given `-E`, and `grep` exits 1 when nothing matches (2 on an error). New builtins: `test` and `[`, and `zcat`/`gzcat`; `gzip` and `gunzip` read stdin when given no files. `xargs` and `find -exec` run their commands from argv rather than re-parsed shell text, so an argument with spaces or metacharacters arrives whole and output passes through as bytes; what those commands say on stderr is shown (a failed `-exec ... +` batch makes find exit 1), and their output keeps the caller's guards, such as `cat` refusing binary for the transcript.
