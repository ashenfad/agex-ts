# @agex-ts/world

A versioned world for agents: every session a branch of one
[kvgit](../kvgit-ts) repository, holding its files, its cache and its
working directory, with the history of all three. The TypeScript
counterpart of [nontainer](https://github.com/ashenfad/nontainer)'s
store and workspace, with the same semantics and its own storage
layout.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor
> version. [`agex-ts`](../agex-ts) is the loop built on it.

## Use

```ts
import { Store } from '@agex-ts/world'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'

const store = await Store.open(await IndexedDB.open({ dbName: 'world' }))
const ws = await store.open('alice') // created if new, at /workspace

await ws.files.write('notes/todo.md', '- write the tests\n') // one commit
await ws.tags.add('v1')

const draft = await ws.fork('alice-draft') // O(1): a new branch
await draft.files.write('notes/todo.md', '- done\n')

await ws.files.write('notes/todo.md', '- skip the tests\n')
await ws.checkout('v1') // a new commit restoring v1; history is kept
await ws.close() // stops its code worker: a Node process waits on it
```

## Concepts

- **A store** is one kvgit repository on any `KVStore` (memory,
  IndexedDB, SQLite). Each session is a branch named by its id, and
  exists exactly when its branch does. `store.sessions()`, `exists`,
  `delete` (with its tags, then garbage collection), `clean`, `fork`,
  and `resolve('session@ref')` for a frozen view.
- **A workspace** is one session, opened with `store.open(id)`. A new
  session starts with its root directory (`/workspace` by default) and
  its working directory there, committed as `{tool: 'init'}`.
- **Files:** `ws.files.read` (a range with `{ offset, size }`),
  `readText`, `exists` and `list` read; `write` (creating
  directories), `edit` (below) and `remove` each commit (`file_write`,
  `file_edit`, `file_remove`). `ws.files.fs` is the whole
  filesystem, termish's `FileSystem`, for a shell or a kernel: its
  writes stay pending until something commits, and its `chdir` is
  stored with the session.
- **The cache:** `ws.cache` holds named values (anything CBOR holds:
  JSON data, bytes, typed arrays, `Map`, `Set`, `Date`, bigints),
  versioned with the files and left out of file diffs.
- **Commits:** with `autocommit` on (the default) every call that
  changes the session commits. Otherwise `ws.commit(info)` does.
  `ws.log()`, `ws.diff(a, b)`, `ws.discard()`, `ws.refresh()`.
- **Checkout** restores the whole session (files, cache, working
  directory) as a new commit `{tool: 'checkout', target}`; the commits
  after the target stay in the log. With `paths`, it takes just those
  files from the target. Nothing differing, it commits nothing.
- **Where it stands:** `ws.head`, `ws.ref`, `ws.frozen` and
  `ws.uncommitted`; `ws.resolveRef` and `ws.expandRef` turn a tag, a
  short hash or `HEAD~n` into a commit.
- **Closing:** `ws.close()` stops the session's code worker and drops
  pending changes; later calls throw. Close a workspace that ran code
  when done with it: in Node, its worker keeps the process alive.
- **Fork** makes a child session from the current commit, or from
  `at`. `inherit: 'fresh'` leaves out the conversation and compaction's
  record.
- **Tags** never move: `ws.tags` names a session's commits, and
  `store.tags` the store's, outliving the sessions they name.
  `tags.at(name)` opens a frozen view.
- **One call at a time:** a workspace runs the calls that change it in
  order, so one call's writes and its commit never interleave with
  another's. `ws.exclusive(fn)` runs a host's own multi-step call the
  same way. Several workspaces on one session (two tabs) each commit;
  the one that loses a race merges onto the other's commit, and throws
  `CommitConflictError` only when the two changed the same thing in
  ways no merge rule settles.

## The kernel

`ws.runCode(code)` runs TypeScript in a worker (a browser Web Worker,
or Node `worker_threads`) as one call, committed as `{tool: 'run_ts'}`
when it changed anything:

```ts
const result = await ws.runCode(`
  import { summarize } from './lib/stats.ts'
  const rows = JSON.parse(await fs.read('data.json', 'utf8'))
  await fs.write('summary.json', JSON.stringify(summarize(rows)))
  return rows.length
`)
// result: { stdout, stderr, images, value: '120', error: null, commit, … }
```

- **Code** is the body of an async function: top-level `await`, and a
  top-level `return` shows its value. Types are stripped by
  ts-blank-space (or the profile's `transform`).
- **Its bindings:** `fs` (the session's files, every method async, with
  `read(path, 'utf8')` and string writes), `cache`, `env` (the
  profile's variables), `console` (`log`/`info` to stdout, `warn`/
  `error` to stderr, images shown as images), the profile's values (a
  copy each run), and the host objects.
- **Nothing carries over between runs** but the files and the cache,
  as in nontainer: each run gets a fresh scope.
- **Imports:** the world's own modules by path (relative to the working
  directory, or absolute), `'host'`, URLs, and bare names the profile's
  `resolve` maps to URLs (``(name) => `https://esm.sh/${name}` ``). A
  module reaches the host objects through `import { db } from 'host'`;
  only the code run has them as bare names. A dynamic `import(spec)`,
  in the code or a module, resolves as a static import from the same
  place would, computed specifiers included.
