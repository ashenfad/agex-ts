import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { TaskFailError } from '../src/errors'
import { Dummy } from '../src/llm/dummy'
import type { NeutralTurn } from '../src/render'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, LLMResponse, TokenChunk } from '../src/types'

const r = (...emissions: LLMResponse['emissions']): LLMResponse => ({ emissions })

/** Pull (tool_use, tool_result) pairs out of a captured request so a
 *  test can assert what the LLM saw on its next turn. */
function toolUsesAndResults(turns: NeutralTurn[]): {
  toolUses: { id: string; tool: string }[]
  results: { id: string; text: string }[]
} {
  const toolUses: { id: string; tool: string }[] = []
  const results: { id: string; text: string }[] = []
  for (const turn of turns) {
    for (const p of turn.content) {
      if (p.type === 'toolUse') toolUses.push({ id: p.toolUseId, tool: p.toolName })
      else if (p.type === 'toolResult') {
        results.push({
          id: p.toolUseId,
          text: p.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'),
        })
      }
    }
  }
  return { toolUses, results }
}

async function makeAgent(responses: ReadonlyArray<LLMResponse | Error>) {
  const llm = new Dummy({ responses })
  const runtime = evalRuntime()
  const agent = await createAgent({ name: 'T', llm, runtime })
  return { agent, llm, runtime }
}

describe('task — single-turn success', () => {
  it('returns the value passed to taskSuccess', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(42)' })])
    const fn = agent.task<undefined, number>({ description: 'Return 42.' })
    const result = await fn(undefined)
    expect(result).toBe(42)
  })
})

describe('task — multi-turn success', () => {
  it('loops until taskSuccess fires', async () => {
    const { agent, llm } = await makeAgent([
      r({ type: 'ts', code: '/* think */' }), // continue
      r({ type: 'ts', code: '/* still thinking */' }), // continue
      r({ type: 'ts', code: 'taskSuccess("done")' }), // terminate
    ])
    const fn = agent.task<undefined, string>({ description: 'Eventually return.' })
    const result = await fn(undefined)
    expect(result).toBe('done')
    expect(llm.callCount).toBe(3)
  })
})

describe('task — taskFail', () => {
  it('rejects with TaskFailError on taskFail', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskFail("nope")' })])
    const fn = agent.task<undefined, void>({ description: 'Fail.' })
    await expect(fn(undefined)).rejects.toBeInstanceOf(TaskFailError)
  })
})

describe('task — event log', () => {
  it('writes TaskStartEvent, ActionEvent, SuccessEvent in order', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess("ok")' })])
    const fn = agent.task<undefined, string>({ description: 'Tiny.' })
    const onEvent: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void onEvent.push(e) })
    expect(onEvent.map((e) => e.type)).toEqual(['taskStart', 'action', 'success'])
    expect((onEvent[0] as { taskName: string }).taskName).toBe('Tiny.')
  })

  it('forwards every TokenChunk to onToken', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(1)' })])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    const tokens: TokenChunk[] = []
    await fn(undefined, { onToken: (t) => void tokens.push(t) })
    expect(tokens.length).toBeGreaterThan(0)
  })
})

describe('task — maxIterations safeguard', () => {
  it('rejects with TaskFailError after maxIterations turns', async () => {
    // Every response is "continue" (no terminal action). With
    // maxIterations: 3 the loop should bail out.
    const { agent } = await makeAgent([
      r({ type: 'ts', code: '/* nope */' }),
      r({ type: 'ts', code: '/* nope */' }),
      r({ type: 'ts', code: '/* nope */' }),
    ])
    // override maxIterations on the agent via a fresh build
    const llm = new Dummy({
      responses: [
        r({ type: 'ts', code: '/* nope */' }),
        r({ type: 'ts', code: '/* nope */' }),
        r({ type: 'ts', code: '/* nope */' }),
      ],
    })
    const a = await createAgent({
      name: 'T',
      llm,
      runtime: evalRuntime(),
      maxIterations: 2,
    })
    const fn = a.task<undefined, void>({ description: 'Loop forever.' })
    await expect(fn(undefined)).rejects.toThrow(/exceeded maxIterations/)
    expect(llm.callCount).toBe(2)
  })
})

describe('task — registered fn reachable from emission code', () => {
  it('agent.fn becomes a callable identifier in ts emissions', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(double(7))' })])
    agent.fn((...args: unknown[]) => (args[0] as number) * 2, {
      name: 'double',
      description: 'Double a number.',
    })
    const fn = agent.task<undefined, number>({ description: 'Double 7.' })
    const result = await fn(undefined)
    expect(result).toBe(14)
  })
})

describe('task — AbortSignal', () => {
  it('rejects with CancelledError when aborted before the first turn', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(1)' })])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    const ac = new AbortController()
    ac.abort()
    await expect(fn(undefined, { signal: ac.signal })).rejects.toThrow()
  })
})

