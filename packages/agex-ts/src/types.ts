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
  TaskClarifyError,
  TaskFailError,
  TransientError,
  type BrandedTaskError,
} from './errors'

/** The agent's host-side virtual filesystem — same protocol as the
 *  termish-ts `FileSystem`. Re-exported so consumers can implement it
 *  without depending on termish-ts directly. */
export type VirtualFileSystem = FileSystem

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

export type OutputPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly format: ImageFormat
      /** Base64-encoded bytes. */
      readonly data: string
      readonly altText?: string
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

export interface ClarifyEvent extends EventBase {
  readonly type: 'clarify'
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
  | ClarifyEvent
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
  | { readonly kind: 'clarify'; readonly message: string }
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

export interface RuntimeAdapter {
  /** One-time initialization. Called when the agent first runs a task.
   *  Receives the registration policy so the adapter can configure
   *  module resolution. */
  init(policy: Policy): Promise<void>
  /** Run a single `ts` emission. */
  execute(code: string, ctx: ExecuteContext): Promise<ExecResult>
  /** Release resources. Called when the agent is disposed. */
  dispose(): Promise<void>
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

export interface RegisteredFn extends RegistrationCommon {
  readonly kind: 'fn'
  readonly name: string
  readonly fn: (...args: unknown[]) => unknown | Promise<unknown>
  /** Optional Standard Schema for runtime parameter validation. */
  readonly paramsSchema?: StandardSchemaV1
}

/** Filter spec for class/namespace member visibility. A function returns
 *  true to include; a string is treated as a glob (single segment, no `**`). */
export type MemberFilter = string | ReadonlyArray<string> | ((name: string) => boolean)

/** Per-member configuration (description override, schema, etc.). */
export interface MemberConfig extends RegistrationCommon {}

export interface RegisteredCls extends RegistrationCommon {
  readonly kind: 'cls'
  readonly name: string
  readonly cls: new (...args: unknown[]) => unknown
  readonly constructable?: boolean
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
  readonly target: object
  readonly recursive?: boolean
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