- **Output** keeps at most `maxObservation` characters of stdout and of
  stderr (32,000 by default), setting `truncated`; the terminal's
  transcript is capped the same way.
- **Its worker** is the package's built script (`@agex-ts/world/worker`,
  or `/worker.node` for Node), found next to the module; a bundled app
  whose bundler moves it gives `profile.code.worker.url` (and `target`:
  `'browser'`, `'node'` or `'auto'`, the default). In a browser, a
  script of another origin than the page's (a world loaded from a CDN)
  starts through a same-origin `blob:` module that imports it, which
  the browser allows where it refuses the script itself; it needs CORS
  from its host, as a CDN serves it.
- **`fetch('/path')`** reads the world's files with
  `profile.code.routeFetch`: true for every path (a miss goes to the
  network), a list of prefixes (a miss is a 404), or false (the
  default).
- **Stopping:** a run longer than the profile's timeout (30 seconds by
  default, of the code's own time: a host object's call doesn't count,
  up to `hostTime`, 10 minutes by default)
  is stopped with a `TimeoutError`, and `ws.interrupt()` stops
  one with a `CancelledError`. Either way the worker is terminated, what
  the code wrote is committed, and the next run starts a fresh worker.

### `ui` artifacts

With `profile.code.ui` on, code also has `ui`, an empty object each
run, for what it wants shown: `ui.revenue = { data, layout }`. When the
run ends, each value that renders is written under `<root>/ui` before
the commit, by kind, and named in `result.artifacts`; why a value gave
nothing is in `result.uiNotes`. nontainer's convention, with
JavaScript's values in place of Python's:

| value | file |
|---|---|
| a Plotly spec, `{data: [...], layout: {...}}` | `<name>.plotly.json` |
| an array of row objects, or an Arrow table | `<name>.table.json`: `{columns, data, total, columnTypes}`, 200 rows at most |
| an array of stat (`{label, value, sublabel?}`) and callout (`{type: 'callout', title, body, tone?}`) cards, or one callout | `<name>.cards.json`: `{items}` |
| image bytes, a `data:image` URL, a Blob, an `OffscreenCanvas` | `<name>.png` (or `.jpg`, `.gif`, `.webp`) |
| the path of a file the code saved | that file |