describe('task — no-action nudge', () => {
  it('appends a [System reminder] output when the action emits only text', async () => {
    // Narration-only turn. Without the nudge the agent's next turn
    // sees the same context and tends to loop on "Done. Standing by."
    const { agent } = await makeAgent([
      r({ type: 'text', text: 'Done. Standing by.' }),
      r({ type: 'ts', code: 'taskSuccess("ok")' }),
    ])
    const fn = agent.task<undefined, string>({ description: 'X.' })
    const events: AgentEvent[] = []
    const result = await fn(undefined, { onEvent: (e) => void events.push(e) })
    expect(result).toBe('ok')
    const reminders = events.filter(
      (e) =>
        e.type === 'output' &&
        (e as { parts: ReadonlyArray<{ type: string; text?: string }> }).parts.some(
          (p) => p.type === 'text' && (p.text ?? '').startsWith('[System reminder]'),
        ),
    )
    expect(reminders).toHaveLength(1)
  })

  it('does NOT fire the nudge when the action contains an actionable emission', async () => {
    // Even if the ts_action just continues (no terminator), an
    // actionable emission counts — the agent could be deliberately
    // running an exploratory turn.
    const { agent } = await makeAgent([
      r({ type: 'ts', code: '/* poke around */' }),
      r({ type: 'ts', code: 'taskSuccess(1)' }),
    ])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    const events: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })
    const reminders = events.filter(
      (e) =>
        e.type === 'output' &&
        (e as { parts: ReadonlyArray<{ type: string; text?: string }> }).parts.some(
          (p) => p.type === 'text' && (p.text ?? '').startsWith('[System reminder]'),
        ),
    )
    expect(reminders).toHaveLength(0)
  })

  it("the reminder reaches the model's next turn as plain user text", async () => {
    // End-to-end check on the rendered conversation: after a
    // narration-only turn, the next LLMRequest's last user turn
    // should contain the reminder as plain text (not as a
    // tool_result, because there's no tool_use to pair with).
    const { agent, llm } = await makeAgent([
      r({ type: 'text', text: 'thinking out loud' }),
      r({ type: 'ts', code: 'taskSuccess(1)' }),
    ])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    await fn(undefined)
    // Second LLM call sees the nudge in its incoming turns.
    const secondCall = llm.allTurns[1] ?? []
    const lastTurn = secondCall[secondCall.length - 1]
    expect(lastTurn?.role).toBe('user')
    const text = (lastTurn?.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n')
    expect(text).toMatch(/\[System reminder\]/)
  })
})

// A StandardSchema that accepts numbers and rejects everything else,
// reporting an issue the loop surfaces back to the agent.
const numberSchema: StandardSchemaV1<number, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v: unknown) =>
      typeof v === 'number'
        ? { value: v }
        : { issues: [{ message: `expected number, got ${typeof v}` }] },
  },
}

describe('task — output validation (recoverable)', () => {
  // Output validation is enforced but recoverable: a mismatch is surfaced
  // to the agent, costs one iteration, and only becomes a terminal fail
  // when the loop exhausts. Mirrors agex-py's return-type idiom.
  it('a mismatch is surfaced and the agent retries with a corrected value', async () => {
    const { agent, llm } = await makeAgent([
      r({ type: 'ts', code: 'taskSuccess("nope")' }), // wrong type → recover
      r({ type: 'ts', code: 'taskSuccess(42)' }), // corrected → success
    ])
    const fn = agent.task<undefined, number>({
      description: 'Return a number.',
      output: numberSchema,
    })
    const result = await fn(undefined)
    expect(result).toBe(42)
    // It took a second turn — the mismatch cost one iteration.
    expect(llm.callCount).toBe(2)
    // The agent saw the mismatch as a system reminder on its next turn.
    const seen = JSON.stringify(llm.allTurns[1] ?? [])
    expect(seen).toContain("did not match the task's required output shape")
    expect(seen).toContain('expected number, got string')
  })

  it('a persistent mismatch exhausts maxIterations and fails with the validation message', async () => {
    const llm = new Dummy({ responses: [r({ type: 'ts', code: 'taskSuccess("nope")' })] })
    const agent = await createAgent({ name: 'T', llm, runtime: evalRuntime(), maxIterations: 2 })
    const fn = agent.task<undefined, number>({
      description: 'Return a number.',
      output: numberSchema,
    })
    const err = await fn(undefined).catch((e) => e)
    expect(err).toBeInstanceOf(TaskFailError)
    expect(err.message).toMatch(/exceeded maxIterations \(2\)/)
    expect(err.message).toMatch(/expected number, got string/)
    // The loop kept retrying — one LLM call per iteration, not a single
    // hard-reject on the first mismatch.
    expect(llm.callCount).toBe(2)
  })

  it('a valid output still returns on the first turn (no retry)', async () => {
    const { agent, llm } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(7)' })])
    const fn = agent.task<undefined, number>({
      description: 'Return a number.',
      output: numberSchema,
    })
    expect(await fn(undefined)).toBe(7)
    expect(llm.callCount).toBe(1)
  })
})

