/**
 * `safeStringify` — convert any console.log-style argument into a
 * string the agent can read, without throwing on the things naive
 * `JSON.stringify` chokes on:
 *
 *   - `undefined` (JSON.stringify returns `undefined`, not the string)
 *   - `bigint` (throws)
 *   - `symbol` (throws)
 *   - functions (become `undefined`)
 *   - `Error` instances (serialize to `{}`)
 *   - circular references (throws "Converting circular structure")
 *
 * Plus per-call char-budget truncation with a trailing
 * `… [N more chars]` marker, so a single `console.log(hugeBuf)`
 * doesn't blow out the agent's context window.
 *
 * This is the agex-ts equivalent of agex-py's `reprobate`-driven
 * print rendering, deliberately scaled down: simple-but-safe is
 * enough for typical TS console output. If we need richer
 * structural truncation later (large arrays inside small objects,
 * etc.), promote to a dedicated module.
 */

const DEFAULT_MAX_CHARS = 4_000

export interface SafeStringifyOptions {
  /** Per-arg character budget. Default 4000. */
  readonly maxChars?: number
}

export function safeStringify(value: unknown, opts: SafeStringifyOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const raw = renderValue(value)
  return truncate(raw, maxChars)
}

/** Render an array of console.log-style args to a single line, with
 *  args joined by single spaces (matches `console.log` convention).
 *  Each arg is budget-truncated independently so one giant arg
 *  doesn't starve later ones. */
export function safeStringifyArgs(
  args: ReadonlyArray<unknown>,
  opts: SafeStringifyOptions = {},
): string {
  return args.map((a) => safeStringify(a, opts)).join(' ')
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Top-level rendering — mirrors `console.log` conventions: strings
 *  are unquoted at the top, primitives stringify naturally, objects
 *  use a JSON-ish form via `safeJsonStringify`. */
function renderValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') {
    const name = (value as { name?: string }).name
    return `[Function${name ? `: ${name}` : ''}]`
  }
  if (value instanceof Error) {
    const stack = value.stack ?? `${value.name}: ${value.message}`
    return stack
  }
  // Object / Array — fall through to JSON-with-replacer
  return safeJsonStringify(value)
}

/** JSON.stringify with safe handling of the same fringe cases —
 *  used both for top-level objects and for nested values inside
 *  objects/arrays. */
function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, v) => sanitizeForJson(v, seen)) ?? 'undefined'
  } catch (e) {
    return `[unserializable: ${e instanceof Error ? e.message : String(e)}]`
  }
}

function sanitizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return '<undefined>'
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') {
    const name = (value as { name?: string }).name
    return `[Function${name ? `: ${name}` : ''}]`
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
  }
  return value
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  const head = s.slice(0, maxChars)
  const dropped = s.length - maxChars
  return `${head}… [truncated, ${dropped} more chars]`
}