Anything else is data, and isn't written. run_ts's result ends with
`[ui artifacts: revenue -> /workspace/ui/revenue.plotly.json]` and a
`[ui note: …]` per problem, and its description tells the agent to
embed an artifact in its reply as
`![revenue](/workspace/ui/revenue.plotly.json)`. A harness renders one
by `artifactKind(path)`, finds a result's with `parseArtifactsNote`, and
shows after the reply the ones the reply doesn't embed.

## The profile

What the host grants a session, given to `store.open(id, {profile})`,
kept in memory only, and inherited by forks:

```ts
const ws = await store.open('alice', {
  profile: {
    hostObjects: {
      db: myDatabase, // its public methods, callable from code
      sessions: hostFactory((ws) => new Delegation(ws)), // made per world
    },
    values: { scores: [{ student: 'ada', total: 7 }] }, // data, bound by name
    variables: { SUPABASE_URL: 'https://…' }, // env in code
    secrets: { GITHUB_TOKEN: '…' }, // never in the world: host commands only
    code: { timeout: 60, resolve: (name) => `https://esm.sh/${name}` },
  },
})
```

- **Host objects** are called over async messages: code writes
  `await db.query(…)`. Methods whose names start with `_` aren't
  reachable, and arguments and results cross by value (see Values).
- **`typedHost(obj, contract)`** types an object's methods with
  Standard Schemas (below): only the contract's methods are reachable,
  each argument is checked on the host, and the result before it goes
  back.
- **`hostFactory(make)`** makes an object per world (`make(ws)` as each
  workspace opens, forks included), so it knows which session it serves.
- **Values** are data code reads by name, sent with each run, so every
  run gets a fresh copy and none can change the host's. A value with a
  live part is refused when the session opens.
- **`withStub(host, source)`** gives a host object a stub: the source
  of `(remote) => object`, run in the worker for each run, whose result
  is what code gets by the object's name. A stub hands code what can't
  cross (functions, classes, errors of its own) and checks or converts
  what code passes before it does. agex's `agex` is one.
- **`withCall(fn)`** declares a method that receives a `HostCall` first:
  its `ws` is the calling workspace as part of the code's call, so the
  method can fork or commit without waiting behind the call that's
  waiting for it.

## Values

What crosses the worker, and what is stored, crosses by value:

- **Live parts are refused where they'd cross:** a function, an
  instance of a class (structured clone would make it a plain object,
  its methods gone), a promise, a symbol, a getter, and shared memory
  (a `SharedArrayBuffer` or a view over one), which would cross as the
  same memory. The error names where: `at [0].client: a live Client`.
  `findLive(value)` asks first.
- **A stored value** is one blob: `encode(value)` and `decode(bytes)`,
  on the session's CBOR codec, behind a `world-value/1` header. Data,
  bytes, typed arrays, `Map`, `Set`, `Date`, `RegExp` and bigints come
  back as themselves; what wouldn't (an `ArrayBuffer`, an error, a value
  holding itself, an array with a property besides its items) is
  refused with `Unencodable`. `copy(value)` copies
  by the same rules, and the cache stores by them.
- **A declared type is a Standard Schema** (zod, valibot, arktype…):
  `check(value, schema)` gives what the schema's validation returns, or
  throws a `Mismatch` naming where it doesn't fit (`at
  scores[1].total: …`). `jsonSchemaOf(schema)` is the library's JSON
  Schema for it, for a model to read.

```ts
const catalog = typedHost(new Catalog(), {
  search: {
    args: { query: z.string(), limit: z.number().int().optional() },
    returns: z.array(Item),
  },
})
// in code: await catalog.search(42)
// TypeError: catalog.search: at query: Invalid input: expected string, received number
```

Arguments are a schema per position (an array) or by name (an object,
in the method's order, the names showing in errors). Tables aren't
carried yet: an Arrow table is refused as a live object.

## The shell

`ws.terminal(script)` runs a termish script over the session's files as
one call, committed as `{tool: 'terminal'}` when it changed anything,
and returns `{stdout, exitCode, stderr, truncated, commit}`; a failure
is a result (127 for a command not found, 2 for a script that doesn't
parse, 130 when interrupted), not a throw. The working directory
persists. `$NAME` expands the profile's variables, and the profile's
`commands` sit beside termish's own.

`curlCommand()` is a command a host grants (`commands: {curl:
curlCommand()}`) to fetch over the network: `-o`, `-L`, `-H`, `-X`,
`-d`, `--json`, `-f`, `-s`, `-m`, and a size cap. In a browser it tells
a CORS refusal from a dead network. A command made with
`commandFactory` gets a workspace that is part of the shell call it
runs in, so it can write and commit without waiting on that call.

## Secrets

A secret never enters the world: no code or shell reads its value, and
nothing stores it. The shell has `$TOKEN` and code has `secret('TOKEN')`,
both a reference (`${TOKEN}`) that the host's own code fills at the
request that needs it:

- **`curl`** fills it in a URL or header (`-H "Authorization: Bearer
  $TOKEN"`).
