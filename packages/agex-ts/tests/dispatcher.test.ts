import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { makeToolUseId } from '../src/render'
import { evalRuntime } from '../src/runtime/eval'
import type { ActionEvent, AgentEvent, LLMResponse, OutputEvent } from '../src/types'

const enc = new TextEncoder()
const dec = new TextDecoder()
const r = (...emissions: LLMResponse['emissions']): LLMResponse => ({ emissions })

async function makeAgent(responses: ReadonlyArray<LLMResponse | Error>) {
  const llm = new Dummy({ responses })
  const runtime = evalRuntime()
  const agent = await createAgent({ name: 'D', llm, runtime })
  return { agent, llm, runtime }
}

describe('emission dispatch — fileWrite', () => {
  it('writes a new file in the agent VFS', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/note.txt', content: 'hello', mode: 'write' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Write a file.' })
    await fn(undefined)
    const bytes = await agent.fs().read('/note.txt')
    expect(dec.decode(bytes)).toBe('hello')
  })

  it('appends with mode "append"', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/log.txt', content: 'line1\n', mode: 'write' },
        { type: 'fileWrite', path: '/log.txt', content: 'line2\n', mode: 'append' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Append.' })
    await fn(undefined)
    expect(dec.decode(await agent.fs().read('/log.txt'))).toBe('line1\nline2\n')
  })
})

describe('emission dispatch — fileEdit', () => {
  it('replaces a single occurrence', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'old value here', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'old', content: 'new' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit.' })
    await fn(undefined)
    expect(dec.decode(await agent.fs().read('/p.txt'))).toBe('new value here')
  })

  it('matchAll replaces every occurrence', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'a a a', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'a', content: 'X', matchAll: true },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit all.' })
    await fn(undefined)
    expect(dec.decode(await agent.fs().read('/p.txt'))).toBe('X X X')
  })

  it('fails the task when the file does not exist', async () => {
    const { agent } = await makeAgent([
      r({ type: 'fileEdit', path: '/missing', search: 'a', content: 'b' }),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit missing.' })
    await expect(fn(undefined)).rejects.toThrow(/no such file/)
  })

  it('fails the task when the search string is not found', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'hello', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'zzz', content: 'X' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit not-found.' })
    await expect(fn(undefined)).rejects.toThrow(/search string not found/)
  })
})

describe('emission dispatch — terminal', () => {
  it('runs a termish-ts builtin pipeline', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/lines.txt', content: 'b\na\nc\n', mode: 'write' },
        { type: 'terminal', commands: 'sort /lines.txt > /sorted.txt' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Sort.' })
    await fn(undefined)
    expect(dec.decode(await agent.fs().read('/sorted.txt'))).toBe('a\nb\nc\n')
  })

  it('host-registered terminal commands are reachable', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'terminal', commands: 'beep | tee /out.txt' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    agent.terminal(
      async (ctx) => {
        ctx.stdout.write('BEEP\n')
        return undefined
      },
      { name: 'beep', description: 'Emit "BEEP".' },
    )
    const fn = agent.task<undefined, null>({ description: 'Beep.' })
    await fn(undefined)
    expect(dec.decode(await agent.fs().read('/out.txt'))).toBe('BEEP\n')
  })

  it('emits captured stdout as an OutputEvent', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/x.txt', content: 'hello\n', mode: 'write' },
        { type: 'terminal', commands: 'cat /x.txt' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Echo back.' })
    const events: { type: string }[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })
    const outputs = events.filter((e) => e.type === 'output')
    expect(outputs.length).toBeGreaterThan(0)
  })
})

describe('OutputEvent emissionId stamping', () => {
  // The renderer relies on OutputEvent.emissionId to pair outputs to
  // the right tool_use. The id is derived from
  // makeToolUseId(actionTimestamp, emissionIndex), so each
  // OutputEvent must carry the id of the *specific* emission that
  // produced it — not the whole action, not a positional cursor.

  it('stamps the producing emission index, even when earlier emissions are silent', async () => {
    const { agent } = await makeAgent([
      r(
        // index 0: thinking — no output
        { type: 'thinking', text: 'plan' },
        // index 1: silent fileWrite — no output
        { type: 'fileWrite', path: '/x.txt', content: 'hi\n', mode: 'write' },
        // index 2: terminal with stdout — produces OutputEvent
        { type: 'terminal', commands: 'cat /x.txt' },
        // index 3: ts terminator
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Stamp test.' })
    const events: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })

    const action = events.find((e): e is ActionEvent => e.type === 'action')
    const output = events.find((e): e is OutputEvent => e.type === 'output')
    expect(action).toBeDefined()
    expect(output).toBeDefined()

    // The single OutputEvent must point at emission index 2 (the
    // terminal), NOT index 0 (which was a thinking part — not even a
    // tool_use). A positional-cursor implementation would get this
    // wrong and produce a dangling tool_result.
    if (action !== undefined && output !== undefined) {
      expect(output.emissionId).toBe(makeToolUseId(action.timestamp, 2))
    }
  })

  it('stamps distinct ids for multiple producing emissions', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/a.txt', content: 'A\n', mode: 'write' },
        { type: 'fileWrite', path: '/b.txt', content: 'B\n', mode: 'write' },
        { type: 'terminal', commands: 'cat /a.txt' },
        { type: 'terminal', commands: 'cat /b.txt' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Two outputs.' })
    const events: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })

    const action = events.find((e): e is ActionEvent => e.type === 'action') as ActionEvent
    const outputs = events.filter((e): e is OutputEvent => e.type === 'output')
    expect(outputs.length).toBe(2)
    expect(outputs[0]?.emissionId).toBe(makeToolUseId(action.timestamp, 2))
    expect(outputs[1]?.emissionId).toBe(makeToolUseId(action.timestamp, 3))
  })
})

