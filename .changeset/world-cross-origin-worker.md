---
"@agex-ts/world": patch
---

**A browser code worker of another origin starts:** a world loaded from a CDN starts its worker through a same-origin `blob:` module that imports the script, where the browser refused the cross-origin module worker.
