/**
 * Types as a model reads them, and JSON Schema as a type.
 *
 * A task's types are Standard Schemas (zod, valibot, arktype). The
 * model is never shown a schema: it is shown TypeScript, rendered from
 * the schema's JSON Schema ({@link typeText}, {@link declarations}), so
 * agent code builds values from declarations it already knows how to
 * read.
 *
 * {@link fromJsonSchema} goes the other way, for a type written as a
 * JSON Schema literal (the shape corpus's form, and agent code's own):
 * a Standard Schema that checks a value against it, strictly, and gives
 * the schema back as its JSON Schema. It covers what a task's types
 * use: `type`, `properties`, `required`, `additionalProperties`,
 * `items`, `anyOf`/`oneOf`, `enum`, `const`, `$ref` into `$defs`, and
 * `x-kind: 'bytes'` for a `Uint8Array`.
 */

import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

type Json = Readonly<Record<string, unknown>>

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

/** The definitions a schema's `$ref`s name: `$defs` (or the older
 *  `definitions`). */
export function defsOf(schema: unknown): Readonly<Record<string, Json>> {
  if (!isObject(schema)) return {}
  const defs = (schema.$defs ?? schema.definitions) as unknown
  return isObject(defs) ? (defs as Record<string, Json>) : {}
}

/** The definition a `$ref` names, by its last segment. */
export function refName(schema: unknown): string | null {
  const ref = isObject(schema) ? schema.$ref : undefined
  return typeof ref === 'string' ? (ref.split('/').at(-1) ?? null) : null
}

// ---------------------------------------------------------------------------
// TypeScript, as the model reads a type
// ---------------------------------------------------------------------------

const literal = (v: unknown): string => JSON.stringify(v)

/** `schema` as a TypeScript type: a definition by its name, the rest
 *  written out. */
export function typeText(schema: unknown): string {
  if (schema === true || (isObject(schema) && Object.keys(schema).length === 0)) return 'unknown'
  if (!isObject(schema)) return 'never'
  const name = refName(schema)
  if (name !== null) return name
  if (schema['x-kind'] === 'bytes') return 'Uint8Array'
  if ('const' in schema) return literal(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ')
  const members = (schema.anyOf ?? schema.oneOf) as unknown
  if (Array.isArray(members)) return [...new Set(members.map(typeText))].join(' | ')
  const type = schema.type
  if (Array.isArray(type)) {
    return type.map((t) => typeText({ ...schema, type: t })).join(' | ')
  }
  switch (type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = typeText(schema.items ?? {})
      return isUnion(item) ? `(${item})[]` : `${item}[]`
    }
    case 'object':
      return objectText(schema, null)
    default:
      return 'unknown'
  }
}

/** Whether a type is a union at its top level (`A | B`, not
 *  `{ a: A | B }`), so an array of it needs parentheses. */
function isUnion(type: string): boolean {
  let depth = 0
  for (const c of type) {
    if (c === '{' || c === '(' || c === '<' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === '>' || c === ']') depth -= 1
    else if (c === '|' && depth === 0) return true
  }
  return false
}

/** An object type: on one line (`indent` null), or a property a line,
 *  each with its description. */
function objectText(schema: Json, indent: string | null): string {
  const props = isObject(schema.properties) ? schema.properties : null
  const extra = schema.additionalProperties
  if (props === null || Object.keys(props).length === 0) {
    return isObject(extra) || extra === true || extra === undefined
      ? `Record<string, ${typeText(isObject(extra) ? extra : {})}>`
      : '{}'
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const fields = Object.entries(props).map(([key, prop]) => {
    const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)
    return { prop, field: `${name}${required.has(key) ? '' : '?'}: ${typeText(prop)}` }
  })
  if (indent === null) return `{ ${fields.map((f) => f.field).join('; ')} }`
  const inner = `${indent}  `
  const lines = fields.map(({ prop, field }) => {
    const doc = isObject(prop) && typeof prop.description === 'string' ? prop.description : ''
    return `${doc === '' ? '' : `${inner}/** ${doc} */\n`}${inner}${field}`
  })
  return `{\n${lines.join('\n')}\n${indent}}`
}

/** The definitions `schemas` name, at any depth, as TypeScript type
 *  declarations, each with its description; definitions are looked up
 *  in `defs`. */
export function declarations(
  schemas: readonly unknown[],
  defs: Readonly<Record<string, Json>>,
): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isObject(value)) return
    const name = refName(value)
    if (name !== null && !seen.has(name) && defs[name] !== undefined) {
      seen.add(name)
      visit(defs[name])
      order.push(name)
    }
    for (const [key, item] of Object.entries(value)) if (key !== '$defs') visit(item)
  }
  visit(schemas)
  return order.map((name) => {
    const def = defs[name] as Json
    const doc = typeof def.description === 'string' ? `/** ${def.description} */\n` : ''
    const body = def.type === 'object' ? objectText(def, '') : typeText(def)
    return `${doc}type ${name} = ${body}`
  })
}

