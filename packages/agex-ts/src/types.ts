/**
 * Canonical type module for agex-ts.
 *
 * Discriminated unions for emissions / events / tokens, the
 * `RuntimeAdapter` and `LLMClient` contracts, the registration
 * record types, the `Policy` table, and re-exports of the error
 * hierarchy. No runtime code beyond error classes.
 *
 * Importable directly via `agex-ts/types` for consumers that want
 * the contract surface without dragging in any runtime.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { FileSystem } from 'termish-ts'

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  AgentError,
  CancelledError,
  FatalError,
  isTaskControlError,
  RegistrationError,
  SchemaError,
  TASK_CONTROL_BRAND,
  TaskFailError,
  TransientError,
  type BrandedTaskError,
} from './errors'

/** The agent's host-side virtual filesystem — same protocol as the
 *  termish-ts `FileSystem`. Re-exported so consumers can implement it
 *  without depending on termish-ts directly. */
export type VirtualFileSystem = FileSystem

/**
 * Optional host-supplied resolver for unregistered import specifiers.
 *
 * When the agent's emitted code contains `import x from 'foo'` and
 * `'foo'` isn't in the registered namespace map, the runtime calls
 * the resolver. Returning a URL imports that module; returning `null`
 * (or throwing) denies the import — the agent sees a `Cannot find
 * module 'foo'` error on its next turn.
 *
 * The resolver may be sync or async; the worker's import-resolution
 * path awaits async returns naturally.
 *
 * Resolution priority: registered namespace → resolver → error.
 * A specifier matched by a registered namespace never reaches the
 * resolver.
 */
export type NamespaceResolver = (specifier: string) => string | Promise<string | null> | null

// ---------------------------------------------------------------------------
// Emissions — the LLM's per-turn outputs that the agent loop dispatches
// ---------------------------------------------------------------------------

/** TypeScript code the agent wants to execute in the sandbox. */
export interface TsEmission {
  readonly type: 'ts'
  readonly code: string
  readonly thinking?: string
  readonly title?: string
  /** Provider-native opaque round-trip blob (Claude thinking blocks,
   *  Gemini `thought_signatures`). MUST be passed back verbatim on
   *  the next request — providers reject mismatched signatures. */
  readonly signature?: Uint8Array
}

/** A shell pipeline the agent wants to run via termish-ts. */
export interface TerminalEmission {
  readonly type: 'terminal'
  readonly commands: string
  readonly thinking?: string
  readonly title?: string
  readonly signature?: Uint8Array
}

/** Replace or create a file in the agent's VFS. */
export interface FileWriteEmission {
  readonly type: 'fileWrite'
  readonly path: string
  readonly content: string
  readonly mode: 'write' | 'append'
  readonly signature?: Uint8Array
}

/** Apply a search/replace edit against a file in the VFS. */
export interface FileEditEmission {
  readonly type: 'fileEdit'
  readonly path: string
  readonly search: string
  readonly content: string
  readonly matchAll?: boolean
  readonly signature?: Uint8Array
}

/** Free-text observation from the agent. No side effect; logged. */
export interface TextEmission {
  readonly type: 'text'
  readonly text: string
  readonly signature?: Uint8Array
}

/** Reasoning/thinking output the agent wants to surface. No side
 *  effect; logged. May be `redacted` (provider stripped the content
 *  but kept the slot — must be preserved for cache integrity). */
export interface ThinkingEmission {
  readonly type: 'thinking'
  readonly text: string
  readonly redacted?: boolean
  readonly signature?: Uint8Array
}

/** Discriminated union of every emission variant. Order is
 *  load-bearing for prompt caching — providers validate that the
 *  next request echoes the same sequence (and signatures) verbatim. */
export type Emission =
  | TsEmission
  | TerminalEmission
  | FileWriteEmission
  | FileEditEmission
  | TextEmission
  | ThinkingEmission

// ---------------------------------------------------------------------------
// Streaming tokens — what `LLMClient.complete()` yields
// ---------------------------------------------------------------------------

export type TokenChunkType =
  | 'title'
  | 'thinking'
  | 'text'
  | 'ts'
  | 'terminal'
  | 'filePath'
  | 'fileSearch'
  | 'fileContent'
  | 'emission'
  | 'signature'
  | 'toolStart'

/** A single chunk of a streaming LLM response. The agent loop
 *  forwards these to `onToken` callbacks in real time and assembles
 *  full `Emission`s from `type: 'emission'` deltas. */
