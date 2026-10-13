/**
 * Values: data carried by value, between the host and the code in the
 * world's worker, and into storage; checked against a declared type.
 *
 * - **What crosses.** The worker's boundary carries data by structured
 *   clone. Something that can't be sent by value (a function, an
 *   instance of a class, a promise) is refused where it would cross,
 *   naming where it is ({@link findLive}): a class's instance would
 *   arrive as a plain object, its methods gone.
 * - **What is stored.** {@link encode} makes one blob of a value, on
 *   the world's CBOR codec, and {@link decode} reads it back. A stored
 *   value is data, bytes, typed arrays, `Map`, `Set`, `Date`, `RegExp`
 *   and bigints, as itself; what the encoding can't keep as itself (an
 *   `ArrayBuffer`, an error, a value holding itself) is refused rather
 *   than changed. `-0` is stored as `0`.
 * - **A declared type** is a Standard Schema (zod, valibot, arktype and
 *   the rest): {@link check} gives the value the schema's validation
 *   returns, or throws a {@link Mismatch} naming where it doesn't fit.
 *   How strict a check is, coercion and all, is the schema's choice.
 *
 * Decoding never runs code: unlike Python's pickle, CBOR builds only
 * data, so decoding needs no declared type to be safe. A type given to
 * {@link check} after decoding is what makes a value the shape its
 * reader expects.
 */

import { cborCodec } from '@agex-ts/kvgit'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { describe, inspect, segment, whereOf } from './inspect'

export { findLive } from './inspect'

/** The encoding's name and version, at the head of every blob. */
export const VALUE_FORMAT = 'world-value/1'

const MAGIC = new TextEncoder().encode(`${VALUE_FORMAT}\n`)

/** A value that doesn't fit its declared type. `where` is the path to
 *  the part that doesn't (`scores[3].total`), empty at the top. */
export class Mismatch extends TypeError {
  override readonly name: string = 'Mismatch'
  constructor(
    readonly detail: string,
    readonly where = '',
    /** Every issue the schema reported; the message shows the first. */
    readonly issues: readonly StandardSchemaV1.Issue[] = [],
  ) {
    super(where === '' ? detail : `at ${where}: ${detail}`)
  }
}

/** A value with no encoding: a live part, or one the encoding wouldn't
 *  keep as itself. */
export class Unencodable extends TypeError {
  override readonly name: string = 'Unencodable'
}

/** An encoding over the size it was allowed. */
export class TooLarge extends RangeError {
  override readonly name: string = 'TooLarge'
}

/** Bytes that are not an encoded value. */
export class Malformed extends Error {
  override readonly name: string = 'Malformed'
}

/**
 * One blob of `value`: the format's name, then the value in CBOR.
 *
 * @throws Unencodable when it holds a live part, or one the encoding
 *   doesn't keep as itself.
 * @throws TooLarge past `limit` bytes.
 */
export function encode(value: unknown, opts: { limit?: number } = {}): Uint8Array {
  storable(value)
  const body = cborCodec.encode(value)
  const out = new Uint8Array(MAGIC.length + body.length)
  out.set(MAGIC)
  out.set(body, MAGIC.length)
  if (opts.limit !== undefined && out.length > opts.limit) {
    throw new TooLarge(`the value encodes to ${out.length} bytes, over ${opts.limit}`)
  }
  return out
}

/**
 * The value `bytes` holds, as {@link encode} made it. Check it against
 * its declared type with {@link check}.
 *
 * @throws Malformed for bytes that aren't an encoded value.
 */
export function decode(bytes: Uint8Array): unknown {
  if (bytes.length < MAGIC.length || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Malformed(`not an encoded value (expected ${VALUE_FORMAT})`)
  }
  try {
    return cborCodec.decode(bytes.subarray(MAGIC.length))
  } catch (e) {
    throw new Malformed(`a damaged value: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * A copy of `value` that can be changed without reaching the original,
 * holding what a stored value would: the same refusals as
 * {@link encode}.
 */
export function copy<T>(value: T): T {
  storable(value)
  return structuredClone(value)
}

/** Refuse a value the encoding can't keep as itself. */
export function storable(value: unknown): void {
  const found = inspect(value, 'store')
  if (found !== null) throw new Unencodable(`can't be stored: ${describe(found)}`)
}

/**
 * `value` checked against `schema`: what the schema's validation gives
 * back (its output, which a schema that transforms makes anew).
 *
 * @throws Mismatch naming where it doesn't fit, with the first issue's
 *   message.
 */
export async function check<S extends StandardSchemaV1>(
  value: unknown,
  schema: S,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await standard(schema).validate(value)
  if (result.issues === undefined) return result.value as StandardSchemaV1.InferOutput<S>
  const first = result.issues[0]
  const more = result.issues.length > 1 ? ` (and ${result.issues.length - 1} more)` : ''
  throw new Mismatch(
    `${first?.message ?? 'does not fit'}${more}`,
    whereOf((first?.path ?? []).map((p) => segment(typeof p === 'object' ? p.key : p))),
    result.issues,
  )
}

/**
 * The JSON Schema of what `schema` takes (`io: 'input'`, the default)
 * or gives, for showing a model what a value should be; null when the
 * schema's library doesn't make one (Standard JSON Schema), or can't
 * for this schema.
 */
export function jsonSchemaOf(
  schema: StandardSchemaV1,
  opts: { io?: 'input' | 'output'; target?: StandardJSONSchemaV1.Target } = {},
): Record<string, unknown> | null {
  const props = schema['~standard'] as Partial<StandardJSONSchemaV1.Props> | undefined
  const convert = props?.jsonSchema
  if (convert === undefined) return null
  try {
    return convert[opts.io ?? 'input']({ target: opts.target ?? 'draft-2020-12' })
  } catch {
    return null
  }
}

/** Whether `value` is a Standard Schema. */
export function isSchema(value: unknown): value is StandardSchemaV1 {
  const props = (value as Partial<StandardSchemaV1> | null)?.['~standard']
  return typeof props === 'object' && props !== null && typeof props.validate === 'function'
}

function standard(schema: StandardSchemaV1): StandardSchemaV1.Props {
  if (!isSchema(schema)) throw new TypeError('not a Standard Schema (no ~standard.validate)')
  return schema['~standard']
}