describe('emission dispatch — text/thinking are no-ops', () => {
  it('text and thinking emissions still resolve via the next ts terminator', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'thinking', text: 'pondering' },
        { type: 'text', text: 'aside' },
        { type: 'ts', code: 'taskSuccess("ok")' },
      ),
    ])
    const fn = agent.task<undefined, string>({ description: 'Soliloquy.' })
    expect(await fn(undefined)).toBe('ok')
  })
})

describe('emission dispatch — TypeScript syntax in agent emissions', () => {
  // Higher-level pin on top of evalRuntime's TS tests: scripted
  // emissions carrying TS syntax (annotations, interfaces, generics,
  // `as` casts, returning a typed function) flow through the full
  // agent loop and produce the right outcome. Catches regressions in
  // the dispatcher -> runtime -> emission path that the unit-level
  // runtime tests would miss.
  it('runs typed emissions and returns a callable function back to the host', async () => {
    const { agent } = await makeAgent([
      r({
        type: 'ts',
        code: `
          interface PrimeFinder { (n: number): number }
          function isPrime(n: number): boolean {
            if (n < 2) return false
            for (let i = 2; i * i <= n; i++) if (n % i === 0) return false
            return true
          }
          const nextPrime: PrimeFinder = (n) => {
            let c = n + 1
            while (!isPrime(c)) c++
            return c
          }
          taskSuccess(nextPrime as unknown)
        `,
      }),
    ])
    const fn = agent.task<undefined, (n: number) => number>({
      description: 'Build a next-prime function.',
    })
    const result = await fn(undefined)
    expect(typeof result).toBe('function')
    expect(result(10)).toBe(11)
    expect(result(500_000)).toBe(500_009)
  })

  it('surfaces a clear error when the agent emits non-erasable TS', async () => {
    // ts-blank-space refuses enum / namespace / decorators / parameter
    // properties. The agent loop treats that as a normal failure so
    // the next turn's primer/feedback can teach the agent to use
    // modern alternatives (`as const`, modules, etc.).
    const { agent } = await makeAgent([
      r({ type: 'ts', code: 'enum Color { Red } taskSuccess(Color.Red)' }),
    ])
    const fn = agent.task<undefined, string>({ description: 'Bad TS.' })
    await expect(fn(undefined)).rejects.toThrow()
  })

  it('imports helper modules from the VFS and uses them across actions', async () => {
    // End-to-end pin on the module-loader path: the agent writes a
    // helper to /helpers/, then in a follow-up action imports from
    // it. This is the "/helpers/" workflow the BUILTIN_PRIMER
    // promises — without the loader, the second action's `import`
    // statement throws `Cannot use import statement outside a
    // module`.
    const enc = new TextEncoder()
    const { agent } = await makeAgent([
      // Action 1: write the helper, return continue
      r(
        {
          type: 'fileWrite',
          path: '/helpers/primeUtils.ts',
          mode: 'write',
          content: `
export function isPrime(n: number): boolean {
  if (n < 2) return false
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false
  return true
}
export function nextPrime(n: number): number {
  let c = Math.floor(n) + 1
  while (!isPrime(c)) c++
  return c
}
          `,
        },
        { type: 'ts', code: '/* keep going */' },
      ),
      // Action 2: import + call the helper
      r({
        type: 'ts',
        code: `
import { nextPrime } from '/helpers/primeUtils'
taskSuccess(nextPrime(500_000))
        `,
      }),
    ])
    const fn = agent.task<undefined, number>({
      description: 'Use a helper to find a prime.',
    })
    const result = await fn(undefined)
    expect(result).toBe(500_009)
    // Helper is genuinely persisted in the VFS for inspection /
    // future tasks.
    const bytes = await agent.fs().read('/helpers/primeUtils.ts')
    expect(new TextDecoder().decode(bytes)).toContain('nextPrime')
    void enc
  })
})