- **`httpHost()`**, a host object (`hostObjects: {http: httpHost()}`),
  does the same for code: `await http.fetch(url, {headers:
  {Authorization: 'Bearer ' + secret('TOKEN')}, as: 'json'})`.
- **A host object made with `hostFactory((ws, {secrets}) => …)`** can
  build a client with `secrets.get('TOKEN')`, so code calls the client
  and never holds the key.

A secret given as `{value, origins: ['https://abc.supabase.co']}` is
filled only for requests to those origins, and a request carrying one
follows no redirect; a plain string goes wherever it is asked to. A
secret a response echoes back is replaced by its reference before it
reaches the world.

A secret given as `{origins}` alone is declared: the host holds its
value somewhere the world can't reach (another process, a page's
parent). The world lists it and gives its reference as for any secret,
but `curl`, `httpHost()` and `request()` refuse a request carrying it
(`secret STRIPE_KEY has no value here: …`) rather than send the
reference; `secrets.get` throws `DeclaredSecretError` for it, and
`secrets.declared(name)` tells it apart. A host object that sends the
request on to where the value is held, reference and all, has it filled
there.

`secrets` may also be a function returning them, for a host whose keys
change while the session is open: the world calls it at each use (a
request, the shell's environment, the tools' descriptions), so a key
granted mid-turn is there for the next tool call and one revoked is
gone. What it returns is checked whenever it changes.

## The tools

