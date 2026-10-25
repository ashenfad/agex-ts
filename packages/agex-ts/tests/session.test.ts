/**
 * A session: an agent driving a workspace turn by turn, its conversation
 * stored in the session's branch. After agex's test_session.py and
 * test_endings.py: how a turn runs, and how each ending lands.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Inbox, Store, type TurnEvent, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  Agent,
  CLOSING_NOTE,
  HARNESS,
  type Message,
  type Provider,
  type ProviderEvent,
  STOPPED,
  ScriptedProvider,
  type Session,
  aborted,
  cutOff,
  limitReached,
  messageText,
  newId,
  readRuns,
  unanswered,
} from '../src/index'

const WORKER = new URL('../../world/dist/worker.node.js', import.meta.url)

const step = (over: Partial<ModelStep>): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
  ...over,
})
const says = (text: string, inputTokens = 0) => step({ text, input_tokens: inputTokens })
const calls = (name: string, args: Record<string, unknown> = {}) =>
  step({ tool_calls: [{ name, args }] })
const writes = (path: string, content: string) => calls('file_write', { path, content })
const fails = (fail: 'provider' | 'error') => step({ fail })

let store: Store
let ws: Workspace

beforeEach(async () => {
  store = await Store.open(new Memory())
  ws = await store.open('s')
})

const agent = (steps: ModelStep[], opts: { maxSteps?: number; maxToolCalls?: number } = {}) =>
  new Agent({ model: new ScriptedProvider(steps), ...opts })

const kinds = (events: readonly TurnEvent[]) =>
  events.filter((e) => e.kind !== 'Usage').map((e) => e.kind)

const ended = (events: readonly TurnEvent[]) =>
  events.filter((e): e is Extract<TurnEvent, { kind: 'ToolEnded' }> => e.kind === 'ToolEnded')

/** A model that waits to be released, or stopped, before it says
 *  anything. */
class Slow implements Provider {
  readonly name = 'slow'
  started: () => void = () => {}
  readonly whenStarted = new Promise<void>((resolve) => {
    this.started = resolve
  })
  release: () => void = () => {}

