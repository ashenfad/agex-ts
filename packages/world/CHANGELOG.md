# @agex-ts/world

## 0.1.4

### Patch Changes

- 80df704: **A secret can be declared without a value:** `{ origins }` alone names a secret the host holds, listed and referenced as any other, and the world's own requests refuse to carry it (`DeclaredSecretError`).

## 0.1.3

### Patch Changes

- 9414881: **A browser code worker of another origin starts:** a world loaded from a CDN starts its worker through a same-origin `blob:` module that imports the script, where the browser refused the cross-origin module worker.
- adde488: **`fs.remove` in code takes `fs.rm`'s `{ recursive, force }`:** a folder goes with everything under it, and a missing path is fine with `force`, where `recursive` was ignored and a folder failed `Is a directory`; `rmdir` takes `recursive` too, and both refuse an option they don't know.
- Updated dependencies [8a29999]
- Updated dependencies [ee3020b]
- Updated dependencies [e3b247f]
- Updated dependencies [83c2b5b]
  - @agex-ts/kvgit@0.2.1

## 0.1.2

### Patch Changes

- 0e4eb83: **`fs.write` in code creates parent directories:** as `file_write` does, while a write under a file still fails `ENOTDIR` and one on a frozen workspace `EROFS`; `file_write` under a file now says `Not a directory` rather than `File exists`.
  **`fs.mkdir` takes `{ recursive: true }`:** Node's spelling, which makes missing parents and accepts an existing directory; `mkdir`, `list` and `listDetailed` refuse an option they don't know instead of ignoring it.
  **Code's filesystem errors say where a relative path went:** `No such file or directory: app/x.js (resolved to /workspace/app/systems/app/x.js; cwd /workspace/app/systems)`.
  **Tool text says a turn's calls run in order:** several `file_edit`s to one file may share a turn.
- **`ws-git add /` no longer stages the whole workspace:** a path above the root is refused like any path outside it, and on a frozen view `add -A` with nothing to stage reports the view frozen rather than succeeding.
- a586ab3: **`ws-git stage` is `ws-git add` under its own name, and a verb given arguments it doesn't take answers in one line:** `stage -A`, `stage .` and `stage <dir>` work as `add` does, and an argument error prints what was wrong, the verb's synopsis and `see 'ws-git help'` instead of the whole usage text.
- Updated dependencies [feab74b]
- Updated dependencies
  - @agex-ts/termish@0.3.2

## 0.1.1

### Patch Changes

- 1ad4048: **Dynamic imports resolve:** `await import(spec)` in code and world modules resolves as a static import does: a world path relative to the working directory or the importing module, `'host'`, a URL, or a bare name through the profile's `resolve`, instead of fetching from the page's origin.
- 347162d: **A failed terminal command's stderr appears once, as it was written:** `stderr` is empty after `2>&1`, `2>/dev/null`, `2>file` or a silent failure such as `grep` with no match (no more `grep: exited with code 1`), and reads `ls: ...` rather than `ls: ls: ...`.
- Updated dependencies [b26bbb7]
  - @agex-ts/termish@0.3.1

## 0.1.0

### Minor Changes

- a05bdb1: **An unset variable is an error:** `$NAME` with `NAME` unset stops the script with `NAME: unbound variable`, as under bash's `set -u`; `${NAME:-word}` and `${NAME-word}` give a default.
  **Brace expansion:** `{a,b}` lists and `{1..3}`, `{a..e}`, `{01..10}`, `{1..10..2}` sequences expand before variables and globs, and a brace with nothing to expand stays literal.
  **`$PWD` and `$HOME`:** `$PWD` is always the current directory, and world's terminal sets `HOME` to the session's root unless the profile does.
  **Parse errors say where:** each gives its line and column, every unsupported construct in a script is reported at once, and `$((...))` and `NAME=value` get messages of their own.
- cca0960: **The inbox:** words for an agent that is already working. `inbox.put(text)` queues a note at any moment, and a turn opened with `{inbox}` delivers it on the next tool result.

  - **Delivery:** `turn.deliver(result)` appends the queued notes behind a visible mark, framed by who is speaking: the principal the session works for, or the mechanism around the agent. `turn.opening()` opens a turn woken for what is waiting. A turn's `sources` add notes of their own at each delivery.
  - **States:** notes go from pending to delivered, then settle when the turn ends, whatever its status, or go back to the queue if its run can't be stored. `inbox.requeue()` puts a thrown-away attempt's notes back. `splitNotes` separates a result from its notes by the block's trailer.
  - **Turn events:** `Delivered` comes before the `ToolEnded` whose result carried the notes.

  **Conformance:** a harness session has an `inbox`, and may have `wake()` for woken turns. The runner delivers `queue_note` events, and the reference harness passes tiers 0 to 3.

