---
"@agex-ts/world": patch
---

**Dynamic imports resolve:** `await import(spec)` in code and world modules resolves as a static import does: a world path relative to the working directory or the importing module, `'host'`, a URL, or a bare name through the profile's `resolve`, instead of fetching from the page's origin.
