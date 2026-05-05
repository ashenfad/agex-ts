/**
 * Best-effort JSON Schema extraction from a Standard Schema.
 *
 * Standard Schema 1.0 deliberately doesn't standardize shape
 * introspection across validators — only `validate` + phantom
 * type slots. But each major validator exposes its own way to
 * derive a JSON Schema:
 *
 *   - zod 3.25+: `schema.toJSONSchema()` per schema
 *   - arktype: `schema.json` property
 *   - valibot: needs `@valibot/to-json-schema` (we don't auto-pull
 *     it; users supply `inputJsonSchema` / `outputJsonSchema` if
 *     they need valibot)
 *
 * This helper sniffs the most common method names and returns
 * whatever it gets. If nothing matches, returns `null` and the
 * renderer falls back to the user's `inputDescription` /
 * `outputDescription` prose, or the generic "any value matching
 * the task description" fallback.
 *
 * Users with bespoke validators or who want strict control over
 * what the agent sees can supply `inputJsonSchema` /
 * `outputJsonSchema` overrides on `TaskDefinition` — those win
 * over auto-extraction.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'

/** Try to derive a JSON Schema-shaped object from a Standard Schema.
 *  Returns `null` if no recognized introspection method is exposed. */
export function extractJsonSchema(schema: StandardSchemaV1): object | null {
  const s = schema as unknown as Record<string, unknown>
  if (typeof s.toJSONSchema === 'function') {
    try {
      const out = (s.toJSONSchema as () => unknown)()
      if (out !== null && typeof out === 'object') return out as object
    } catch {
      // Schema lib threw during introspection — bail to fallback
    }
  }
  if (typeof s.toJsonSchema === 'function') {
    try {
      const out = (s.toJsonSchema as () => unknown)()
      if (out !== null && typeof out === 'object') return out as object
    } catch {
      // ignore
    }
  }
  if (typeof s.json === 'object' && s.json !== null) return s.json as object
  return null
}

/** True if `schema` looks like a JSON Schema describing an object
 *  with discoverable top-level properties. Used by the task message
 *  builder to decide between per-field rendering (one line per
 *  field) and the single-blob fallback. */
export function hasObjectProperties(jsonSchema: object | null): boolean {
  if (jsonSchema === null) return false
  const s = jsonSchema as Record<string, unknown>
  return s.type === 'object' && typeof s.properties === 'object' && s.properties !== null
}

/** Pull the top-level property names from an object-shaped JSON Schema.
 *  Returns `[]` if the schema doesn't describe an object. */
export function objectPropertyNames(jsonSchema: object | null): string[] {
  if (!hasObjectProperties(jsonSchema)) return []
  const props = (jsonSchema as { properties: Record<string, unknown> }).properties
  return Object.keys(props)
}
