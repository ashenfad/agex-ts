---
"@agex-ts/world": patch
---

**'host' gives modules `fs`, `cache` and `env`:** `import { cache } from 'host'` binds the run's own in any module, a module's `console` prints to the run's output, and a name `'host'` lacks is a `SyntaxError` before the code runs.
