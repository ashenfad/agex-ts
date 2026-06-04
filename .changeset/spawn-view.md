---
"agex-ts": minor
---

`spawn` gains a `view` option: read-only access to part of the parent's filesystem. `spawn({ task, view: '/data' })` (or `view: ['/data', '/config']`) exposes those parent VFS paths to the clone **read-only at the same location** — the clone reads `/data/...` like the parent does, writes there throw, and everything else is its own throwaway scratch. Lets a sub-task explore real files without copying them in. Works on both runtimes (it's a host-side `MountFS` composition over the parent's backing FS; the worker bridges clone reads to it). Snapshot/frozen views remain a follow-up — `view` is a live read-only window.
