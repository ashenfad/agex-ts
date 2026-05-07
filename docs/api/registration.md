# Registration

Registrations are how you hand pieces of your TypeScript codebase to the agent. The agent's action space — what it can call, instantiate, see — is exactly the set of registrations you've made.

## Shapes

| Method | What you register | Naming |
|---|---|---|
| `agent.fn(fn, opts?)` | A standalone function | `opts.name` overrides; otherwise inferred from `fn.name` |
| `agent.cls(cls, opts?)` | A class — agent can `new` and call methods | `opts.name` overrides; otherwise inferred from `cls.name` |
| `agent.namespace(target, opts)` | A plain object or module — exposed as a namespace | `opts.name` required |
| `agent.skill(content, opts)` | Markdown documentation surfaced at `/skills/<name>/SKILL.md` | `opts.name` required |
| `agent.terminal(handler, opts)` | A shell-style command runnable from `terminal_action` | `opts.name` required |

All return `this` for chaining. Calls are eagerly validated — invalid identifiers, name collisions across kinds, etc., throw `RegistrationError` immediately.

## `agent.fn`

```ts
agent.fn(
  fn: ((...args: unknown[]) => unknown | Promise<unknown>) | UrlSpec,
  opts?: FnRegistration,
): this

interface FnRegistration {
  readonly name?: string
  readonly description?: string
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
  readonly paramsSchema?: StandardSchemaV1  // host-side input validation
}
```

**Live function form:** the agent calls it; under `workerRuntime`, calls round-trip to the host via postMessage and the host runs the actual function.

```ts
agent.fn(
  async (...args: unknown[]) => {
    const url = args[0] as string
    const res = await fetch(url)
    return res.json()
  },
  { name: 'fetchJson', description: 'GET a URL and return parsed JSON.' },
)
```

**`paramsSchema`** validates the agent's call args before the host fn runs. Validation failure surfaces as a runtime error the agent sees and can adjust to. Cannot combine with the URL form (URL-shipped fns are called natively; no host hook for the schema check).

## `agent.cls`

```ts
agent.cls(
  cls: (new (...args: unknown[]) => unknown) | UrlSpec,
  opts?: ClsRegistration,
): this

interface ClsRegistration {
  readonly name?: string
  readonly description?: string
  readonly constructable?: boolean   // primer-only hint, default true
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Record<string, MemberConfig>
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}
```

The agent gets a class it can `new` and call instance / static methods on. Under `workerRuntime` with a live cls, the worker sees a stub: `new Vec(3, 4)` allocates a host-side instance; method calls round-trip via postMessage.

```ts
class Vec {
  constructor(public x: number, public y: number) {}
  magnitude() { return Math.sqrt(this.x * this.x + this.y * this.y) }
}

agent.cls(Vec, { description: '2D vector with magnitude().' })
```

**Member filters:** `include` / `exclude` accept a glob string (`'foo*'`), array of globs, or a predicate function. `exclude` always wins over `include`. Defaults expose all enumerable members; pass `exclude: '_*'` to hide underscore-prefixed.

**`configure`:** per-member overrides (description, etc.). See the source for the `MemberConfig` shape.

## `agent.namespace`

```ts
agent.namespace(target: object | UrlSpec, opts: NsRegistration): this

interface NsRegistration {
  readonly name: string                // required
  readonly description?: string
  readonly recursive?: boolean         // expose nested namespaces too
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Record<string, MemberConfig>
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}
```

Expose a plain object or module as a flat-ish namespace the agent can read members off:

```ts
import * as stats from './stats'
agent.namespace(stats, {
  name: 'stats',
  description: 'mean, stdev, percentile, etc.',
})
```

The agent then writes `stats.mean([1, 2, 3])` directly. Under workerRuntime, calls bridge through postMessage.

`recursive: true` walks nested objects (a module that re-exports sub-modules). Default `false`.

## `agent.skill`

```ts
agent.skill(content: string, opts: SkillRegistration): this

interface SkillRegistration {
  readonly name: string
  readonly description?: string
  readonly primer?: string
}
```

Mounts markdown content at `/skills/<name>/SKILL.md` in the agent's VFS. The agent can `cat /skills/<name>/SKILL.md` from `terminal_action` when it needs to learn how to use a particular library or domain. Where registrations are **what's available**, skills are **how to use it well**.

```ts
agent.skill(
  `# Database conventions\n\nQueries should always include a tenant_id filter…`,
  { name: 'db-conventions' },
)
```

The skill's `name` becomes its directory in the overlay. Top-level descriptions of available skills are auto-rendered into the system prompt; agents discover specifics via `cat`.

## `agent.terminal`

```ts
agent.terminal(handler: TerminalCommandHandler, opts: TerminalRegistration): this

