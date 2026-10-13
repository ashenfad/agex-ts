---
"@agex-ts/termish": minor
---

Export the `FileSystem` conformance checks as `@agex-ts/termish/conformance`, so a host adapter can be checked without a test framework: `checkFileSystem(makeFs)` throws an `FsConformanceError` naming the first failing check, and `fsConformanceCases` lists the checks for a runner to register one by one. Ported from termish's `check_filesystem`, the checks now also cover a missing path reading false from `exists`, `isFile` and `isDir`, append creating a file, `listDetailed` paths and basenames (recursive too), `list()` and `listDetailed()` defaulting to cwd, a relative read, and `glob()` over the filesystem.
