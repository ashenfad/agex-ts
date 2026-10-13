/**
 * Looking inside a value for what can't be carried by value: what
 * {@link findLive} reports at the worker's boundary and `encode`
 * refuses to store. Imports nothing, so the worker can use it.
 */

/** What crossing needs: `cross` is the worker's boundary (structured
 *  clone); `store` is an encoding, which keeps less as itself. */
export type Carry = 'cross' | 'store'

/** Where a value holds something it can't carry, and what. */
export interface Found {
  /** Path segments from the top: `[0]`, `.name`, `["a key"]`. */
  readonly path: string[]
  readonly detail: string
}

/** A found part as text: `at [0].client: a live Client`, or just the
 *  detail at the top. */
export function describe(found: Found): string {
  const where = whereOf(found.path)
  return where === '' ? found.detail : `at ${where}: ${found.detail}`
}

/** A path as text, without a leading dot: `scores[3].total`. */
export function whereOf(path: readonly string[]): string {
  return path.join('').replace(/^\./, '')
}

/** A key as a path segment. */
export function segment(key: PropertyKey): string {
  if (typeof key === 'number') return `[${key}]`
  if (typeof key === 'string') {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
  }
  return `[${String(key)}]`
}

/**
 * Where `value` holds something that can't be sent by value (`at
 * [0].client: a live Client`), or null when it holds nothing of the
 * kind. Data is not live: primitives, plain objects and arrays, `Map`,
 * `Set`, `Date`, `RegExp`, bytes and typed arrays, `ArrayBuffer`,
 * errors and blobs. A function is, as is an instance of any class
 * (its methods would be lost, and its private state with them), a
 * promise, a symbol, or a getter; and shared memory (a
 * `SharedArrayBuffer`, or a view over one) can't be sent by value at
 * all. An array is looked at whole: its items, and any other property
 * it has.
 */
export function findLive(value: unknown): string | null {
  const found = inspect(value, 'cross')
  return found === null ? null : describe(found)
}

/** The first part of `value` that can't be carried for `carry`, or
 *  null. */
export function inspect(value: unknown, carry: Carry): Found | null {
  try {
    return walk(value, carry, new Set(), new Set())
  } catch (e) {
    if (e instanceof RangeError) return { path: [], detail: 'a value nested too deeply' }
    throw e
  }
}

const TYPED_ARRAYS = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
])

const ERRORS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

/** Built-ins the worker's boundary carries but a stored value can't
 *  keep as themselves, with what to do instead. */
const CROSS_ONLY: Record<string, string> = {
  ArrayBuffer: 'store a Uint8Array',
  DataView: 'store a Uint8Array',
  Float16Array: 'store a Float32Array',
  Blob: 'store its bytes',
  File: 'store its bytes',
  Boolean: 'store the primitive',
  Number: 'store the primitive',
  String: 'store the primitive',
  BigInt: 'store the primitive',
}

function walk(v: unknown, carry: Carry, seen: Set<object>, open: Set<object>): Found | null {
  switch (typeof v) {
    case 'function':
      return { path: [], detail: 'a live function' }
    case 'symbol':
      return { path: [], detail: 'a symbol' }
    case 'object':
      break
    default:
      return null
  }
  if (v === null) return null
  if (open.has(v)) {
    return carry === 'store'
      ? { path: [], detail: 'the value again: a value holding itself' }
      : null
  }
  if (seen.has(v)) return null
  seen.add(v)
  open.add(v)
  try {
    return walkObject(v, carry, seen, open)
  } finally {
    open.delete(v)
  }
}

function walkObject(v: object, carry: Carry, seen: Set<object>, open: Set<object>): Found | null {
  const proto = Object.getPrototypeOf(v) as object | null
  const name = proto === null ? null : constructorName(proto)
  const tag = Object.prototype.toString.call(v).slice(8, -1)

  if (proto === null || (name === 'Object' && Object.getPrototypeOf(proto) === null)) {
    return walkKeys(v, false, carry, seen, open)
  }
  if (Array.isArray(v) && name === 'Array') return walkKeys(v, true, carry, seen, open)
  // Shared memory crosses as the same memory, not a copy: the host and
  // the code would both write it.
  if (tag === 'SharedArrayBuffer') {
    return { path: [], detail: 'a SharedArrayBuffer: shared memory, not sent by value' }
  }
  if (ArrayBuffer.isView(v) && isShared(v.buffer)) {
    return {
      path: [],
      detail: `a ${tag} over a SharedArrayBuffer: shared memory, not sent by value`,
    }
  }
  if (name === 'Map' && tag === 'Map') {
    let i = 0
    for (const [key, item] of v as Map<unknown, unknown>) {
      const at =
        typeof key === 'string' || typeof key === 'number'
          ? `[${JSON.stringify(key)}]`
          : `<key ${i}>`
      const found = walk(key, carry, seen, open) ?? walk(item, carry, seen, open)
      if (found !== null) return inside(found, at)
      i++
    }
    return null
  }
  if (name === 'Set' && tag === 'Set') {
    let i = 0
    for (const item of v as Set<unknown>) {
      const found = walk(item, carry, seen, open)
      if (found !== null) return inside(found, `<item ${i}>`)
      i++
    }
    return null
  }
  if (name === tag && (tag === 'Date' || tag === 'RegExp' || TYPED_ARRAYS.has(tag))) return null
  if (name === 'Buffer' && tag === 'Uint8Array') return null
  if (name !== null && name === tag && name in CROSS_ONLY) {
    return carry === 'cross'
      ? null
      : {
          path: [],
          detail: `${article(name)} ${name}, which isn't stored as itself (${CROSS_ONLY[name]})`,
        }
  }
  if (tag === 'Error' && name !== null && ERRORS.has(name)) {
    return carry === 'cross'
      ? null
      : { path: [], detail: `${article(name)} ${name}, which isn't stored as itself` }
  }
  return { path: [], detail: `a live ${name ?? tag}` }
}

/** A plain object's or an array's own properties: an array's items,
 *  and any other property it has, which structured clone carries and
 *  the encoding drops. */
function walkKeys(
  v: object,
  array: boolean,
  carry: Carry,
  seen: Set<object>,
  open: Set<object>,
): Found | null {
  for (const key of Reflect.ownKeys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, key)
    if (desc === undefined || !desc.enumerable) continue
    if (typeof key === 'symbol') {
      return { path: [], detail: `a symbol key (${String(key)}), which doesn't cross` }
    }
    const index = array && isIndex(key)
    const at = index ? `[${key}]` : segment(key)
    if (desc.get !== undefined || desc.set !== undefined) {
      return { path: [at], detail: 'a live getter' }
    }
    if (carry === 'store' && array && !index) {
      return {
        path: [],
        detail: `an array with a property ${JSON.stringify(key)}, which isn't stored`,
      }
    }
    if (carry === 'store' && key === '__proto__') {
      return { path: [], detail: "a key named __proto__, which isn't stored as itself" }
    }
    const found = walk(desc.value, carry, seen, open)
    if (found !== null) return inside(found, at)
  }
  return null
}

/** An array index, as a property key: a canonical integer below 2^32 - 1. */
function isIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4_294_967_295
}

function isShared(buffer: unknown): boolean {
  return Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]'
}

function inside(found: Found, at: string): Found {
  return { path: [at, ...found.path], detail: found.detail }
}

function article(name: string): string {
  return /^[AEIOU]/.test(name) ? 'an' : 'a'
}

/** A prototype's constructor's name, read without running a getter. */
function constructorName(proto: object): string | null {
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value as unknown
  return typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name !== ''
    ? ctor.name
    : null
}
