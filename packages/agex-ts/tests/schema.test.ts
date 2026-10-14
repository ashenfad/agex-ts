/** Types as a model reads them, and JSON Schema as a type. */

import { check } from '@agex-ts/world'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { declarations, fromJsonSchema, typeText } from '../src/index'

const defs = {
  Score: {
    type: 'object',
    properties: { student: { type: 'string' }, total: { type: 'integer' } },
    required: ['student', 'total'],
    additionalProperties: false,
  },
}

describe('fromJsonSchema', () => {
  const scores = fromJsonSchema({ type: 'array', items: { $ref: '#/$defs/Score' } }, defs)

  it('takes what fits, as it is', async () => {
    const value = [{ student: 'ada', total: 7 }]
    expect(await check(value, scores)).toBe(value)
  })

  it('names where a value does not fit', async () => {
    await expect(check([{ student: 'ada', total: 7.5 }], scores)).rejects.toThrow(
      'at [0].total: expected an integer, got a number',
    )
    await expect(check([{ student: 'ada' }], scores)).rejects.toThrow('at [0]: is missing "total"')
    await expect(check([{ student: 'ada', total: 1, more: 1 }], scores)).rejects.toThrow(
      'at [0]: has no field "more"',
    )
    await expect(check({}, scores)).rejects.toThrow('expected an array, got an object')
  })

  it('reads unions, enums, constants, nulls and bytes', async () => {
    const t = fromJsonSchema({
      type: 'object',
      properties: {
        grade: { enum: ['a', 'b'] },
        kind: { const: 'quiz' },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        blob: { 'x-kind': 'bytes' },
      },
    })
    expect(
      await check({ grade: 'a', kind: 'quiz', note: null, blob: new Uint8Array(1) }, t),
    ).toBeTruthy()
    await expect(check({ grade: 'c' }, t)).rejects.toThrow('at grade: expected one of "a", "b"')
    await expect(check({ note: 3 }, t)).rejects.toThrow(
      'at note: expected string | null, got an integer',
    )
    await expect(check({ blob: 'AA==' }, t)).rejects.toThrow(
      'at blob: expected bytes, got a string',
    )
  })

  it('takes oneOf as exactly one', async () => {
    const t = fromJsonSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] })
    expect(await check(1.5, t)).toBe(1.5)
    await expect(check(2, t)).rejects.toThrow(
      'fits more than one of its types, where oneOf takes exactly one',
    )
    const any = fromJsonSchema({ anyOf: [{ type: 'number' }, { type: 'integer' }] })
    expect(await check(2, any)).toBe(2)
  })

  it('gives its schema, with the definitions it names, as its JSON Schema', () => {
    expect(scores['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/Score' },
      $defs: defs,
    })
  })
})

describe('typeText and declarations', () => {
  it('write a schema as TypeScript', () => {
    expect(
      typeText({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }),
    ).toBe('(string | null)[]')
    expect(typeText({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'Record<string, number>',
    )
    expect(typeText({ type: 'object', properties: { a: { type: 'string' } }, required: [] })).toBe(
      '{ a?: string }',
    )
    expect(typeText({ $ref: '#/$defs/Score' })).toBe('Score')
    expect(typeText({})).toBe('unknown')
  })

  it('declare the definitions a type names, once each, dependencies first', () => {
    const all = {
      ...defs,
      Ranking: {
        type: 'object',
        properties: {
          best: { $ref: '#/$defs/Score' },
          rest: { type: 'array', items: { $ref: '#/$defs/Score' } },
        },
        required: ['best', 'rest'],
      },
    }
    expect(declarations([{ $ref: '#/$defs/Ranking' }], all)).toEqual([
      'type Score = {\n  student: string\n  total: number\n}',
      'type Ranking = {\n  best: Score\n  rest: Score[]\n}',
    ])
  })

  it('read zod’s own JSON Schema', () => {
    const json = z.toJSONSchema(
      z.object({ name: z.string(), tags: z.array(z.string()).optional() }),
    )
    expect(typeText(json)).toBe('{ name: string; tags?: string[] }')
  })
})
