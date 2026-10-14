---
"@agex-ts/world": patch
---

The default TypeScript transform (ts-blank-space, which brings the TypeScript compiler) loads on the first run that needs it, not when the package is imported, so a host that imports the world without running code (or with a transform of its own) doesn't load the compiler: a browser host bundling the world puts it in a chunk of its own.