`worldTools(ws)` gives the tools an agent loop hands a model, with
nontainer's names, schemas and result text: `terminal`, `file_write`,
`file_edit`, `view_image` (unless `vision: false`, for a model that
can't see) and `run_ts`, and `sessions` given a delegation helper
(`worldTools(ws, {sessions})`, with `runner` for asks it runs itself).
`terminalPrimer` and `codePrimer` add to the terminal's and the code
tool's descriptions. Each returns `{text, images,
written?, isError}`; a failure the agent can act on is an error result,
and `toMcpResult(out)` is the MCP `CallToolResult` for it. The
descriptions name what the world grants (variables, secrets, commands,
host objects, packages), and `toolInstructions(ws)` says how to pace
calls.

`file_edit` (and `ws.files.edit`) is nontainer's edit engine, checked
against it case by case: an exact match, then trailing-whitespace and
indent-flexible ones (the replacement re-indented), "already applied"
for a retry, and on a miss the closest lines of the file, plus a note
when the quote missed only by typographic look-alikes or Unicode form.

## Turns and the conversation

A harness frames each agent run as a turn:

```ts
const turn = await ws.turn(runId, { harness: 'my-loop' })
// … the run: each tool call commits on its own …
await turn.end('completed', { body: runMessages })
// one more commit: {tool: 'turn', runs: {[runId]: 'completed'}}
```

- **Statuses:** `completed`; `cancelled` (stopped from outside);
  `interrupted` (an error to resume from: `ws.turn(runId, {resume:
  true})` continues the run in place); `failed`.
- **The end** stores the run's body (the harness's format) in the
  conversation and commits what's left, stamped with the status and an
  optional message. A turn that changed nothing makes no commit.
- **An end that throws** (a `CommitConflictError`, say) still releases
  the turn. What it stored stays pending: `ws.refresh()` drops it, and a
  new turn can store the run again.
- **An interrupt, not a rollback:** a cancelled or failed run's files
  stay, and the harness keeps the run with a closing note in its body.
- **One turn at a time** per workspace; a fork has its own.
  `ws.runTurn(fn)` ends the turn however `fn` does (an abort is
  `cancelled`, any other error `failed`).

**The inbox** carries words to an agent that is already working.
Anyone may `inbox.put(text)` at any moment; a turn opened with the
inbox delivers what is queued on the next tool result, behind a visible
mark and a frame that says who is speaking:

```ts
const inbox = new Inbox()
const turn = await ws.turn(runId, { harness: 'my-loop', inbox })
// … for each tool result, before the model sees it:
const { text, notes } = await turn.deliver(result)
// … and the end settles what was delivered
```

- **Delivery is at a tool result, never sooner:** nothing interrupts a
  run, and a run that ends without another tool call leaves its notes
  for the next turn. `turn.opening()` is the first message of a turn
  woken for what is waiting rather than by a prompt.
- **Who is speaking:** a `principal` note is from whoever the session
  works for; a `mechanism` note is the machinery around the agent (a
  delegate's answer), framed as evidence rather than instruction.
- **States:** pending, then delivered (in an attempt that may yet be
  thrown away: `inbox.requeue()` puts its notes back), then settled
  when the turn ends. A turn's `sources` add notes of their own at each
  delivery; `onDelivered` hears of every delivery.

The conversation lives in the branch (`__conversation__/`): an index
(the harness, the session, the runs in order, the session it was forked
from), the harness's record, and a body per run, read back with
`ws.conversation`. So a checkout rewinds it with the files, a full fork
carries it (as the child's), and a fresh fork starts without it.

## Compaction's record

Past a token budget, a loop replaces the earlier turns, in what the
model is sent, by one summary. The stored conversation is never
rewritten. The world keeps the record of each fold, under
`__compaction__/`, so it goes where the conversation goes: a rewind
takes back the folds made after it, a full fork carries them, a fresh
fork starts without them, and a merge never brings another session's.

```ts
const folds = await ws.compaction.folds() // oldest first
const fold = await ws.compaction.inForce(messageIds) // null: send everything
await ws.compaction.record({ through: lastFoldedId, summary, runs: 4 }) // lands with the turn
```

- **The anchor:** a fold names the last message it covers by its id in
  the loop's history. It's in force only while that message is in the
  history; otherwise an earlier fold whose anchor is, or none.
- **The loop's choices:** when to fold, what a fold covers, what it
  splices into a request and how the summary is written. The helpers
  are there to use or not: `Policy(budget, window)`, `summaryRequest()`,
  `summaryMessage(summary)` and `ACK` for the pair spliced in its place,
  `reduce`, `transcript` and `chunks` for a history too large to
  summarise in one request, `estimateTokens`, and `COMPACTION_MARK` /
  `isOurs` for the ids of inserted messages.
- **The event:** a new fold is streamed as `Compacted`.

## Traces

A session's conversation, mounted beside its files as markdown a model
reads: another agent learns from what a session went through, not only
from what it produced. The store says how to read each harness's runs:

```ts
const store = await Store.open(kv, { traces: { neutral: new NeutralTraces() } })
await ws.files.attach('analyst', 'an', { trace: true, since: 'analyst@a3f9c2e' })
// an/ holds the files, an/.trace/ the conversation, at the same commit
```

The agent's spelling is `ws-git worktree add --trace [--since <ref>] an
analyst`, and `ws-git show analyst:.trace/index.md` reads one file with
nothing mounted.

- **The files:** `README.md` (whose conversation, at which commit),
  `index.md` (one line per run: status, time, calls, errors, files,
  tokens, input), `system/<hash>.md` (each distinct prompt once), and per
  run `run.md` (its facts, input, reply and a line per tool call),
  `changed.md` (the files it changed, commit by commit) and `events/`
  (one file per event). `grep -l notes.md */.trace/runs/*/changed.md`
  finds the run that wrote a file.
- **What a run changed** comes from the branch's history: the commits
  after the run before it landed, through its own landing, the host's
  among them, and nothing from before the session's fork.
- **`since`** marks the runs new since a state with `+` (a ref, or a bare
  commit of the session traced): a run that landed before it and again
  after is new.
- **Lazy and read-only:** nothing but the index is read until the trace
  is, and each file renders on its first read. It hides a `.trace` the
  tree holds of its own. A state with no conversation is refused, and so
  is one a harness wrote that the store has no source for. With
  `traces`, every session's conversation is readable store-wide.
- **The shape:** a `TraceSource` reads one stored run into the neutral
  `TraceRun` (status, times, model, token counts, the system prompt, and
  events: user, assistant, thinking, and one per tool call with its
  result), and `Trace` renders every file from it, the same whichever
  harness wrote the run. `NeutralTraces` reads runs stored in that
  shape itself (`neutralBody`), which is how the corpora seed them.
- **A port of nontainer's projection**, checked against its trace corpus
  byte for byte, and its ws-git scripts for what the verb prints.

## Planes

A harness's own records in the session, beside the files and the
conversation, under `__plane__/<name>/`: code and tools never see them,
and a commit, a fork or a checkout carries them with everything else.
A write lands with the next commit. agex keeps a task's spec, inputs,
state and value on its `__task__` plane.

```ts
const plane = ws.plane('__task__')
plane.set('state', { status: 'running' }) // lands with the next commit
await plane.get('state') // pending writes included; null for none
await plane.keys() // sorted
```

## The agent's git

`ws.index` is the agent's own git over the session: an index it fills
across several edits, commits it names, and a log of just those. It is
metadata over the session's history (a blob at `__ws_git__`), so the
framework's commit per call never disturbs what the agent is composing:

```ts
await ws.index.stage(['/workspace/a.py'])
const commit = await ws.index.commit('add a') // the staged set, or all modified
await ws.index.status() // {staged, unstaged, added, removed, mergeSource, …}
await ws.index.log() // the agent's commits, newest first
await ws.index.checkout(commit) // files back, as a new commit
await ws.index.tags.add('v1') // the agent's own bookmarks
```

- **An agent commit holds exactly what it committed:** paths outside it
  are put back for the commit and restored after, in a bookkeeping
  commit (`ws-git.restore`) that `ws.log()` leaves out (`{kind: 'all'}`
  shows it; `{kind: 'agent'}` is the agent's alone).
- **A fork starts afresh:** no index, no head, no tags, and the commit
  it started from recorded as its `base`, so its first commit takes only
  what it changed.
- **The tools `ws-git` and `ws-git.*` are reserved** to these commits:
  `ws.commit` refuses them.

**`ws-git`** is the same git as a terminal command, for the agent:
give it in the profile, and the shell has it.

```ts
import { wsGit } from '@agex-ts/world'
const ws = await store.open('main', { profile: { commands: { 'ws-git': wsGit } } })
await ws.terminal('ws-git status')
// stage/add, unstage, reset, commit, status, diff, log, show, checkout,
// tag, stash, branch, merge, revert, cherry-pick, worktree,
// sparse-checkout, help
```

It is a port of nontainer's `ws-git`, and prints what it prints, word
for word: `tests/wsgit-corpus/` holds nontainer's recorded scripts
(every command's stdout, stderr and exit code), and the world's test
replays each one and compares.

Work comes back across sessions by three verbs, one three-way engine:

- **`ws.merge(session)`** brings another session's committed work: at
  its agent's last commit, refused while either side has ws-git work
  uncommitted. It brings files only; the cache, the conversation and the
  agent's git stay this session's.
- **`ws.revert(commit)`** undoes one commit's change as a new commit;
  **`ws.cherryPick('session@commit')`** brings one. A commit's change is
  measured in the agent's graph, so a delegate's commit brings its own
  work and nothing it inherited.
- **Conflicts** land as markers in the commit (`conflicts` in the
  outcome) and stay outstanding, refusing other moves, until the markers
  are gone or `ws.index.abortMerge()`. Something no rule settles (a file
  made a directory) isn't merged at all.

## Views, takes and attachments

**A narrowed fork** sees only some paths: `ws.fork(name, {paths:
['auth.py']})`. Its branch still holds everything (so the merge back
is an ordinary three-way); its files list and read only the view.
It may create a path anywhere, which joins its view, but changing or
removing a path outside the view is refused (`EACCES`). `paths: []` is
an empty view. `ws.view` reads it, and `ws.diff` names what a narrowed
session was given (`seed`), splitting its changes into `inSeed` and
`elsewhere`, so a delegate's collateral doesn't go unnoticed.

**`ws.checkout(ref, {paths})`** takes paths from anywhere: another
session by name (at its agent's last commit), `session@commit`, a store
tag. A file is taken; a directory is mirrored (what `ref` lacks there is
removed). The commit records `takenFrom`, the files taken, and what was
removed.

**`ws.files.attach(ref, at)`** mounts another session's tree, frozen,
read-only, at `at`: for reading a delegate's work in place before
deciding to merge it. Not versioned, not carried by a fork, gone when
the session closes; `detach(at)` and `attachments()` go with it. The
agent's shell and code see it too. `{ trace: true }` mounts the
session's conversation beside it, at `<at>/.trace` ([Traces](#traces)).

**Ignore patterns** (`store.open(id, {ignore: ['*.log', 'node_modules/']})`,
a `.gitignore` subset) name paths that are never work, as is anything
outside the root: ws-git, diffs and merges leave them out (a merge keeps
this side's copy), and a directory take skips them unless named. They're
still written and read back. Forks inherit them.

## Skills

Packaged instructions, as Claude Code lays them out:
`<root>/skills/<name>/SKILL.md`, with frontmatter (`name`,
`description`), and any files beside it.

```ts
const skills = [starterMarkdown, { name: 'media', files: { 'SKILL.md': md, 'helpers/make.ts': ts } }]
const ws = await store.open('alice', { profile: { skills } }) // mounted read-only
await toolInstructions(ws) // the pacing notes, then one line per skill
```

- **The embedder's skills are mounted** (the profile's `skills`): each
  read-only at `<root>/skills/<name>` on every open, forks included. Not
  being the session's files, ws-git never sees them and no commit
  carries them.
- **An agent's own skills are files it writes** there, beside the
  mounted ones, and they're its work like any other files. There's no
  installing a skill as session files: a copy the framework committed
  would read in ws-git as work the agent never did.
- **Discovery** is the tool text's: `skillCatalog(ws)` lists every
  skill's name and description, and `toolInstructions` carries it. The
  shell and code read the rest as files.

A directory that holds only mount points (`<root>/skills` before the
agent writes one of its own, or `/reviews` under an attachment at
`/reviews/alice`) reads as a directory: it lists, and the shell can
enter it.

## Delegation

A delegate is a fork: `Sessions` is the calling convention over `fork`,
`diff`, `checkout` and `merge` that hands one to an agent loop and
collects what it says back. The loop is the embedder's, a
`SessionRunner`:

```ts
const sessions = new Sessions(ws, {
  async run(session, task, { budget, forkedAt, signal }) {
    // open `session`, run the delegate's turns until it settles
    return reply // a string, or {text, status, artifacts, provenance}
  },
})
const job = await sessions.ask('polish the report', { paths: ['report.md'] })
// … later
const answer = sessions.result(job.name) // JobRunningError until it lands
await ws.merge(answer.branch) // or checkout(answer.branch, {paths}), or leave it
```

- **`ask`** forks under a scoped pet name (`alice.sleepy-otter`) at a
  real commit (pending writes land first) and starts the run;
  `{wait: true}` returns the answer. `paths` narrows what the child
  sees. A fork of this session starts with a fresh conversation
  (`inherit: 'full'` brings it along); `forkFrom` starts it elsewhere (a
  session as it is now, a store tag, `session@commit`), carrying that
  state's conversation unless `inherit: 'fresh'`; `resume` gives a child
  its next task on the same branch. A child runs one task at a time, and
  at most `maxWorkers` (4) run at once.
- **Everything a delegate wrote is its answer.** One that never used
  ws-git answers at its branch head; one that committed and then wrote
  more has the remainder committed for it, unless a merge of its own is
  unresolved (then `answer.uncommitted`, and a merge refuses it).
  `answer.changed` groups its paths into `seed` and `elsewhere`, and
  `provenance.chain` names every hop behind it.
- **Collecting:** `result` and `take()` share one mark, so an answer is
  handed over once; `wait()`, `answers()` and `onAnswer` say when one
  lands. `answerNotes(sessions, inbox)` as a turn's source
  (`sources: [(inbox) => answerNotes(sessions, inbox)]`) delivers each
  on the next tool result, framed as the mechanism speaking.
  `sessions.list()` shows the jobs, and `outstanding()` the ones not
  yet answered, which `untilSettled` waits on.
- **`untilSettled(runTurn, sessions, inbox, {prompt})`** is the loop a
  runner drives a delegate with: a reply given while the delegate's own
  delegates are out, or a note is waiting, is it waiting, so it's woken
  (`runTurn(null)`, which opens with `turn.opening()`) until nothing is
  outstanding, or its wakes run out.
- **`cancel`** aborts the run's signal and discards its answer; the
  branch stays. **`sweep(idle)`** deletes the branches of finished,
  unkept jobs left untouched that long (`keep` exempts one); the
  embedder schedules it. The job table is the helper's, in memory: what
  survives a restart is the branches.
- **From code,** a host method declared `withCall` asks with `{call}`,
  so the fork runs as part of the code's call; `Sessions.of(ws)` finds
  the session's helper.

## Conformance

`@agex-ts/world/conformance` holds nontainer's harness corpus (its
exported scenarios, synced with `scripts/sync-corpus.mjs`) and a runner:
`runScenario(scenario, harness)` plays a scenario against a harness
through a scripted model, and `check` says how it differs from what the
scenario expects (including a turn that leaves script steps unused:
a harness that stops early). A harness declares its capabilities, and the
scenarios it covers apply. The package's own reference harness passes
every scenario, tiers 0 to 5; with `delegation`, a harness hands
the runner a `CorpusDelegates`, which runs each delegate as a session of
that harness through `untilSettled`.

The same script syncs nontainer's ws-git scripts and trace cases into
`tests/`, which the ws-git verb and the trace renderer replay.

## Layout

| key | value |
|---|---|
| `__file__<abs path>` | a file's bytes |
| `__meta__<abs path>` | `{size, createdAt, modifiedAt, isDir}` |
| `__cwd__` | the working directory |
| `__cache__/<key>` | a cache entry |
| `__conversation__/…`, `__compaction__/…` | the turn's records |
| `__plane__/<name>/…` | a harness's own records (`ws.plane(name)`) |
| `__ws_git__` | the agent's git: index, head, merge, tags |
| `__ws_view__` | a narrowed fork's view and seed |

Content and metadata are separate keys, so unchanged content keeps its
stored blob.

## License

MIT
