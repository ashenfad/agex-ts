---
'agex-ts': patch
---

Resolve bare npm specifiers inside `/helpers` modules, not just action bodies. A `import { createNoise2D } from 'simplex-noise'` in a helper now routes through the host's namespace resolver (→ esm.sh in the studio), exactly like the same import in an action body. Previously the helper rewriter left unregistered bare imports untouched, so the surviving `import` statement threw the opaque "Cannot use import statement outside a module" at evaluation time — and npm packages worked in action bodies but not helpers, a surprising asymmetry.
