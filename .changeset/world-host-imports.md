---
"@agex-ts/world": patch
---

**A missing import from 'host' fails at once:** `import { cache } from 'host'` is a `SyntaxError` before the code runs, naming what `'host'` has, not an `undefined` that fails at first use.