// ---------------------------------------------------------------------------
// JSON Schema as a Standard Schema
// ---------------------------------------------------------------------------

type Path = (string | number)[]
type Issue = { message: string; path: Path }

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof Uint8Array) return 'bytes'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

const WANTED: Readonly<Record<string, string>> = {
  string: 'a string',
  integer: 'an integer',
  number: 'a number',
  boolean: 'a boolean',
  null: 'null',
  array: 'an array',
  object: 'an object',
}

function typeFits(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isObject(value)
    default:
      return true
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Every way `value` doesn't fit `schema`, at `path`. */
function issues(
  schema: unknown,
  value: unknown,
  path: Path,
  defs: Readonly<Record<string, Json>>,
): Issue[] {
  if (schema === true || schema === undefined) return []
  if (schema === false) return [{ message: 'nothing fits here', path }]
  if (!isObject(schema)) return []
  const name = refName(schema)
  if (name !== null) {
    const def = defs[name]
    if (def === undefined) return [{ message: `no definition named ${name}`, path }]
    return issues(def, value, path, defs)
  }
  const kind = schema['x-kind']
  if (kind === 'bytes') {
    return value instanceof Uint8Array
      ? []
      : [{ message: `expected bytes, got ${kindOf(value)}`, path }]
  }
  if (kind === 'live') return []
  const members = (schema.anyOf ?? schema.oneOf) as unknown
  if (Array.isArray(members)) {
    const each = members.map((m) => issues(m, value, path, defs))
    const fits = each.filter((found) => found.length === 0).length
    if (fits > 1 && schema.anyOf === undefined) {
      return [{ message: 'fits more than one of its types, where oneOf takes exactly one', path }]
    }
    if (fits > 0) return []
    // the member that got furthest says what's wrong
    const deepest = each.reduce((a, b) =>
      Math.max(...b.map((i) => i.path.length)) > Math.max(...a.map((i) => i.path.length)) ? b : a,
    )
    return deepest.some((i) => i.path.length > path.length)
      ? deepest
      : [{ message: `expected ${members.map(typeText).join(' | ')}, got ${kindOf(value)}`, path }]
  }
  if ('const' in schema && !same(schema.const, value)) {
    return [{ message: `expected ${literal(schema.const)}`, path }]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => same(v, value))) {
    return [{ message: `expected one of ${schema.enum.map(literal).join(', ')}`, path }]
  }
  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : typeof schema.type === 'string'
      ? [schema.type]
      : []
  if (types.length > 0 && !types.some((t) => typeFits(t, value))) {
    const wanted = types.map((t) => WANTED[t] ?? t).join(' or ')
    return [{ message: `expected ${wanted}, got ${kindOf(value)}`, path }]
  }
  const found: Issue[] = []
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => found.push(...issues(schema.items, item, [...path, i], defs)))
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {}
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in value) || value[key] === undefined) {
        found.push({ message: `is missing ${literal(key)}`, path })
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in props) found.push(...issues(props[key], item, [...path, key], defs))
      else if (schema.additionalProperties === false) {
        found.push({ message: `has no field ${literal(key)}`, path })
      } else if (isObject(schema.additionalProperties)) {
        found.push(...issues(schema.additionalProperties, item, [...path, key], defs))
      }
    }
  }
  return found
}

/** A JSON Schema with its Standard Schema: `fromJsonSchema`'s. */
export type JsonSchemaType<T = unknown> = StandardSchemaV1<T> &
  StandardJSONSchemaV1<T> & {
    readonly schema: Json
  }

/**
 * A Standard Schema checking a value against `schema`, a JSON Schema
 * literal, strictly (no coercion); its JSON Schema is `schema` itself.
 * `$ref`s resolve in `schema`'s own `$defs`, or in `defs`.
 */
export function fromJsonSchema<T = unknown>(
  schema: Json | boolean,
  defs: Readonly<Record<string, Json>> = {},
): JsonSchemaType<T> {
  const root: Json = typeof schema === 'boolean' ? (schema ? {} : { not: {} }) : schema
  const all = { ...defs, ...defsOf(root) }
  const withDefs: Json = Object.keys(all).length === 0 ? root : { ...root, $defs: all }
  return {
    schema: withDefs,
    '~standard': {
      version: 1,
      vendor: 'agex',
      validate(value: unknown): StandardSchemaV1.Result<T> {
        const found =
          schema === false
            ? [{ message: 'nothing fits here', path: [] }]
            : issues(root, value, [], all)
        return found.length === 0 ? { value: value as T } : { issues: found }
      },
      jsonSchema: {
        input: () => ({ ...withDefs }),
        output: () => ({ ...withDefs }),
      },
    },
  } as JsonSchemaType<T>
}