  async *stream(
    _messages: readonly Message[],
    _tools: unknown,
    _settings: unknown,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<ProviderEvent> {
    this.started()
    await new Promise<void>((resolve, reject) => {
      this.release = resolve
      opts.signal?.addEventListener('abort', () => reject(aborted(opts.signal as AbortSignal)), {
        once: true,
      })
    })
    yield { kind: 'TextDelta', text: 'slowly' }
    yield {
      kind: 'Reply',
      message: { id: newId(), role: 'assistant', parts: [{ kind: 'text', text: 'slowly' }] },
    }
  }

  transient(): boolean {
    return false
  }
}

describe('a turn', () => {
  it('replies and lands one commit, stamped with how it ended', async () => {
    const head = ws.head
    const outcome = await agent([says('hello')])
      .session(ws)
      .say('say hello')
    expect([outcome.status, outcome.text]).toEqual(['completed', 'hello'])
    expect(outcome.head).toBe(ws.head)
    expect(outcome.head).not.toBe(head)
    expect(kinds(outcome.events)).toEqual(['RunStarted', 'TextDelta', 'RunEnded'])
    expect((await ws.log({ limit: 1 }))[0]?.info).toEqual({
      tool: 'turn',
      runs: { [outcome.runId]: 'completed' },
    })
    const index = await ws.conversation.index()
    expect([index?.harness, index?.runs]).toEqual([HARNESS, [outcome.runId]])
  })

  it('runs tools against the workspace, and the run keeps them', async () => {
    const session = agent([writes('/workspace/a.txt', 'A'), says('wrote it')]).session(ws)
    const outcome = await session.say('write a')
    expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
    expect(kinds(outcome.events)).toEqual([
      'RunStarted',
      'ToolStarted',
      'ToolEnded',
      'TextDelta',
      'RunEnded',
    ])
    const started = outcome.events.find((e) => e.kind === 'ToolStarted')
    expect(started).toMatchObject({
      callId: 'call_1',
      args: { path: '/workspace/a.txt', content: 'A' },
    })
    expect(ended(outcome.events)[0]).toMatchObject({ callId: 'call_1', isError: false })
    expect((await ws.log({ limit: 2 })).map((c) => c.info?.tool).reverse()).toEqual([
      'file_write',
      'turn',
    ])
    const [run] = await session.runs()
    expect(run?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(run?.status).toBe('completed')
    expect(run?.startedAt).toBeGreaterThan(0)
    const result = run?.messages[2]?.parts[0]
    expect(result?.kind === 'tool_result' && result.callId).toBe('call_1')
  })

  it('carries the conversation from turn to turn, primer first', async () => {
    const provider = new ScriptedProvider([says('one'), says('two')])
    const session = new Agent({ model: provider, primer: 'You are terse.' }).session(ws)
    await session.say('first')
    await session.say('second')
    const sent = provider.seen[1] as readonly Message[]
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const system = messageText(sent[0] as Message)
    expect(system.startsWith('You are terse.')).toBe(true)
    expect(system).toContain('persistent workspace')
    expect(sent.slice(1).map(messageText)).toEqual(['first', 'one', 'second'])
    expect((await session.runs()).map((r) => messageText(r.messages[0] as Message))).toEqual([
      'first',
      'second',
    ])
  })

  it('reads the runs from the workspace, without an agent', async () => {
    expect(await readRuns(ws)).toEqual([])
    const session = agent([says('one'), says('two')]).session(ws)
    await session.say('first')
    await session.say('second')
    const reopened = await store.open('s')
    const runs = await readRuns(reopened)
    expect(runs.map((r) => messageText(r.messages[0] as Message))).toEqual(['first', 'second'])
    expect(runs).toEqual(await session.runs())
  })

  it('a new session continues the stored conversation', async () => {
    await agent([says('noted')])
      .session(ws)
      .say('remember 42')
    const provider = new ScriptedProvider([says('42')])
    await new Agent({ model: provider }).session(ws).say('what was it?')
    expect((provider.seen[0] as readonly Message[]).slice(1).map(messageText)).toEqual([
      'remember 42',
      'noted',
      'what was it?',
    ])
  })

  it('streams events as they happen, and leaves the outcome', async () => {
    const session = agent([says('streamed', 42)]).session(ws)
    const events: TurnEvent[] = []
    for await (const event of session.stream('go')) events.push(event)
    expect(events[0]?.kind).toBe('RunStarted')
    expect(events.at(-1)?.kind).toBe('RunEnded')
    expect(events.some((e) => e.kind === 'Usage' && e.inputTokens === 42)).toBe(true)
    expect(session.last?.text).toBe('streamed')
  })

  it('delivers a note queued mid-turn on the next tool result', async () => {
    const session = agent([writes('/workspace/a.txt', 'A'), says('ok')]).session(ws)
    const note = session.inbox.put('also mention the date')
    const outcome = await session.say('write a')
    expect(kinds(outcome.events)).toEqual([
      'RunStarted',
      'ToolStarted',
      'Delivered',
      'ToolEnded',
      'TextDelta',
      'RunEnded',
    ])
    const delivered = outcome.events.find((e) => e.kind === 'Delivered')
    expect(delivered?.kind === 'Delivered' && delivered.notes.map((n) => n.id)).toEqual([note.id])
    expect(ended(outcome.events)[0]?.result).not.toContain('also mention the date')
    const result = (await session.runs())[0]?.messages[2]?.parts[0]
    expect(result?.kind === 'tool_result' && result.content).toContain('also mention the date')
    expect([session.inbox.pending(), session.inbox.delivered()]).toEqual([[], []])
  })

  it('reads a failed tool call back to the model', async () => {
    const session = agent([
      calls('no_such_tool'),
      calls('file_write', { path: '/workspace/a.txt' }),
      says('I see'),
    ]).session(ws)
    const outcome = await session.say('go')
    expect(outcome.status).toBe('completed')
    const results = ended(outcome.events)
    expect(results.map((e) => e.isError)).toEqual([true, true])
    expect(results[0]?.result).toContain("no tool named 'no_such_tool'")
  })

  it('refuses a conversation another harness wrote', async () => {
    const turn = await ws.turn('r1', { harness: 'other' })
    await turn.end('completed', { body: { said: 'hi' } })
    await expect(
      agent([says('x')])
        .session(ws)
        .say('go'),
    ).rejects.toThrow(/'other' wrote/)
  })
})

describe('limits', () => {
  it('stops a run that never stops calling tools, with a closing note', async () => {
    const session = agent(Array(5).fill(calls('terminal', { command: 'true' })), {
      maxSteps: 3,
    }).session(ws)
    const outcome = await session.say('go')
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('3 calls')
    const [run] = await session.runs()
    expect(messageText(run?.messages.at(-1) as Message).startsWith(CLOSING_NOTE)).toBe(true)
    expect(run?.messages.at(-2)?.role).toBe('tool')
  })

  it('a resumed run counts the model calls it made before it stopped', async () => {
    const command = calls('terminal', { command: 'true' })
    const session = agent([command, command, fails('provider'), command, command, command], {
      maxSteps: 3,
    }).session(ws)
    expect((await session.say('go')).status).toBe('interrupted')
    // two replies made: one call is left of the run's three
    const outcome = await session.resume()
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('3 calls')
    expect(ended(outcome.events)).toHaveLength(1)
  })

  const REFUSED = `not run: ${limitReached(3)}`
  const command = (n: number) => ({ name: 'terminal', args: { command: `echo ${n}` } })
  const told = async (session: Session) =>
    ((await session.runs()).at(-1)?.messages ?? [])
      .map((m, i) => [m, i] as const)
      .filter(([m]) => m.role === 'user' && messageText(m).startsWith('[this turn has made'))
      .map(([, i]) => i)

  it('runs no tool call past the cap, however many a reply makes', async () => {
    const session = agent(
      [
        step({ tool_calls: [command(1), command(2)] }),
        step({ tool_calls: [command(3), command(4)] }),
        says('ran three'),
      ],
      { maxToolCalls: 3 },
    ).session(ws)
    const outcome = await session.say('go')
    expect([outcome.status, outcome.text]).toEqual(['completed', 'ran three'])
    expect(ended(outcome.events).map((e) => e.result === REFUSED)).toEqual([
      false,
      false,
      false,
      true,
    ])
    expect(await told(session)).toEqual([5])
  })

  it('fails a run whose model calls tools after it was told to stop', async () => {
    const session = agent(
      [calls('terminal', { command: 'echo 1' }), calls('terminal', { command: 'echo 2' })],
      { maxToolCalls: 1 },
    ).session(ws)
    const outcome = await session.say('go')
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toBe('the model kept calling tools past its 1 tool calls')
    expect(ended(outcome.events)[1]?.result).toBe(`not run: ${limitReached(1)}`)
  })

  it('a cap of zero tells the model before it ends the run', async () => {
    const session = agent([calls('terminal', { command: 'echo 1' }), says('no tools, then')], {
      maxToolCalls: 0,
    }).session(ws)
    const outcome = await session.say('go')
    expect([outcome.status, outcome.text]).toEqual(['completed', 'no tools, then'])
    expect(await told(session)).toEqual([3])
  })

  it('a resumed run counts the calls it made before it stopped', async () => {
    const session = agent(
      [
        step({ tool_calls: [command(1), command(2)] }),
        fails('provider'),
        step({ tool_calls: [command(3), command(4)] }),
        says('ran three'),
      ],
      { maxToolCalls: 3 },
    ).session(ws)
    expect((await session.say('go')).status).toBe('interrupted')
    const outcome = await session.resume()
    expect(outcome.status).toBe('completed')
    expect(ended(outcome.events).map((e) => e.result === REFUSED)).toEqual([false, true])
  })
})

describe('watching a turn', () => {
  it('leaving the stream early stops watching, and the turn goes on', async () => {
    const session = agent([writes('/workspace/a.txt', 'A'), says('done')]).session(ws)
    const stream = session.stream('write a')
    for await (const event of stream) {
      expect(event.kind).toBe('RunStarted')
      break
    }
    const outcome = await stream.wait()
    expect([outcome.status, outcome.text]).toEqual(['completed', 'done'])
    expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
    expect(session.running).toBe(false)
    expect(ws.currentTurn).toBeNull()
  })

  it('runs one turn at a time', async () => {
    const session = agent([says('a'), says('b')]).session(ws)
    const first = session.stream('one')
    const outcome = first.wait()
    await expect(session.say('two')).rejects.toThrow(/already running/)
    expect((await outcome).text).toBe('a')
    expect((await session.say('three')).text).toBe('b')
  })
})

describe('endings', () => {
  it('an error ends the turn failed and keeps its work', async () => {
    const session = agent([writes('/workspace/a.txt', 'A'), fails('error')]).session(ws)
    const outcome = await session.say('go')
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toBe('Error: the scripted model failed')
    expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
    const [run] = await session.runs()
    expect(run?.status).toBe('failed')
    expect(messageText(run?.messages.at(-1) as Message).startsWith(CLOSING_NOTE)).toBe(true)
  })

  it('a provider error interrupts, and resume continues in place', async () => {
    const session = agent([
      writes('/workspace/a.txt', 'A'),
      fails('provider'),
      says('done'),
    ]).session(ws)
    const first = await session.say('go')
    expect([first.status, first.message]).toEqual([
      'interrupted',
      'ScriptOverloaded: the script is overloaded',
    ])
    const second = await session.resume()
    expect([second.status, second.text, second.runId]).toEqual(['completed', 'done', first.runId])
    const runs = await session.runs()
    expect(runs.map((r) => r.status)).toEqual(['completed'])
    expect(runs[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('only an interrupted last turn resumes or is abandoned', async () => {
    const session = agent([says('fine')]).session(ws)
    await expect(session.resume()).rejects.toThrow(/never ran/)
    await session.say('go')
    await expect(session.resume()).rejects.toThrow(/ended completed/)
    await expect(session.abandon('giving up')).rejects.toThrow(/ended completed/)
  })

  it('an abandoned interruption ends with its note', async () => {
    const session = agent([fails('provider')]).session(ws)
    expect((await session.say('go')).status).toBe('interrupted')
    const run = await session.abandon('retries spent', { status: 'cancelled' })
    expect(run.status).toBe('cancelled')
    const [stored] = await session.runs()
    expect(stored?.status).toBe('cancelled')
    expect(messageText(stored?.messages.at(-1) as Message)).toBe(
      `${CLOSING_NOTE} retries spent. The work above this point is real and done.]`,
    )
    expect((await ws.log({ limit: 1 }))[0]?.info).toMatchObject({
      runs: { [run.runId]: 'cancelled' },
      message: 'retries spent',
    })
  })
})

describe('cancel', () => {
  it('stops a model call in flight, and the turn lands', async () => {
    const slow = new Slow()
    const session = new Agent({ model: slow }).session(ws)
    const stream = session.stream('take your time')
    const waiting = stream.wait()
    await slow.whenStarted
    expect(session.cancel()).toBe(true)
    const outcome = await waiting
    expect([outcome.status, outcome.message]).toEqual(['cancelled', STOPPED])
    expect(kinds(outcome.events)).toEqual(['RunStarted', 'RunEnded'])
    const [run] = await session.runs()
    expect(run?.status).toBe('cancelled')
    expect(messageText(run?.messages.at(-1) as Message).startsWith(CLOSING_NOTE)).toBe(true)
    expect(session.running).toBe(false)
    expect(session.cancel()).toBe(false)
  })

  it('says why in the closing note, the first reason standing', async () => {
    const slow = new Slow()
    const session = new Agent({ model: slow }).session(ws)
    const waiting = session.say('take your time')
    await slow.whenStarted
    session.cancel('stopped by the user')
    session.cancel()
    session.cancel('shutting down')
    const outcome = await waiting
    expect(outcome.message).toBe('stopped by the user')
    const [run] = await session.runs()
    expect(
      messageText(run?.messages.at(-1) as Message).startsWith(
        `${CLOSING_NOTE} stopped by the user.`,
      ),
    ).toBe(true)
  })

  it('made as the turn starts, stops it at its first check', async () => {
    const session = agent([says('never reached')]).session(ws)
    const waiting = session.say('go')
    expect(session.cancel()).toBe(true)
    const outcome = await waiting
    expect(outcome.status).toBe('cancelled')
    expect(kinds(outcome.events)).toEqual(['RunStarted', 'RunEnded'])
    const [run] = await session.runs()
    expect(run?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('between tool calls, answers the rest as never run', async () => {
    const two = step({
      tool_calls: [
        { name: 'file_write', args: { path: '/workspace/a.txt', content: 'A' } },
        { name: 'file_write', args: { path: '/workspace/b.txt', content: 'B' } },
      ],
    })
    let session: Session | null = null
    session = agent([two, says('after'), says('next')]).session(ws)
    const outcome = await session.say('write both', {
      onEvent: (e) => {
        if (e.kind === 'ToolEnded') session?.cancel()
      },
    })
    expect(outcome.status).toBe('cancelled')
    expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
    expect(await ws.files.exists('/workspace/b.txt')).toBe(false)
    const [run] = await session.runs()
    const tool = run?.messages.find((m) => m.role === 'tool')
    expect(
      tool?.parts.map((r) =>
        r.kind === 'tool_result' ? [r.content === unanswered(STOPPED), r.isError] : null,
      ),
    ).toEqual([
      [false, false],
      [true, true],
    ])
    // the history is valid: the next turn runs on it
    expect((await session.say('next')).status).toBe('completed')
  })
})

describe('cancel, with code running', () => {
  const coder = async () => {
    if (!existsSync(fileURLToPath(WORKER))) throw new Error('build @agex-ts/world first')
    return store.open('coder', { profile: { code: { worker: { target: 'node', url: WORKER } } } })
  }
  const loop = calls('run_ts', { code: 'while (true) {}' })

  it('interrupts the call in flight, whose result says why the turn ended', async () => {
    const session = agent([loop, says('never said')]).session(await coder())
    const began = Date.now()
    const outcome = await session.say('loop', {
      onEvent: (e) => {
        if (e.kind === 'ToolStarted') setTimeout(() => session.cancel('stopped by the user'), 200)
      },
    })
    expect(outcome.status).toBe('cancelled')
    expect(Date.now() - began).toBeLessThan(10_000)
    const [toolEnded] = ended(outcome.events)
    expect(toolEnded?.result).toBe(cutOff('stopped by the user'))
    expect(kinds(outcome.events).at(-1)).toBe('RunEnded')
    const [run] = await session.runs()
    const tool = run?.messages.find((m) => m.role === 'tool')?.parts[0]
    expect(tool?.kind === 'tool_result' && tool.content).toBe(cutOff('stopped by the user'))
  })

  it('stops a call that had not reached its kernel when the stop came', async () => {
    const session = agent([loop]).session(await coder())
    const began = Date.now()
    const outcome = await session.say('loop', {
      onEvent: (e) => {
        if (e.kind === 'ToolStarted') session.cancel()
      },
    })
    expect(outcome.status).toBe('cancelled')
    expect(Date.now() - began).toBeLessThan(10_000)
    expect(ended(outcome.events)[0]?.result).toBe(cutOff(STOPPED))
  })
})

describe('inbox', () => {
  it("is the embedder's, passed to each turn's session", async () => {
    const inbox = new Inbox()
    const first = agent([says('one')]).session(ws, { inbox })
    await first.say('go')
    inbox.put('for the next agent')
    const second = agent([writes('/workspace/a.txt', 'A'), says('two')]).session(ws, { inbox })
    const outcome = await second.say('go')
    expect(outcome.events.some((e) => e.kind === 'Delivered')).toBe(true)
  })
})