- b2c181f: **The kernel:** `ws.runCode(code)` runs TypeScript in a worker (a browser Web Worker or Node `worker_threads`) as one call, committed as `{tool: 'run_ts'}`.

  - **What code has:** the session's files as `fs`, the cache, `env`, a captured console, and the profile's host objects.
  - **What it can import:** the world's own modules, `'host'`, URLs, and bare names through a resolver.
  - **Timeouts and interrupts:** a timeout (30 seconds by default) or `ws.interrupt()` stops a run, keeping and committing what it wrote.

  **Profiles:** granted at `store.open(id, {profile})` and inherited by forks.

  - They carry host objects, made per world with `hostFactory`, plus variables, secrets and code settings.
  - A host method declared `withCall` can change the calling workspace as part of the code's call.

- af5df2b: **`readMany`:** the world's filesystems read a batch of files at once (`WorldFS` in two of the store's reads, its records and then their contents), through views and attachments, so `grep -r` over a session no longer reads file by file.
- c2e9ed2: **A runner per call:** `runAction`, `sessionsTool` and `worldTools` take a `runner` (`ActionOptions`, `ToolOptions.runner`), which runs the delegates that call asks for over the helper's own. A tool call takes a `signal` (`CallOptions`), aborted when its turn ends: an ask that waits stops waiting (`AskOptions.signal`), and its delegate runs on. `Sessions.close()` waits on every call, a second as well as the first.
- 4d77423: **Skills:** a profile's `skills` are mounted read-only at `<root>/skills/<name>/` on every open, never committed; `skillCatalog` lists them with any the agent writes there, and `toolInstructions` (now async) carries it. A directory that holds only mount points reads as a directory.
- ef608ae: **A new package: the world.** Sessions as branches of one kvgit repository, each with its files, cache and working directory, with nontainer's semantics:

  - **A commit per mutating call,** with nontainer's commit info.
  - **Checkout as an appended restore commit.**
  - **Forks:** O(1) branches, full or fresh.
  - **Tags:** per session and per store.
  - **Calls that change a session run one at a time.**

  `WorldFS` passes termish's filesystem conformance kit on memory and IndexedDB.

- a507f31: **Stubs:** `withStub(host, source)` gives a host object a code-side half, the source of `(remote) => object` run in the worker for each run, so code can get functions, classes and errors of its own from a host object. A run's timeout now counts the code's own time: a host object's call doesn't count against it, up to `CodeSettings.hostTime` (600 seconds by default), past which the clock runs whatever is pending.
- f73fead: **The tools:** `worldTools(ws)` gives `terminal`, `file_write`, `file_edit`, `view_image` and `run_ts`, with nontainer's names, schemas and result text. Results are MCP-shaped via `toMcpResult`.

  **The shell:** `ws.terminal(script)` runs termish over the world's files, committed as `terminal`.

  - `$NAME` expands the profile's variables.
  - The profile's `commands` (a handler, or `commandFactory` for one made per world with the secrets) run beside termish's own.

  **`ws.files.edit`:** nontainer's edit engine (exact, trailing-whitespace and indent-flexible matching, "already applied", "did you mean these lines?"), checked against it by golden cases.

  **`curlCommand()`:** a host-granted `curl` that fills secrets into URLs and headers, refuses oversized responses, and tells a CORS refusal from a dead network.

  **`httpHost()`:** the same requests for code, through `http.fetch`.

  **Secrets:**

  - Code passes `secret('NAME')`, a reference that `http` fills.
  - `hostFactory` factories receive the secrets, so a host-built client can hold one.
  - A secret given as `{value, origins}` is filled only for those origins, and its requests follow no redirect.
  - A command made with `commandFactory` gets a workspace that is part of the shell call it runs in.

  **Code errors:** they show the code's own frames at its own line numbers, and an error from a host call points at the line that made it.

- 056800c: **Turns:** `ws.turn(runId, {resume, harness})` frames one agent run.

  - **Ending:** `turn.end(status, {body, record, message})` stores the run's body in the conversation and commits what's left, stamped `{tool: 'turn', runs: {[runId]: status}}`.
  - **Helpers:** `ws.runTurn(fn)` maps an error to `cancelled` or `failed`.

  **The conversation** lives in the branch, under `__conversation__/`, read with `ws.conversation`. A full fork rebinds it to the child, a checkout reclaims a commit from before a fork, and a fresh fork starts without it.

  **`@agex-ts/world/conformance`:** nontainer's harness corpus, bundled verbatim, with a TS port of its runner. A reference harness passes every scenario of tiers 0 to 2.