interface TerminalRegistration {
  readonly name: string
  readonly description: string         // required (no docstring fallback in TS)
  readonly hostFsAccess?: boolean
  readonly networkAccess?: boolean
}
```

Registers a custom command callable from the agent's `terminal_action` shell. Useful for tools whose natural surface is a CLI rather than a TS function (compilers, formatters, archive utilities, etc.).

```ts
agent.terminal(
  async (ctx) => {
    const text = ctx.stdin.trim()
    ctx.stdout.write(text.toUpperCase() + '\n')
  },
  { name: 'shout', description: 'Uppercase stdin.' },
)
```

The handler receives a `CommandContext` (args, stdin, stdout, fs, signal — see termish-ts). The library shape (registered fns and namespaces) stays primary; the terminal is for CLI-flavored tooling and `--help`-and-pipelines idioms.

## URL-shipped registrations

Replace the live JS reference with `{ url, export? }` to ship a module into the worker realm by URL:

```ts
interface UrlSpec {
  readonly url: string
  readonly export?: string  // named export to pluck; default depends on kind
}

agent.cls(
  { url: 'https://esm.sh/big-graph-lib', export: 'Graph' },
  { name: 'Graph', description: 'Graph data structure.' },
)
```

The worker dynamic-imports the module at agent init time. The named export becomes the agent-facing class / fn / namespace, called natively in the worker realm — no host RPC bridging per call. Useful for big libraries (graph libs, parsers, etc.) you want fully callable inside the worker.

URLs that resolve: any ESM-resolvable URL — `esm.sh`, `jsdelivr`, `cdn.jsdelivr.net`, your own CDN, `data:application/javascript;base64,...`, blob URLs.

### Default export semantics

| Kind | Default export field |
|---|---|
| `agent.fn({ url })` | `export?` defaults to the registration name. `export: 'default'` for default-exported fns. |
| `agent.cls({ url })` | `export?` defaults to the registration name. `export: 'default'` for default-exported classes. |
| `agent.namespace({ url })` | `export?` defaults to **the whole module namespace object**. Pass an explicit string to pluck a specific export. |

### Restrictions on URL-shipped registrations

URL-shipped registrations exist in the worker realm; the host has no hook into individual calls. So:

- `paramsSchema` cannot combine with `url` on `agent.fn`.
- `constructable: false` cannot combine with `url` on `agent.cls`.
- `include` / `exclude` / `configure` cannot combine with `url` on `agent.cls` or `agent.namespace` — the module is exposed whole.

Pre-wrap the export in a thinner module if you need a narrower surface or per-call validation.

## Capability flags

Two flags propagate to the registration record for adapters to consult:

| Flag | Meaning |
|---|---|
| `hostFsAccess?: boolean` | Hint that this registration may read/write the host's real filesystem (vs. just the agent's VFS). |
| `networkAccess?: boolean` | Hint that this registration may make network requests. |

These are advisory: agex-ts doesn't enforce sandboxing based on them. They're surfaced on the registration record for embedders building audit / review tooling around agent activity, and may inform future capability-based isolation.

## Member filters

```ts
type MemberFilter = string | string[] | ((name: string) => boolean)
```

`include` / `exclude` on `cls` and `namespace` accept:

- A single glob: `'foo*'`, `'?bar'` (`?` matches one char).
- An array of globs: `['foo*', 'bar']` — matches any.
- A predicate function: `(name) => name.length > 3`.

`exclude` always wins over `include`. Defaults expose every enumerable member.

```ts
agent.namespace(myMod, {
  name: 'lib',
  include: ['publicApi*'],
  exclude: '_*',
})
```

## Chaptering

There's no `agent.chapterTask({...})` method — chaptering is enabled via `AgentOptions.chapteringTrigger`. When that option is set, the framework auto-registers an internal chapter task with the default primer. Override the primer with `AgentOptions.chapterPrimer` if you want different framing. See [Chapters](../concepts/chapters.md) for the model.

## Validation

Eagerly checked at registration time:

| Rule | Error |
|---|---|
| Name must be a non-empty string matching `[A-Za-z_][A-Za-z0-9_]*` | `RegistrationError` |
| Names are unique across all kinds (fn / cls / namespace / skill / terminal) | `RegistrationError: name "X" already registered as a ...` |
| Live value xor URL spec — exactly one must be present | `RegistrationError: pass either the live value or { url, ... }` |
| Empty URL string rejected | `RegistrationError: url must be a non-empty string` |
| `paramsSchema` + URL combination rejected | `RegistrationError: paramsSchema can't be combined with { url }` |
| `constructable: false` + URL on cls rejected | `RegistrationError: constructable: false can't be combined with { url }` |
| `include` / `exclude` / `configure` + URL on cls/namespace rejected | `RegistrationError` |

## What the agent sees

Registrations are surfaced into the agent's system prompt under "Registered Resources" — auto-rendered from `agent.policy()`. You can replace the auto-rendered section with curated prose via `AgentOptions.capabilitiesPrimer` (the runtime adapter still injects everything; this only affects what the agent *sees*).