describe('task — missing config', () => {
  it('throws if no llm is configured', async () => {
    const a = await createAgent({ name: 'T', runtime: evalRuntime() })
    const fn = a.task<undefined, number>({ description: 'X.' })
    await expect(fn(undefined)).rejects.toThrow(/missing required llm/)
  })

  it('throws if no runtime is configured', async () => {
    const a = await createAgent({ name: 'T', llm: new Dummy() })
    const fn = a.task<undefined, number>({ description: 'X.' })
    await expect(fn(undefined)).rejects.toThrow(/missing required runtime/)
  })
})

describe('task — batch truncation observability', () => {
  // A recoverable error mid-batch stops the rest of the action (state
  // the failed call should have produced isn't there, so trailing calls
  // would cascade). These cover that each result still pairs to its own
  // tool_use id, and that the dropped calls are *named* as skipped
  // rather than rendering silently.
  it('pairs every result to its own id and marks dropped calls skipped', async () => {
    const { agent, llm } = await makeAgent([
      r(
        { type: 'ts', code: `console.log("OUT_ALPHA")` }, // runs
        { type: 'ts', code: `throw new Error("BOOM_BRAVO")` }, // errors → truncates
        { type: 'ts', code: `console.log("OUT_CHARLIE")` }, // never runs
      ),
      r({ type: 'ts', code: 'taskSuccess(null)' }),
    ])
    await agent.task({ description: 'batch' })(undefined)

    const { toolUses, results } = toolUsesAndResults(llm.allTurns[1] ?? [])
    expect(toolUses.length).toBe(3)
    expect(results.length).toBe(3)
    // Results render in emission order, each paired 1:1 to its own
    // tool_use id — no orphan, no merge, no cross-wiring.
    for (let k = 0; k < 3; k++) {
      expect(results[k]?.id).toBe(toolUses[k]?.id)
    }
    expect(results[0]?.text).toContain('OUT_ALPHA')
    expect(results[0]?.text).not.toContain('BOOM_BRAVO')
    expect(results[1]?.text).toContain('BOOM_BRAVO')
    expect(results[1]?.text).not.toContain('OUT_ALPHA')
    // The dropped call is explicitly skipped, not "(no observation)"
    // and definitely not its never-produced output.
    expect(results[2]?.text).toContain('Not executed')
    expect(results[2]?.text).not.toContain('OUT_CHARLIE')
    expect(results[2]?.text).not.toContain('no observation')
  })

  it('a file write dropped behind a failed call does not render a false success', async () => {
    const { agent, llm } = await makeAgent([
      r(
        { type: 'ts', code: `throw new Error("BOOM")` }, // errors → truncates
        { type: 'fileWrite', path: '/late.txt', content: 'X', mode: 'write' }, // never runs
      ),
      r({ type: 'ts', code: 'taskSuccess(null)' }),
    ])
    await agent.task({ description: 'drop-write' })(undefined)

    const { toolUses, results } = toolUsesAndResults(llm.allTurns[1] ?? [])
    const writeId = toolUses.find((t) => t.tool === 'write_file')?.id
    const text = results.find((res) => res.id === writeId)?.text ?? ''
    expect(text).toContain('Not executed')
    expect(text).not.toContain('wrote') // no synthesized "write_file: wrote /late.txt"
    // And the side effect really didn't happen.
    const fs = await agent.fs()
    expect(await fs.exists('/late.txt')).toBe(false)
  })

  it('emits a ✓ SystemNote on file-op success — seen by the embedder, not the LLM', async () => {
    const { agent, llm } = await makeAgent([
      r({ type: 'fileWrite', path: '/a.txt', content: 'hello', mode: 'write' }),
      r({ type: 'fileEdit', path: '/a.txt', search: 'hello', content: 'HELLO' }),
      r({ type: 'ts', code: 'taskSuccess(null)' }),
    ])
    const seen: AgentEvent[] = []
    await agent.task({ description: 'acks' })(undefined, { onEvent: (e) => void seen.push(e) })

    const notes = seen
      .filter((e) => e.type === 'systemNote')
      .map((e) => (e as { message: string }).message)
    expect(notes).toContain('✓ write_file: /a.txt')
    expect(notes).toContain('✓ edit_file: /a.txt')

    // The renderer skips systemNote events, so the ✓ ack never reaches
    // the model (it already gets a synthesized tool_result for success).
    const rendered = JSON.stringify(llm.allTurns)
    expect(rendered).not.toContain('✓ write_file')
    expect(rendered).not.toContain('✓ edit_file')
  })
})
