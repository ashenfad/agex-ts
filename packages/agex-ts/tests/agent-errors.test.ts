/**
 * Agent-code error handling.
 *
 * Covers the contract: a runtime error thrown by the agent's emitted
 * code is logged as an `OutputEvent` containing a typed `'error'`
 * `OutputPart`, and the loop continues so the agent can self-correct.
 * Mirrors agex-py's `recoverable_error` semantics — only `TaskSuccess`,
 * `TaskFail`, `TaskClarify`, and cancellation are terminators.
 */

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { CancelledError, isCancelledError } from '../src/errors'
import { Dummy } from '../src/llm/dummy'
import { errorPartInfo, isErrorPart } from '../src/output-part'
import { renderEvents } from '../src/render'
import { evalRuntime } from '../src/runtime/eval'
import type {
  AgentEvent,
  ExecResult,
  LLMResponse,
  OutputEvent,
  Policy,
  RuntimeAdapter,
} from '../src/types'

describe('Agent-code errors are recoverable', () => {
  it('reference error → OutputEvent with error part → loop continues → next turn succeeds', async () => {
    const responses: LLMResponse[] = [
      // Turn 1: agent reaches for an undefined identifier.
      {
        emissions: [{ type: 'ts', code: 'taskSuccess({ value: oops_undefined })' }],
      },
      // Turn 2: agent self-corrects.
      {
        emissions: [{ type: 'ts', code: 'taskSuccess({ value: 42 })' }],
      },
    ]
    const llm = new Dummy({ responses })

    const agent = await createAgent({
      name: 'recovers',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 5,
    })

    const events: AgentEvent[] = []
    const fn = agent.task<undefined, { value: number }>({
      description: 'Recover from a code error.',
    })
    const result = await fn(undefined, { onEvent: (e) => void events.push(e) })

    expect(result).toEqual({ value: 42 })

    // The first turn's error landed as an OutputEvent with an error part.
    const outputs = events.filter((e): e is OutputEvent => e.type === 'output')
    expect(outputs).toHaveLength(1)
    const errorParts = outputs[0]?.parts.filter((p) => p.type === 'error') ?? []
    expect(errorParts).toHaveLength(1)
    expect(errorParts[0]).toMatchObject({
      type: 'error',
      errorName: 'ReferenceError',
    })
    // Sanity: message mentions the missing identifier.
    expect((errorParts[0] as { errorMessage: string }).errorMessage).toMatch(/oops_undefined/)

    // Two LLM calls — proves the loop continued past the error.
    expect(llm.callCount).toBe(2)
  })

  it('TypeError surfaces as an error part with the correct errorName', async () => {
    const responses: LLMResponse[] = [
      // Calling a non-function — TypeError.
      { emissions: [{ type: 'ts', code: 'const x = (1)(); taskSuccess({ x })' }] },
      { emissions: [{ type: 'ts', code: 'taskSuccess({ x: "ok" })' }] },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 't',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 5,
    })
    const events: AgentEvent[] = []
    await agent.task<undefined, { x: string }>({
      description: 'TypeError test.',
    })(undefined, { onEvent: (e) => void events.push(e) })

    const errPart = events
      .filter((e): e is OutputEvent => e.type === 'output')
      .flatMap((e) => e.parts)
      .find((p) => p.type === 'error')
    expect(errPart).toBeDefined()
    expect((errPart as { errorName: string }).errorName).toBe('TypeError')
  })

  it('first emission throws → subsequent emissions in the same action do NOT run', async () => {
    let secondEmissionRan = false
    const responses: LLMResponse[] = [
      {
        emissions: [
          { type: 'ts', code: 'throw new Error("boom")' },
          // If we kept walking emissions after an error, this would
          // toggle the flag via the registered fn.
          { type: 'ts', code: 'await markRan(); taskSuccess({ ok: true })' },
        ],
      },
      { emissions: [{ type: 'ts', code: 'taskSuccess({ ok: true })' }] },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 'multi',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 5,
    })
    agent.fn(
      async () => {
        secondEmissionRan = true
      },
      { name: 'markRan', description: 'Test probe — should never fire.' },
    )

    const result = await agent.task<undefined, { ok: boolean }>({
      description: 'Multi-emission abort test.',
    })(undefined)

    expect(result).toEqual({ ok: true })
    expect(secondEmissionRan).toBe(false)
  })

  it('renders the error part to the LLM as `💥 ErrorName: message`', async () => {
    // Drive one error-then-success turn, then inspect what renderEvents
    // would have shown the LLM on its next turn.
    const responses: LLMResponse[] = [
      { emissions: [{ type: 'ts', code: 'throw new RangeError("out of bounds")' }] },
      { emissions: [{ type: 'ts', code: 'taskSuccess({ done: true })' }] },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 'render',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 5,
    })
    await agent.task({ description: 'Render check.' })(undefined)

    // What the second LLM call saw as turns — its last user-side
    // observation should contain the formatted error.
    const turnsSecondCall = llm.allTurns[1]
    const flattened = JSON.stringify(turnsSecondCall)
    expect(flattened).toMatch(/💥 RangeError: out of bounds/)
  })

  it('persistent error across maxIterations → fail message includes the last error', async () => {
    const responses: LLMResponse[] = [
      { emissions: [{ type: 'ts', code: 'noSuchThing()' }] },
      { emissions: [{ type: 'ts', code: 'stillBroken()' }] },
      { emissions: [{ type: 'ts', code: 'finalAttempt()' }] },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 'persistent',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 3,
    })
    const events: AgentEvent[] = []
    await expect(
      agent.task({ description: 'Three strikes.' })(undefined, {
        onEvent: (e) => void events.push(e),
      }),
    ).rejects.toThrow(/exceeded maxIterations.*Last error.*finalAttempt/s)

    const failEvent = events.find((e) => e.type === 'fail') as { message: string } | undefined
    expect(failEvent?.message).toMatch(/exceeded maxIterations \(3\)/)
    expect(failEvent?.message).toMatch(/Last error:.*finalAttempt/)
  })

  it('runtime CancelledError propagates as cancellation, not as an error part', async () => {
    const ac = new AbortController()
    const responses: LLMResponse[] = [
      // Long-running emission so we can abort mid-flight.
      {
        emissions: [
          {
            type: 'ts',
            code: `
              await new Promise((r) => setTimeout(r, 200))
              taskSuccess({ ok: true })
            `,
          },
        ],
      },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 'cancel',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 3,
    })
    const events: AgentEvent[] = []

    // Fire the abort shortly after the task starts.
    setTimeout(() => ac.abort(), 25)

    await expect(
      agent.task({ description: 'Will be cancelled.' })(undefined, {
        signal: ac.signal,
        onEvent: (e) => void events.push(e),
      }),
    ).rejects.toBeInstanceOf(CancelledError)

    // No 'error'-part output — cancellation is a terminator, not a
    // recoverable agent-code error.
    const errorParts = events
      .filter((e): e is OutputEvent => e.type === 'output')
      .flatMap((e) => e.parts)
      .filter((p) => p.type === 'error')
    expect(errorParts).toHaveLength(0)

    // CancelledEvent landed in the log.
    expect(events.find((e) => e.type === 'cancelled')).toBeDefined()
  })

  it('TaskFail / TaskClarify still work as terminators (not converted to error parts)', async () => {
    // TaskFail
    const failResponses: LLMResponse[] = [{ emissions: [{ type: 'ts', code: 'taskFail("nope")' }] }]
    const failAgent = await createAgent({
      name: 'fa',
      llm: new Dummy({ responses: failResponses }),
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })
    await expect(failAgent.task({ description: 'fail' })(undefined)).rejects.toThrow(/nope/)

    // TaskClarify
    const clarifyResponses: LLMResponse[] = [
      { emissions: [{ type: 'ts', code: 'taskClarify("which one?")' }] },
    ]
    const clarifyAgent = await createAgent({
      name: 'cl',
      llm: new Dummy({ responses: clarifyResponses }),
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })
    const clarifyEvents: AgentEvent[] = []
    await expect(
      clarifyAgent.task({ description: 'clarify' })(undefined, {
        onEvent: (e) => void clarifyEvents.push(e),
      }),
    ).rejects.toThrow(/which one/)
    expect(clarifyEvents.find((e) => e.type === 'clarify')).toBeDefined()
  })

  it('stdout printed before the error lands in the same OutputEvent as the error part', async () => {
    const responses: LLMResponse[] = [
      {
        emissions: [
          {
            type: 'ts',
            code: `
              console.log("before-error")
              throw new Error("post-print")
            `,
          },
        ],
      },
      { emissions: [{ type: 'ts', code: 'taskSuccess({ ok: true })' }] },
    ]
    const llm = new Dummy({ responses })
    const agent = await createAgent({
      name: 'mixed',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 3,
    })
    const events: AgentEvent[] = []
    await agent.task({ description: 'Mixed output.' })(undefined, {
      onEvent: (e) => void events.push(e),
    })

    // Find the OutputEvent from the failing emission. It should carry
    // BOTH the captured stdout text and the error part — the loop
    // bundles them so the agent's next turn sees them paired.
    const output = events.find((e): e is OutputEvent => e.type === 'output')
    expect(output).toBeDefined()
    const partTypes = output?.parts.map((p) => p.type) ?? []
    expect(partTypes).toContain('text')
    expect(partTypes).toContain('error')
    expect((output?.parts.find((p) => p.type === 'text') as { text: string }).text).toMatch(
      /before-error/,
    )
  })

  it('renderEvents lowers an error-part OutputEvent to the LLM-visible text', async () => {
    // Construct an event log directly and feed it through renderEvents
    // to assert the lowering shape, independent of the loop.
    const events: AgentEvent[] = [
      {
        type: 'taskStart',
        timestamp: '2026-05-08T00:00:00.000Z',
        agentName: 'a',
        taskName: 'tt',
        inputs: undefined,
        message: 'do the thing',
      },
      {
        type: 'action',
        timestamp: '2026-05-08T00:00:01.000Z',
        agentName: 'a',
        emissions: [{ type: 'ts', code: 'throw new Error("x")' }],
      },
      {
        type: 'output',
        timestamp: '2026-05-08T00:00:02.000Z',
        agentName: 'a',
        emissionId: 'x',
        parts: [{ type: 'error', errorName: 'TypeError', errorMessage: 'cant do that' }],
      } satisfies OutputEvent,
    ]
    const turns = renderEvents(events)
    const txt = JSON.stringify(turns)
    expect(txt).toMatch(/💥 TypeError: cant do that/)
  })

  it('worker-style cancellation (plain Error w/ name) re-raises as CancelledEvent — not error part', async () => {
    // Regression for the prototype-stripping path. agex-runtime-worker
    // builds cancellations as plain `Error` with `name = 'CancelledError'`
    // inside the worker (makeCancelledError), then serializes them
    // across postMessage; the host's `rebuildError` reconstructs them
    // as plain `Error`s with the correct `name` but no `CancelledError`
    // prototype. `result.error instanceof CancelledError` would miss
    // them and route through the recoverable-error path. The dispatcher
    // must use a name-based check so worker cancellations land in the
    // CancelledEvent path like host-side ones do.
    //
    // We can't drive the real worker from this Node test, so we stand
    // up a fake RuntimeAdapter that returns the same shape the worker
    // would produce.
    const fakeRuntime: RuntimeAdapter = {
      async init(_p: Policy) {},
      async execute(_code: string): Promise<ExecResult> {
        const e = new Error('worker cancelled mid-flight')
        e.name = 'CancelledError' // shape worker bridge produces
        return {
          outcome: { kind: 'continue' },
          outputs: [],
          error: e,
          elapsedMs: 1,
        }
      },
      async dispose() {},
    }
    const llm = new Dummy({
      responses: [{ emissions: [{ type: 'ts', code: 'taskSuccess(1)' }] }],
    })
    const agent = await createAgent({
      name: 'workercancel',
      llm,
      runtime: fakeRuntime,
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 3,
    })
    const events: AgentEvent[] = []

    await expect(
      agent.task({ description: 't' })(undefined, { onEvent: (e) => void events.push(e) }),
    ).rejects.toBeInstanceOf(CancelledError)

    // No `error`-part output — the dispatcher recognized the worker-
    // shaped cancellation by name and re-raised, exactly as it would
    // have for a host-prototype `CancelledError`.
    const errorParts = events
      .filter((e): e is OutputEvent => e.type === 'output')
      .flatMap((e) => e.parts)
      .filter((p) => p.type === 'error')
    expect(errorParts).toHaveLength(0)
    expect(events.find((e) => e.type === 'cancelled')).toBeDefined()
  })

  it('extracts errorMessage from a loose Error-shaped object (third-party adapter)', async () => {
    // Defensive coverage: the RuntimeAdapter contract types
    // `result.error` as `Error | null`, but third-party adapters might
    // return a non-Error object with `.name` / `.message` properties.
    // Direct `.message` access (not `describeError`) is what handles
    // this correctly — `describeError` would fall to its `String(e)`
    // branch and produce `"[object Object]"` for non-Error objects.
    //
    // The fake runtime always returns the loose error, so the agent
    // never makes progress and we exhaust the iteration cap. That's
    // fine — what we assert on is the error part stamped onto the
    // OutputEvent during the first iteration.
    const fakeRuntime: RuntimeAdapter = {
      async init(_p: Policy) {},
      async execute(_code: string): Promise<ExecResult> {
        return {
          outcome: { kind: 'continue' },
          outputs: [],
          // Plain object with the right surface, not an Error instance.
          // Forced cast — exactly the loose-typed shape the test
          // exercises.
          error: { name: 'WeirdError', message: 'I am not a real Error' } as unknown as Error,
          elapsedMs: 1,
        }
      },
      async dispose() {},
    }
    const llm = new Dummy({
      responses: [{ emissions: [{ type: 'ts', code: 'noop()' }] }],
    })
    const agent = await createAgent({
      name: 'weird',
      llm,
      runtime: fakeRuntime,
      state: { type: 'versioned', storage: 'memory' },
      maxIterations: 1,
    })
    const events: AgentEvent[] = []
    await expect(
      agent.task({ description: 't' })(undefined, {
        onEvent: (e) => void events.push(e),
      }),
    ).rejects.toThrow(/exceeded maxIterations/)

    const errorPart = events
      .filter((e): e is OutputEvent => e.type === 'output')
      .flatMap((e) => e.parts)
      .find((p) => p.type === 'error') as { errorName: string; errorMessage: string } | undefined
    expect(errorPart).toBeDefined()
    expect(errorPart?.errorName).toBe('WeirdError')
    expect(errorPart?.errorMessage).toBe('I am not a real Error')
  })
})