export interface TokenChunk {
  readonly type: TokenChunkType
  readonly content: string
  readonly done: boolean
  /** Index of the emission this chunk contributes to (zero-based). */
  readonly emissionIndex: number
  /** Present on `done` boundaries — the fully assembled emission. */
  readonly emission?: Emission
  readonly signature?: Uint8Array
  readonly inputTokens?: number
  readonly outputTokens?: number
}

// ---------------------------------------------------------------------------
// Events — the durable, replayable record of a task
// ---------------------------------------------------------------------------

/** Fields shared by every event in the log. */
export interface EventBase {
  /** ISO 8601 UTC timestamp. */
  readonly timestamp: string
  /** Name of the agent that produced this event. */
  readonly agentName: string
  /** kvgit commit hash this event was committed under, if any. */
  readonly commitHash?: string
  /** State key of the parent event in the same task lineage. Lets
   *  callers walk back through `state.events()` for a single task. */
  readonly parentRef?: string
  /** Optional token estimates for context-budget accounting. */
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface TaskStartEvent extends EventBase {
  readonly type: 'taskStart'
  readonly taskName: string
  readonly inputs: unknown
  readonly message?: string
}

export interface ActionEvent extends EventBase {
  readonly type: 'action'
  /** Ordered emission sequence from the LLM turn. Order and
   *  signatures are immutable from this moment on. */
  readonly emissions: ReadonlyArray<Emission>
}

export type ImageFormat = 'png' | 'jpeg' | 'webp'

/** Trailing-arg context passed to a registered host fn that opts in
 *  via `wantsContext: true` on its registration.
 *
 *  - `console`: routes through the same image-aware pipeline as agent
 *    code's `console.log`. Use this in browser-host embedders where
 *    ALS-based capture isn't available.
 *  - `signal`: fires when the agent task is cancelled. In the worker
 *    runtime this reflects the per-execute external signal only.
 *
 *  See `runtime/console-capture` for the implementation. */
export interface HostFnContext {
  readonly console: Console
  readonly signal: AbortSignal
}

export type OutputPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly format: ImageFormat
      /** Base64-encoded bytes. */
      readonly data: string
      readonly altText?: string
    }
  /** A runtime error raised by the agent's emitted code. The loop
   *  emits this part on the OutputEvent for the failing emission and
   *  continues with the next iteration so the agent can self-correct.
   *
   *  Distinct from `ErrorEvent`, which is reserved for framework-level
   *  errors not shown to the agent (worker death, runtime adapter
   *  crash, etc.). This variant is "code the agent wrote threw" — the
   *  agent should see it. */
  | {
      readonly type: 'error'
      readonly errorName: string
      readonly errorMessage: string
    }

export interface OutputEvent extends EventBase {
  readonly type: 'output'
  readonly parts: ReadonlyArray<OutputPart>
  /** Stable id of the emission that produced these outputs. The
   *  renderer uses this to pair the OutputEvent back to the right
   *  `tool_use` block when composing turns for the next LLM call. */
  readonly emissionId?: string
}

export interface SuccessEvent extends EventBase {
  readonly type: 'success'
  readonly result: unknown
}

export interface FailEvent extends EventBase {
  readonly type: 'fail'
  readonly message: string
}

export interface CancelledEvent extends EventBase {
  readonly type: 'cancelled'
  readonly taskName: string
  readonly iterationsCompleted: number
}

export interface ErrorEvent extends EventBase {
  readonly type: 'error'
  readonly errorName: string
  readonly errorMessage: string
  readonly recoverable: boolean
}

