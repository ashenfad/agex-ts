import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { jsonSchemaToStandard } from '../src/json-schema'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'

const objSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name'],
}

type Issue = { message: string; path?: ReadonlyArray<PropertyKey> }

async function validate(schema: object, value: unknown) {
  return jsonSchemaToStandard(schema)['~standard'].validate(value)
}

describe('jsonSchemaToStandard', () => {
  it('passes a valid value through unchanged (same reference)', async () => {
    const value = { name: 'ada', age: 36 }
    const res = await validate(objSchema, value)
    expect('issues' in res).toBe(false)
    expect((res as { value: unknown }).value).toBe(value)
  })

  it('reports a type mismatch with a message and the path to it', async () => {
    const res = await validate(objSchema, { name: 42 })
    expect('issues' in res).toBe(true)
    const issues = (res as { issues: Issue[] }).issues
    const nameIssue = issues.find((i) => i.path?.[0] === 'name')
    expect(nameIssue).toBeDefined()
    expect(nameIssue?.message).toMatch(/string/i)
  })

  it('reports a missing required property', async () => {
    const res = await validate(objSchema, { age: 1 })
    expect('issues' in res).toBe(true)
    expect((res as { issues: Issue[] }).issues.length).toBeGreaterThan(0)
  })

  it('maps array indices to numeric path segments', async () => {
    const res = await validate({ type: 'array', items: { type: 'string' } }, ['ok', 7])
    expect('issues' in res).toBe(true)
    const issues = (res as { issues: Issue[] }).issues
    expect(issues.some((i) => i.path?.includes(1))).toBe(true)
  })

  it('collects all violations rather than stopping at the first', async () => {
    const res = await validate(objSchema, { name: 1, age: 'x' })
    const issues = (res as { issues: Issue[] }).issues
    // Both the `name` and `age` type errors surface (plus possibly a
    // parent `properties` error) — shortCircuit is off.
    expect(issues.some((i) => i.path?.[0] === 'name')).toBe(true)
    expect(issues.some((i) => i.path?.[0] === 'age')).toBe(true)
  })

  it('roots an error at an empty path (no `path` key)', async () => {
    const res = await validate({ type: 'string' }, 123)
    const issues = (res as { issues: Issue[] }).issues
    expect(issues.some((i) => i.path === undefined)).toBe(true)
  })

  // The reason the util exists: feed an agent-supplied JSON Schema object
  // into the task loop's StandardSchema output validation. With PR 1, a
  // mismatch is recoverable, so the agent retries — this is the exact
  // path spawn clones will use once `output` is wired (PR 4).
  it('works as a task output schema and drives the recoverable retry', async () => {
    const llm = new Dummy({
      responses: [
        { emissions: [{ type: 'ts', code: 'taskSuccess({ age: 1 })' }] }, // missing `name` → recover
        { emissions: [{ type: 'ts', code: 'taskSuccess({ name: "ada" })' }] }, // valid → success
      ],
    })
    const agent = await createAgent({ name: 'T', llm, runtime: evalRuntime() })
    const fn = agent.task<undefined, { name: string }>({
      description: 'Return an object with a name.',
      output: jsonSchemaToStandard({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      }),
    })
    expect(await fn(undefined)).toEqual({ name: 'ada' })
    expect(llm.callCount).toBe(2)
  })
})
