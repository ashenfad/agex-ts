---
"@agex-ts/kvgit": patch
---

**Diffs and merges handle keys named like `Object.prototype` members:** a diff read a leaf's inherited members as keys, so removing a key such as `toString` threw instead of reporting it removed, and adding one such as `hasOwnProperty` went unreported.
