/**
 * Compile a JSON Schema object into a Standard Schema validator.
 *
 * `spawn` (see `docs/roadmap/spawn.md`) lets an agent hand a plain JSON
 * Schema *object* as a sub-task's `output` contract — but the task loop
 * validates output through a `StandardSchemaV1` validator (`def.output`),
 * not a schema object. This bridges the two: wrap the object in a
 * `@cfworker/json-schema` `Validator` (lightweight and browser/worker-safe
 * — agex-ts is bundle-conscious) and expose it behind the Standard Schema
 * `~standard.validate` interface, so the existing enforce-and-retry path
 * (a mismatch is a recoverable error counted against `maxIterations`)
 * applies to spawn clones with no extra machinery.
 */

import { Validator } from '@cfworker/json-schema'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/** JSON Schema draft to validate against. Defaults to `2020-12` — the
 *  draft LLM-authored schemas most commonly target. For the bread-and-
 *  butter keywords agents reach for (`type` / `properties` / `required` /
 *  `items`) the drafts behave identically, so this rarely matters. */
export type JsonSchemaDraft = '4' | '7' | '2019-09' | '2020-12'

/** Parse a `@cfworker/json-schema` `instanceLocation` JSON pointer
 *  (`"#"`, `"#/name"`, `"#/items/0"`) into Standard Schema path segments.
 *  Numeric segments become numbers (array indices); the root pointer maps
 *  to an empty path. */
function pointerToPath(loc: string): PropertyKey[] {
  const body = loc.startsWith('#') ? loc.slice(1) : loc
  if (body === '' || body === '/') return []
  // Leading '' before the first '/' is dropped by the slice(1).
  return body
    .split('/')
    .slice(1)
    .map((seg) => {
      // JSON Pointer unescaping (RFC 6901): `~1` → `/`, `~0` → `~`. A single
      // pass keeps this order-independent — sequential `.replace` is only
      // correct in the `~1`-then-`~0` order, so the one-pass form removes
      // that footgun (e.g. `~01` → `~1`, never `/`).
      const key = seg.replace(/~([01])/g, (_, d) => (d === '1' ? '/' : '~'))
      return /^\d+$/.test(key) ? Number(key) : key
    })
}

/**
 * Wrap a JSON Schema object as a `StandardSchemaV1`. Validation succeeds
 * iff the value satisfies the schema; otherwise the returned issues carry
 * each error's message and the path to the offending location.
 *
 * The validator is non-transforming — output equals input on success — so
 * input and output share the same `T` (defaulting to `unknown`, since a
 * JSON Schema object carries no static type). `shortCircuit` is off so the
 * agent gets *all* violations at once rather than only the first.
 */
export function jsonSchemaToStandard<T = unknown>(
  schema: object,
  opts: { draft?: JsonSchemaDraft } = {},
): StandardSchemaV1<T, T> {
  // Cast: cfworker's `Schema` is the structural JSON-Schema shape; an
  // agent-supplied object is validated structurally at runtime anyway.
  const validator = new Validator(
    schema as ConstructorParameters<typeof Validator>[0],
    opts.draft ?? '2020-12',
    false,
  )
  return {
    '~standard': {
      version: 1,
      vendor: 'agex-ts',
      validate(value: unknown) {
        const result = validator.validate(value)
        if (result.valid) return { value: value as T }
        return {
          issues: result.errors.map((e) => {
            const path = pointerToPath(e.instanceLocation)
            return path.length > 0 ? { message: e.error, path } : { message: e.error }
          }),
        }
      },
    },
  }
}
