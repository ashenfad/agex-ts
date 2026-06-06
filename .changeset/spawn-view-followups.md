---
"agex-ts": patch
---

Spawn `view` ergonomics + a structured spawn index:

- **Self-announcing `view` mounts.** A clone is now told which read-only
  `view` files were mounted, in its opening task message (per-file for a
  file view; root + a count-capped shallow listing for a directory view),
  so a real model no longer has to guess to `list("/")` to find them.
- **cwd-relative `view` paths.** A relative `view` path now resolves
  against the parent session's cwd — the same way the parent's own `fs.*`
  calls resolve it — instead of always anchoring at `/`. A `view` path
  that resolves to nothing throws a clear error rather than silently
  mounting an empty overlay.
- **`EventBase.spawnIndex`.** Spawn-clone events now carry the clone's
  0-based index as a structured field, so hosts can demux concurrent
  clones without parsing it out of the `"<name>:spawn#<n>"` `agentName`.
