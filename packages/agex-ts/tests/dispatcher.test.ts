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
    const bytes = await (await agent.fs()).read('/note.txt')
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
    expect(dec.decode(await (await agent.fs()).read('/log.txt'))).toBe('line1\nline2\n')
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
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('new value here')
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
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('X X X')
  })

  it('fails when the search string matches more than once (not unique)', async () => {
    // The schema promises a non-matchAll edit matches exactly once.
    // If the agent's search isn't unique, silently editing the first
    // hit is how a replace lands on the wrong occurrence and looks
    // like it "deleted lines it didn't target". Reject instead, with
    // the match count, so the agent widens the search or uses matchAll.
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'a a a', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'a', content: 'X' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit ambiguous.' })
    await expect(fn(undefined)).rejects.toThrow(/not unique \(3 matches\)/)
  })

  it('non-unique guard leaves the file untouched', async () => {
    // The failing edit must not partially apply — the file is exactly
    // as written before the rejected edit. (Round 2 terminates so we
    // can read the VFS after the failure surfaces to the agent.)
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'a a a', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'a', content: 'X' },
      ),
      r({ type: 'ts', code: 'taskSuccess(null)' }),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit ambiguous, recover.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('a a a')
  })

  it('targets one occurrence when the search carries surrounding context', async () => {
    // The disambiguation the not-unique error points the agent toward:
    // include enough context that the search matches exactly once.
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'a=1\na=2\n', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'a=2', content: 'a=9' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit second line.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('a=1\na=9\n')
  })

  it('two sequential edits on adjacent lines each apply surgically', async () => {
    // The reported failure was two edits in one action mangling the
    // span between them. Each fileEdit re-reads the file fresh and
    // splices only its matched range, so adjacent edits compose
    // cleanly: editing line 2 then line 3 touches neither line 1 nor
    // each other.
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'one\ntwo\nthree\n', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'two', content: 'TWO' },
        { type: 'fileEdit', path: '/p.txt', search: 'three', content: 'THREE' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Two adjacent edits.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('one\nTWO\nTHREE\n')
  })

  it('hints at typographic look-alikes when an ASCII search just misses', async () => {
    // The reported incident: the file has a curly apostrophe / em-dash,
    // the model retypes the block with a straight quote / hyphen, and
    // the exact-match search misses. The error now names the cause so
    // the model copies the real characters instead of guessing again.
    const { agent } = await makeAgent([
      r(
        // File holds U+2019 (curly) and U+2014 (em dash).
        { type: 'fileWrite', path: '/p.txt', content: 'it’s here — really', mode: 'write' },
        // Search uses ASCII apostrophe + hyphen.
        { type: 'fileEdit', path: '/p.txt', search: "it's here - really", content: 'gone' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit look-alike.' })
    await expect(fn(undefined)).rejects.toThrow(/not found.*typographic characters/s)
  })

  it('hints at NFC normalization when forms differ', async () => {
    // File stores a decomposed (NFD) accented char; the model searches
    // with the composed (NFC) form. Byte-for-byte miss, but they match
    // under NFC — the error says so.
    const nfd = 'café'.normalize('NFD') // e + combining acute
    const nfc = 'café' // é precomposed
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: `${nfd} menu`, mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: nfc, content: 'X' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit NFC.' })
    await expect(fn(undefined)).rejects.toThrow(/not found.*NFC normalization/s)
  })

  it('does not add a hint for a genuine not-found (no near miss)', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: 'hello world', mode: 'write' },
        { type: 'fileEdit', path: '/p.txt', search: 'zzz', content: 'X' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Edit plain miss.' })
    const err = await fn(undefined).catch((e: unknown) => e)
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toMatch(/search string not found/)
    // No look-alike / normalization hint appended for a true miss.
    expect(msg).not.toMatch(/typographic|NFC/)
  })

  it('matches a multi-line block despite trailing whitespace in the file', async () => {
    // The file's first two lines carry trailing spaces the agent's
    // search omits, so the exact contiguous match fails. The
    // trailing-whitespace-flexible strategy recovers; the matched span
    // (including the stray spaces) is replaced by the content verbatim.
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'function f() {  \n  return 1  \n}\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'function f() {\n  return 1\n}',
          content: 'function f() {\n  return 2\n}',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Trailing ws block.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe(
      'function f() {\n  return 2\n}\n',
    )
  })

  it('matches a block at a different absolute indent and re-indents the replacement', async () => {
    // The agent wrote its search/replacement at module indent (def at
    // column 0); the file has the block nested in a class (def at
    // column 4). Indent-flexible matching locates it, and the
    // replacement is shifted to the file's indentation on the way in.
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'class A:\n    def f():\n        return 1\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 99',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Indent-flexible.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe(
      'class A:\n    def f():\n        return 99\n',
    )
  })

  it('indent-flexible re-indents using the file’s tab character', async () => {
    // File is tab-indented; the agent searched with spaces. The
    // replacement comes back rendered with tabs (4 columns per tab).
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'class A:\n\tdef f():\n\t\treturn 1\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 99',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Indent tabs.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe(
      'class A:\n\tdef f():\n\t\treturn 99\n',
    )
  })

  it('matchAll replaces every indent-flexible occurrence', async () => {
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content:
            'class A:\n    def f():\n        return 1\n\nclass B:\n    def f():\n        return 1\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 2',
          matchAll: true,
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Indent matchAll.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe(
      'class A:\n    def f():\n        return 2\n\nclass B:\n    def f():\n        return 2\n',
    )
  })

  it('uniqueness guard fires on fuzzy (indent-flexible) matches too', async () => {
    // Two structurally-identical blocks at different indents — a
    // non-matchAll edit must still refuse rather than pick one.
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content:
            'class A:\n    def f():\n        return 1\n\nclass B:\n    def f():\n        return 1\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 2',
        },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Fuzzy non-unique.' })
    await expect(fn(undefined)).rejects.toThrow(/not unique \(2 matches\)/)
  })

  it('prefers an exact match over the fuzzy fallbacks', async () => {
    // When the search matches exactly, indentation-only twins elsewhere
    // must not turn it into a (spurious) multi-match error.
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'def f():\n    return 1\n\nclass A:\n    def f():\n        return 1\n',
          mode: 'write',
        },
        // Exact module-level block; the nested twin differs by indent.
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 2',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Exact wins.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe(
      'def f():\n    return 2\n\nclass A:\n    def f():\n        return 1\n',
    )
  })

  it('indent-flexible matches do not overlap on a repeated anchor line', async () => {
    // A search whose lines repeat ("x()\nx()") against three indented
    // copies must yield one non-overlapping match, not two overlapping
    // ones — otherwise matchAll would splice overlapping ranges and
    // corrupt the file. Replace all; expect the first two lines edited
    // as one block and the third left intact.
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/p.txt', content: '  x()\n  x()\n  x()\n', mode: 'write' },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'x()\nx()',
          content: 'y()\ny()',
          matchAll: true,
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'No overlap.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/p.txt'))).toBe('  y()\n  y()\n  x()\n')
  })

  it('trailing-ws matching works on a CRLF file and keeps endings consistent', async () => {
    // The agent searches with LF; the file uses CRLF and carries
    // trailing whitespace. The block is still found, and the spliced-in
    // replacement is normalized to CRLF — no mixed endings.
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'function f() {  \r\n  return 1  \r\n}\r\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'function f() {\n  return 1\n}',
          content: 'function f() {\n  return 2\n}',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'CRLF trailing ws.' })
    await fn(undefined)
    const out = dec.decode(await (await agent.fs()).read('/p.txt'))
    expect(out).toBe('function f() {\r\n  return 2\r\n}\r\n')
    expect(out).not.toMatch(/[^\r]\n/) // no bare LF (every \n preceded by \r)
  })

  it('indent-flexible matching works on a CRLF file and keeps endings consistent', async () => {
    const { agent } = await makeAgent([
      r(
        {
          type: 'fileWrite',
          path: '/p.txt',
          content: 'class A:\r\n    def f():\r\n        return 1\r\n',
          mode: 'write',
        },
        {
          type: 'fileEdit',
          path: '/p.txt',
          search: 'def f():\n    return 1',
          content: 'def f():\n    return 99',
        },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'CRLF indent.' })
    await fn(undefined)
    const out = dec.decode(await (await agent.fs()).read('/p.txt'))
    expect(out).toBe('class A:\r\n    def f():\r\n        return 99\r\n')
    expect(out).not.toMatch(/[^\r]\n/)
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
  it('runs a @agex-ts/termish builtin pipeline', async () => {
    const { agent } = await makeAgent([
      r(
        { type: 'fileWrite', path: '/lines.txt', content: 'b\na\nc\n', mode: 'write' },
        { type: 'terminal', commands: 'sort /lines.txt > /sorted.txt' },
        { type: 'ts', code: 'taskSuccess(null)' },
      ),
    ])
    const fn = agent.task<undefined, null>({ description: 'Sort.' })
    await fn(undefined)
    expect(dec.decode(await (await agent.fs()).read('/sorted.txt'))).toBe('a\nb\nc\n')
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
    expect(dec.decode(await (await agent.fs()).read('/out.txt'))).toBe('BEEP\n')
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

  it('on partial pipeline failure surfaces preceding stdout alongside the error', async () => {
    // Regression: when a multi-pipeline terminal command halts on a
    // failing pipeline, the stdout captured from earlier pipelines was
    // dropped — the agent only saw the error part. @agex-ts/termish stashes
    // the captured output on `TerminalError.partialOutput`; the
    // dispatcher now forwards it as a leading text part.
    const { agent } = await makeAgent([
      // Round 1: terminal halts after `nope` — earlier `echo`s should
      // still be surfaced. Dispatch loop returns 'continue' on the
      // failure, the agent asks the LLM for the next turn.
      r({ type: 'terminal', commands: 'echo first; echo second; nope' }),
      // Round 2: terminator so the task ends.
      r({ type: 'ts', code: 'taskSuccess(null)' }),
    ])
    const fn = agent.task<undefined, null>({ description: 'Mixed output.' })
    const events: Array<{ type: string; parts?: ReadonlyArray<unknown> }> = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })
    const out = events.find(
      (e) =>
        e.type === 'output' &&
        (e.parts ?? []).some((p) => (p as { type: string }).type === 'error'),
    )
    expect(out).toBeDefined()
    const parts = out?.parts as ReadonlyArray<{
      type: string
      text?: string
      errorMessage?: string
    }>
    // Two parts: the captured stdout (text) followed by the error.
    expect(parts.map((p) => p.type)).toEqual(['text', 'error'])
    expect(parts[0]?.text).toBe('first\nsecond\n')
    expect(parts[1]?.errorMessage).toMatch(/nope: command not found/)
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
    const bytes = await (await agent.fs()).read('/helpers/primeUtils.ts')
    expect(new TextDecoder().decode(bytes)).toContain('nextPrime')
    void enc
  })
})