- 707259e: **Values and planes:** `Profile.values` binds data by name in code, sent with each run so every run gets a fresh copy, and a value with a live part is refused. `ws.plane(name)` keeps a harness's own records in the session under `__plane__/<name>/`, out of code's and the tools' sight, carried by commits, forks and checkouts.
- d54e54f: **Values:** what crosses the worker and what is stored, by value.

  - **Live parts are refused where they'd cross:** a function, a class's instance, a promise, a symbol or a getter in a host call's arguments or result fails the call, naming where (`at [0].client: a live Client`), rather than arriving changed. `findLive(value)` asks first.
  - **Stored values:** `encode` and `decode` make one blob of a value on the session's CBOR codec (`world-value/1`), and `copy` copies by the same rules. What the encoding wouldn't keep as itself is refused with `Unencodable`; the cache now refuses it too.
  - **Declared types are Standard Schemas:** `check(value, schema)` gives the validated value or throws a `Mismatch` with its path, and `jsonSchemaOf(schema)` is the library's JSON Schema.

  **`typedHost(obj, contract)`** types a host object's methods: only the contract's methods are reachable, arguments are checked on the host (a `TypeError` at the call in the code), the method gets what the schemas return, and the result is checked before it goes back.

- 992eacf: **Narrowed forks:** `ws.fork(name, {paths})` gives the child a view. Its branch keeps everything, but its files show only those paths and what it creates.

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

- 88439fe: **The agent's git (`ws.index`):** nontainer's ws-git host verbs, as metadata over the session's history.

  - **The index and commits:** `stage`, `unstage`, `discard`, `status`, `commit` (the staged set, or everything modified, holding exactly that), `log`, `checkout`, `resolve`, and the agent's own `tags`.
  - **Untouched by framework commits:** commits the framework makes between the agent's leave its composition alone.
  - **Forks:** a fork starts with a fresh state that records where it began.
  - **The log:** the bookkeeping commits ws-git makes are left out of `ws.log()` unless you ask with `{kind: 'all'}`; `{kind: 'agent'}` gives the agent's commits alone.
  - **Reserved tools:** `ws.commit` refuses the `ws-git` tool names.

  **Merges:** `ws.merge(session)`, `ws.revert(commit)` and `ws.cherryPick('session@commit')`.

  - **Engine:** they share one three-way engine on kvgit's merge and apply.
  - **What they bring:** files, merged as text, with conflict markers left outstanding until resolved or `ws.index.abortMerge()`. The cache, the conversation and the agent's git stay this session's.
  - **What they take:** each takes only committed work on both sides.

- 3f0b814: **`ws-git`, the agent's git as a terminal command.** Give `commands: {'ws-git': wsGit}` in the profile.

  - **The verbs:** stage, add, unstage, commit, reset, status, diff, log, show, checkout, tag, stash, branch, merge, revert, cherry-pick, worktree, sparse-checkout and help, over `ws.index` and the merge verbs.
  - **Parity:** it's a word-for-word port of nontainer's, checked against nontainer's recorded script corpus (`tests/wsgit-corpus/`, synced by `scripts/sync-corpus.mjs`), and diffs print Python difflib's hunks.

  **Supporting changes:**

  - **Stashes:** the index records a stash's branch.
  - **Forks:** `ws.fork({at})` reads the agent's own tags.
  - **Store tags** are labelled `@store/tag/<name>@<commit>` when attached or taken.
  - **Messages:** the agent-git messages now match nontainer's text.

### Patch Changes

- 1c9308b: **Small commands:** `date`, `seq`, `du`, `stat`, `realpath`, `paste`, `comm`, `rev`, `md5sum`/`sha256sum`, `which`, `command` and `help`, which lists every command (a host's too) and shows how one is used.
- 701d47f: **awk in the terminal's description:** the command list names it.
- 03c1930: The default TypeScript transform (ts-blank-space, which brings the TypeScript compiler) loads on the first run that needs it, not when the package is imported, so a host that imports the world without running code (or with a transform of its own) doesn't load the compiler: a browser host bundling the world puts it in a chunk of its own.
- Updated dependencies [cbaa8ea]
- Updated dependencies [6115187]
- Updated dependencies [3c938b2]
- Updated dependencies [f72a259]
- Updated dependencies [f154ccc]
- Updated dependencies [7de1515]
- Updated dependencies [36a2042]
- Updated dependencies [7ab2502]
- Updated dependencies [1494f5c]
- Updated dependencies [f65aaec]
- Updated dependencies [d7a3f69]
- Updated dependencies [62727b0]
- Updated dependencies [1cfdbf5]
- Updated dependencies [3f0b814]
- Updated dependencies [b382ec7]
- Updated dependencies [a574362]
- Updated dependencies [231a95e]
- Updated dependencies [bd9900f]
- Updated dependencies [9b4cfef]
- Updated dependencies [326eedf]
- Updated dependencies [701d47f]
- Updated dependencies [06eb396]
- Updated dependencies [992eacf]
- Updated dependencies [af5df2b]
- Updated dependencies [07ed17d]
- Updated dependencies [778df2f]
- Updated dependencies [50a53b7]
- Updated dependencies [610e7eb]
- Updated dependencies [a05bdb1]
- Updated dependencies [1c9308b]
  - @agex-ts/kvgit@0.2.0
  - @agex-ts/termish@0.3.0
