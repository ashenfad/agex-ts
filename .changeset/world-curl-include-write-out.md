---
"@agex-ts/world": patch
---

**curl takes -i and -w:** `-i` prints the status line and headers before the body, and `-w` writes out `%{http_code}`, `%{content_type}`, `%{url_effective}` or `%{size_download}` after it, both scrubbed of secrets.
