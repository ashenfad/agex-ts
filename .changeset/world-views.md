---
"@agex-ts/world": minor
---

**Narrowed forks:** `ws.fork(name, {paths})` gives the child a view. Its branch keeps everything, but its files show only those paths and what it creates.
- **The write rule:** changing or removing a path outside the view is refused with `EACCES`.
- **The record:** the view merges as ours, and a fork given the whole tree doesn't inherit it.
- **Diffs:** `ws.diff` reports the `seed` the session was given and splits its changes into `inSeed` and `elsewhere`.

**Taking paths:** `ws.checkout(ref, {paths})` takes from any ref: another session by name, `session@commit`, or a store tag.
- **What it takes:** a named file is taken; a named directory is mirrored.
- **What it records:** `takenFrom`, the files taken, and what was removed.
- **Under a view:** the take is refused whole if any of it falls outside the view.

**Attachments:** `ws.files.attach(ref, at)` mounts another session's frozen tree read-only, for the host, the shell and code. `detach` and `attachments` manage them. Attachments aren't versioned or carried by a fork, and they close with the session.

**Ignore patterns:** `ignore` on `store.open` takes `.gitignore`-style patterns, which forks inherit.
- **What they cover:** matched paths, and anything outside the root, are left out of ws-git, diffs and merges; a merge keeps this side's copy.
- **Directory takes** skip them unless they're named.

**`ws.files.fs`** is now the composed filesystem the agent sees, with the view and attachments (typed as termish's `FileSystem`).