export interface FileEvent extends EventBase {
  readonly type: 'file'
  readonly source: 'user' | 'agent'
  readonly added: ReadonlyArray<string>
  readonly modified: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export interface SystemNoteEvent extends EventBase {
  readonly type: 'systemNote'
  readonly message: string
}

/** Context-compaction marker. Replaces the chaptered event range in
 *  the active event log; the originals stay at their state keys
 *  (referenced via `eventRefs`) so they remain browseable through
 *  the `/chapters/<slug>/` VFS overlay. */
export interface ChapterEvent extends EventBase {
  readonly type: 'chapter'
  readonly name: string
  readonly message: string
  /** Slug used as the path segment in the VFS overlay
   *  (`/chapters/<slug>/`). Stable across renders; computed once at
   *  chapter creation with collision-handling against existing
   *  chapters in the same log. */
  readonly slug: string
  /** State keys of the events this chapter summarizes — read by the
   *  VFS overlay to materialize per-event markdown files. */
  readonly eventRefs: ReadonlyArray<string>
}

export type AgentEvent =
  | TaskStartEvent
  | ActionEvent
  | OutputEvent
  | SuccessEvent
  | FailEvent
  | CancelledEvent
  | ErrorEvent
  | FileEvent
  | SystemNoteEvent
  | ChapterEvent

/** Returned by the chapter task. `start` and `end` are 1-based,
 *  inclusive positions into the numbered event index the task
 *  receives — e.g. `{ start: 1, end: 3 }` covers the first three
 *  entries. The framework translates these positions to actual
 *  state keys when applying the chapter to the log. */
export interface Chapter {
  readonly start: number
  readonly end: number
  readonly name: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export interface TaskCallOptions {
  /** Session identifier — isolates state (events, fs, cache). Default `"default"`. */
  readonly session?: string
  /** Cancellation. The agent loop checks at iteration boundaries and
   *  threads the signal into `RuntimeAdapter.execute` and
   *  `LLMClient.complete`. */
  readonly signal?: AbortSignal
  /** Fired for every event written to the log. */
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>
  /** Fired for every streaming token from the LLM. */
  readonly onToken?: (token: TokenChunk) => void | Promise<void>
}

/** A task is a typed callable. The user-facing surface returned by
 *  `agent.task({ ... })`. */
export type TaskFn<I, O> = (input: I, options?: TaskCallOptions) => Promise<O>

/** What the runtime adapter returns from each `ts` emission. */
export type TaskOutcome =
  | { readonly kind: 'success'; readonly value: unknown }
  | { readonly kind: 'fail'; readonly message: string }
  /** No terminal action — agent wants another turn. */
  | { readonly kind: 'continue' }

// ---------------------------------------------------------------------------
// Runtime adapter contract
// ---------------------------------------------------------------------------

export interface ExecuteContext {
  readonly fs: VirtualFileSystem
  readonly cache: Cache
  readonly signal: AbortSignal
  /** The validated task input, exposed to the agent code as the
   *  `inputs` variable. Stable across every emission of a single
   *  task call. `undefined` for tasks with no input. */
  readonly inputs?: unknown
  /** Optional identifier for the source emission, for diagnostics. */
  readonly emissionId?: string
}

export interface ExecResult {
  readonly outcome: TaskOutcome
  readonly outputs: ReadonlyArray<OutputPart>
  /** Unexpected runtime errors (parse error, module not allowed,
   *  exceeded timeout, etc.). Task-control raises don't land here —
   *  they surface as `outcome`. */
  readonly error: Error | null
  readonly elapsedMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface RuntimeInitOptions {
  readonly namespaceResolver?: NamespaceResolver
}

export interface RuntimeAdapter {
  /** One-time initialization. Called when the agent first runs a task.
   *  Receives the registration policy so the adapter can configure
   *  module resolution. The optional `namespaceResolver` is the
   *  agent's host-supplied callable for unregistered import
   *  specifiers; runtimes should route unrecognized names through it
   *  before erroring with `Cannot find module`. */
  init(policy: Policy, opts?: RuntimeInitOptions): Promise<void>
  /** Run a single `ts` emission. */
  execute(code: string, ctx: ExecuteContext): Promise<ExecResult>
  /** Release resources. Called when the agent is disposed. */
  dispose(): Promise<void>
  /** Optional addendum the runtime contributes to the system primer.
   *  Returned text is appended to the built-in primer at task-message
   *  build time. Use when runtime configuration is worth surfacing to
   *  the agent — e.g. `workerRuntime`'s `routeFetchToVfs` enables
   *  `fetch('/path')` against the VFS, which the agent should know
   *  about. Return `undefined` when the runtime has nothing to add. */
  primerAddendum?(): string | undefined
}

// ---------------------------------------------------------------------------
// LLM client contract
// ---------------------------------------------------------------------------

export interface LLMRequest {
  /** Fully assembled system prompt: BUILTIN_PRIMER (or override),
   *  capabilities or registered resources, skills listing, the
   *  agent's own primer. Provider sends this as the system field
   *  of its API request. */
  readonly system: string
  /** Conversation turns, pre-rendered into neutral parts by
   *  `agex-ts/render`. The first turn is always the per-task
   *  opening user message (description + inputs + expected return);
   *  subsequent turns come from `renderEvents()` over the event
   *  log. Provider lowers each part into its wire format
   *  (Anthropic content blocks, OpenAI tool messages, Gemini
   *  parts arrays). */
  readonly turns: ReadonlyArray<import('./render').NeutralTurn>
}

export interface LLMResponse {
  readonly emissions: ReadonlyArray<Emission>
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface LLMConfig {
  readonly provider: string
  readonly model: string
  readonly timeoutSeconds: number
  /** Provider-specific extras serialized for transport. */
  readonly extras?: Readonly<Record<string, unknown>>
}

export interface LLMClient {
  /** Streaming response. Yields `TokenChunk`s as the provider produces
   *  them. The agent loop forwards these to `onToken` and assembles
   *  full `Emission`s from `done` boundaries. */
  complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>
  /** Serialize for transport (e.g. when state-config carries the LLM
   *  shape across a worker boundary). */
  dumpConfig(): LLMConfig
}

// ---------------------------------------------------------------------------
// Registration records — what the Policy table holds
// ---------------------------------------------------------------------------

/** Common to every registration. Capability flags propagate to the
 *  runtime adapter; the runtime decides whether to allow the call. */
export interface RegistrationCommon {
  /** Description-presence is the prominence lever. Items with a
   *  description appear in the agent's primer; without, they exist
   *  but aren't advertised. */
  readonly description?: string
  /** True if the registered code may touch the host real filesystem.
   *  Default `false`. */
  readonly hostFsAccess?: boolean
  /** True if the registered code may make network requests. Default `false`. */
  readonly networkAccess?: boolean
}

/** A registered fn / cls / namespace can either be **host-bound**
 *  (the embedder hands us a live JS reference and the runtime
 *  bridges calls to it) or **URL-shipped** (the embedder hands us
 *  a module URL and the runtime imports it into the worker realm
 *  for the agent to use natively).
 *
 *  Mutual exclusivity: exactly one of the bound-value field
 *  (`fn` / `cls` / `target`) and `url` is present. The
 *  `PolicyBuilder.registerX` methods enforce this at registration
 *  time. Per-method visibility filters (`include` / `exclude` /
 *  `configure`) only apply to host-bound registrations — URL
 *  modules are exposed whole, no per-export gating (the entire
 *  module is in the worker realm; runtime filtering would be
 *  enforcement-by-not-exposing rather than real isolation).
 *
 *  See agex-runtime-worker for the configure-time URL handling
 *  that ships these specs to the worker for `await import(url)`. */

export interface RegisteredFn extends RegistrationCommon {
  readonly kind: 'fn'
  readonly name: string
  /** Host-bound: the live function the bridge calls. Mutually
   *  exclusive with `url`. */
  readonly fn?: (...args: unknown[]) => unknown | Promise<unknown>
  /** URL-shipped: the worker imports this module and pulls
   *  `mod[export ?? name]` into the agent's scope under `name`.
   *  Mutually exclusive with `fn`. */
  readonly url?: string
  /** Named export to pluck from the URL-shipped module. Defaults
   *  to the registration `name` for fn / cls (e.g. `agent.fn({
   *  url: '/m.js' }, { name: 'compute' })` looks up `mod.compute`).
   *  Pass `'default'` for default-exported modules. Ignored when
   *  `url` is absent. */
  readonly export?: string
  /** Optional Standard Schema for runtime parameter validation
   *  (host-bound only — URL-shipped fns are agent-callable
   *  natively in the worker realm). */
  readonly paramsSchema?: StandardSchemaV1
  /** When true, the framework appends a `HostFnContext` as the
   *  trailing positional argument when invoking the handler. The
   *  context exposes `console` (routes through the same image-aware
   *  pipeline as agent code's `console.log`) and `signal` (fires on
   *  task cancellation). Host-bound only — combining with `url` is
   *  rejected at registration. */
  readonly wantsContext?: boolean
}

/** Filter spec for class/namespace member visibility. A function returns
 *  true to include; a string is treated as a glob (single segment, no `**`). */
export type MemberFilter = string | ReadonlyArray<string> | ((name: string) => boolean)

/** Per-member configuration (description override, schema, etc.). */
export interface MemberConfig extends RegistrationCommon {}

export interface RegisteredCls extends RegistrationCommon {
  readonly kind: 'cls'
  readonly name: string
  /** Host-bound: live constructor the bridge constructs through.
   *  Mutually exclusive with `url`. */
  readonly cls?: new (
    ...args: unknown[]
  ) => unknown
  /** URL-shipped: worker imports the module and pulls
   *  `mod[export ?? name]` into the agent's scope under `name`.
   *  Mutually exclusive with `cls`. The agent gets the real class
   *  (subclass-able, `instanceof` works natively, no per-call RPC). */
  readonly url?: string
  /** Named export to pluck from the URL-shipped module. Defaults
   *  to the registration `name`; pass `'default'` for default
   *  exports. Ignored when `url` is absent. */
  readonly export?: string
  readonly constructable?: boolean
  /** Per-method visibility filters apply to host-bound classes
   *  only. URL-shipped classes are exposed whole. Combining `url`
   *  with these throws `RegistrationError` at registration time. */
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
}

/** A namespace exposes the visible members of `target` to the agent
 *  under the registered name. The runtime decides how to bridge
 *  method calls — same-realm runtimes call directly, the worker
 *  runtime routes each call back to the host. From the agent's
 *  perspective the surface is the same: `name.method(args)`. */
export interface RegisteredNs extends RegistrationCommon {
  readonly kind: 'namespace'
  readonly name: string
  /** Host-bound: live object whose visible members the bridge
   *  exposes. Mutually exclusive with `url`. */
  readonly target?: object
  /** URL-shipped: worker imports the module and exposes it under
   *  the registration `name`. Mutually exclusive with `target`.
   *  Default behavior (no `export` field) is to bind the **whole
   *  module namespace object** — same semantic as `import * as
   *  name from '...'`. With `export` set, pluck `mod[export]`
   *  instead. */
  readonly url?: string
  /** Named export to pluck from the URL-shipped module. When
   *  absent, the agent sees the whole module namespace object —
   *  this is the namespace-import default and differs from the
   *  fn / cls default of plucking by registration name. Pass
   *  `'default'` for default-exported modules, or any other
   *  named export string. Ignored when `url` is absent. */
  readonly export?: string
  readonly recursive?: boolean
  /** Per-member visibility filters apply to host-bound namespaces
   *  only. URL-shipped modules are exposed whole. */
  readonly include?: MemberFilter
  readonly exclude?: MemberFilter
  readonly configure?: Readonly<Record<string, MemberConfig>>
}

export interface RegisteredSkill {
  readonly kind: 'skill'
  readonly name: string
  /** Markdown content. */
  readonly content: string
}

/** A custom shell command surfaced through `terminal` emissions.
 *  Re-uses termish-ts's `CommandHandler` shape; the agent's shell
 *  pipeline executor merges these on top of termish-ts's builtins. */
export interface RegisteredTerminal extends RegistrationCommon {
  readonly kind: 'terminal'
  readonly name: string
  readonly handler: TerminalCommandHandler
}

/** A termish-ts-compatible command handler. We re-declare the shape
 *  here rather than importing the full termish-ts types so the type
 *  module's surface stays small. */
export type TerminalCommandHandler = (ctx: {
  readonly args: ReadonlyArray<string>
  readonly stdin: string
  readonly stdout: { write(s: string): void }
  readonly fs: VirtualFileSystem
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  // biome-ignore lint/suspicious/noConfusingVoidType: matches termish-ts's CommandHandler signature so handlers with no return statement type-check.
}) => Promise<{ exitCode: number; stderr: string } | undefined | void>

/** The complete registration table. Built incrementally by
 *  `agent.fn` / `.cls` / `.namespace` / `.skill` / `.terminal`. */
export interface Policy {
  readonly fns: ReadonlyMap<string, RegisteredFn>
  readonly classes: ReadonlyMap<string, RegisteredCls>
  readonly namespaces: ReadonlyMap<string, RegisteredNs>
  readonly skills: ReadonlyMap<string, RegisteredSkill>
  readonly terminals: ReadonlyMap<string, RegisteredTerminal>
}

// ---------------------------------------------------------------------------
// Persistence APIs (host-side)
// ---------------------------------------------------------------------------

export interface Cache {
  set<T>(key: string, value: T): Promise<void>
  get<T = unknown>(key: string): Promise<T | undefined>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<boolean>
  keys(): Promise<ReadonlyArray<string>>
}

export interface EventLog {
  /** Append an event. Returns the state key it was written to. */
  add(event: AgentEvent): Promise<string>
  /** Iterate events in chronological order. */
  iter(): AsyncIterable<AgentEvent>
  /** Read-only view at a historical commit hash. Returns `null` if
   *  the underlying state isn't versioned. */
  at(commitHash: string): Promise<EventLog | null>
}

// ---------------------------------------------------------------------------
// State / FS configuration
// ---------------------------------------------------------------------------

/** How the agent's state is persisted. `versioned` uses kvgit-ts;
 *  `live` uses the in-process `Live` map. */
export type StateConfig =
  | { readonly type: 'live' }
  | {
      readonly type: 'versioned'
      readonly storage: 'memory' | 'indexeddb' | 'sqlite'
      /** Required for `storage: 'sqlite'`; ignored otherwise. */
      readonly path?: string
    }

/** How the agent's virtual filesystem is backed. `memory` uses
 *  termish-ts's `MemoryFS`; `kvgit` shares the agent's state. */
export type FSConfig = { readonly type: 'memory' } | { readonly type: 'kvgit' }
