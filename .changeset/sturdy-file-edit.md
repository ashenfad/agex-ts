---
"agex-ts": patch
---

`fileEdit` is more forgiving and fails more loudly. A non-`matchAll` edit now errors when the search string occurs more than once (instead of silently editing the first match), and a not-found search that differs only by typographic look-alikes (curly quotes, em-dashes) or Unicode normal form now reports the likely cause. When an exact match isn't found, two fallbacks recover the common near-misses: trailing-whitespace-flexible matching and indent-flexible matching (the replacement is re-indented to the file's baseline). Matching tolerates LF or CRLF files, and fuzzy replacements are normalized to the file's existing line endings.
