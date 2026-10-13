---
"@agex-ts/kvgit": minor
---

The GitHub transport sends each value once. Sidecars record each changed value's hash; a push references a value the repo already holds (a rename, a copy, a revert, or what a merge took from another branch) by its git SHA instead of uploading it, falling back to the bytes if the repo has collected that blob; and a fetch reads values the local store already holds, and downloads a value several fetched commits share once. A local index remembers every value pushed or fetched, so a value restored after it left every branch's tree is referenced too.