describe('output-part helpers — typed shape and py-side convention', () => {
  it('isErrorPart: true for typed error part', () => {
    expect(isErrorPart({ type: 'error', errorName: 'ReferenceError', errorMessage: 'x' })).toBe(
      true,
    )
  })

  it('isErrorPart: true for legacy convention text part (`💥 ErrorName: msg`)', () => {
    expect(isErrorPart({ type: 'text', text: '💥 ReferenceError: foo is not defined' })).toBe(true)
  })

  it('isErrorPart: false for ordinary stdout', () => {
    expect(isErrorPart({ type: 'text', text: 'just printing' })).toBe(false)
  })

  it('isErrorPart: false for image parts', () => {
    expect(isErrorPart({ type: 'image', format: 'png', data: 'aGVsbG8=' })).toBe(false)
  })

  it('errorPartInfo: extracts name + message from typed error part', () => {
    const info = errorPartInfo({ type: 'error', errorName: 'TypeError', errorMessage: 'oops' })
    expect(info).toEqual({ errorName: 'TypeError', errorMessage: 'oops' })
  })

  it('errorPartInfo: extracts name + message from convention text part', () => {
    const info = errorPartInfo({ type: 'text', text: '💥 RangeError: out of bounds' })
    expect(info).toEqual({ errorName: 'RangeError', errorMessage: 'out of bounds' })
  })

  it('errorPartInfo: handles a multi-line error message in the convention', () => {
    const text = '💥 SyntaxError: Unexpected token\n  at line 3\n  at line 4'
    const info = errorPartInfo({ type: 'text', text })
    expect(info?.errorName).toBe('SyntaxError')
    expect(info?.errorMessage).toMatch(/Unexpected token[\s\S]*line 3/)
  })

  it('errorPartInfo: returns null for ordinary text', () => {
    expect(errorPartInfo({ type: 'text', text: 'totally fine output' })).toBeNull()
  })

  it('errorPartInfo: tolerates a trailing newline on the convention text', () => {
    expect(errorPartInfo({ type: 'text', text: '💥 Error: gone wrong\n' })).toEqual({
      errorName: 'Error',
      errorMessage: 'gone wrong',
    })
  })
})

describe('isCancelledError — cross-realm cancellation check', () => {
  it('true for host-side CancelledError instance', () => {
    expect(isCancelledError(new CancelledError())).toBe(true)
  })

  it('true for plain Error with name === "CancelledError" (worker-rebuilt shape)', () => {
    const e = new Error('via postMessage')
    e.name = 'CancelledError'
    expect(isCancelledError(e)).toBe(true)
  })

  it('true for an Error-shaped object literal (loose third-party adapter)', () => {
    expect(isCancelledError({ name: 'CancelledError', message: 'x' })).toBe(true)
  })

  it('false for ordinary Errors', () => {
    expect(isCancelledError(new Error('boom'))).toBe(false)
    expect(isCancelledError(new TypeError('nope'))).toBe(false)
  })

  it('false for non-error values', () => {
    expect(isCancelledError(null)).toBe(false)
    expect(isCancelledError(undefined)).toBe(false)
    expect(isCancelledError('CancelledError')).toBe(false)
    expect(isCancelledError({})).toBe(false)
    expect(isCancelledError({ name: 42 })).toBe(false)
  })
})
