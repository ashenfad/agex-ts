---
"@agex-ts/kvgit": patch
---

**Keys named like `Object.prototype` members work.** A `get` of an absent key such as `toString` or `constructor` returned the inherited member instead of nothing, and a key named `__proto__` could be dropped when a leaf was split or merged.
