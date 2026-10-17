---
"@agex-ts/kvsql": minor
---

**The worker host:** `serve` (or the default worker, `@agex-ts/kvsql/worker`) runs databases in a dedicated worker and `connect` (`@agex-ts/kvsql/client`) calls them from the page, with one writer across tabs by Web Lock, takeover when it goes away, and `ConnectionLostError` for a request lost with it.
