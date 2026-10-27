/** agex's stored runs, read into the world's trace shape: `AgexTraces`.
 *  After Python agex's test_traces.py. */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store, type TraceEvent } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { describe, expect, it } from 'vitest'
import {
  Agent,
  AgexTraces,
  FORMAT,
  HARNESS,
  type Message,
  type Part,
  type Run,
  ScriptedProvider,
  type Usage,
  dumpRun,
} from '../src/index'

const read = (messages: Message[], over: Partial<Run> = {}) =>
  new AgexTraces().read(dumpRun({ format: FORMAT, runId: 'r1', status: null, messages, ...over }))

const user = (text: string, id = 'u'): Message => ({
  id,
  role: 'user',
  parts: [{ kind: 'text', text }],
})
const reply = (parts: Part[], over: Partial<Message> = {}): Message => ({
  id: 'a',
  role: 'assistant',
  parts,
  ...over,
})
const results = (parts: Part[], id = 't'): Message => ({ id, role: 'tool', parts })
const call = (callId: string, name = 'terminal', args: Record<string, unknown> = {}): Part => ({
  kind: 'tool_call',
  callId,
  name,
  args,
})
const result = (
  callId: string,
  content: string,
  name = 'terminal',
  over: { isError?: boolean } = {},
): Part => ({ kind: 'tool_result', callId, name, content, ...over })
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
})

describe('a run', () => {
  it('says what it says of itself, times in seconds', () => {
    const run = read(
      [
        user('write a'),
        reply([{ kind: 'text', text: 'Writing.' }], {
          model: 'claude-sonnet-5-5',
          usage: usage(100, 20, 80),
        }),
      ],
      {
        runId: 'r7',
        status: 'completed',
        startedAt: 10_000,
        endedAt: 12_500,
        compaction: usage(5, 1, 0, 3),
      },
    )
    expect([run.id, run.status, run.started, run.ended]).toEqual(['r7', 'completed', 10, 12.5])
    expect(run.model).toBe('claude-sonnet-5-5')
    // the replies' and the summary calls'; agex counts no reasoning
    expect(run.tokens).toEqual({
      input: 105,
      output: 21,
      cacheRead: 80,
      cacheWrite: 3,
      reasoning: null,
    })
  })

  it('is running with no status, and counts nothing with no replies', () => {
    const run = read([user('hi')])
    expect(run.status).toBe('running')
    expect(run.model).toBeNull()
    expect(run.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
    })
  })

  it('names each model once, in the order it replied', () => {
    const run = read([
      reply([{ kind: 'text', text: 'a' }], { id: 'a1', model: 'm-small' }),
      reply([{ kind: 'text', text: 'b' }], { id: 'a2', model: 'm-large' }),
      reply([{ kind: 'text', text: 'c' }], { id: 'a3', model: 'm-small' }),
    ])
    expect(run.model).toBe('m-small, m-large')
  })

  it('keeps no system prompt, unless it holds a system message', () => {
    expect(read([user('hi')]).system).toBeNull()
    const system: Message = {
      id: 's',
      role: 'system',
      parts: [{ kind: 'text', text: 'You write.' }],
    }
    const run = read([system, user('hi')])
    expect(run.system).toBe('You write.')
    expect(run.events.map((e) => e.kind)).toEqual(['user'])
  })

  it.each([
    ['a run'],
    [[]],
    [{}],
    [{ runId: 5 }],
    [
      {
        runId: 'r',
        format: FORMAT,
        status: null,
        messages: [{ id: 'm', role: 'bogus', parts: [] }],
      },
    ],
    [{ runId: 'r', format: 99, status: null, messages: [] }],
  ])('refuses a body that is not an agex run: %j', (body) => {
    expect(() => new AgexTraces().read(body)).toThrow()
  })
})

describe('its events', () => {
  it('read in the order the reply came', () => {
    const run = read([
      user('write a'),
      reply([
        { kind: 'thinking', text: 'a file named a', signature: 'sig' },
        { kind: 'text', text: 'Writing it.' },
        call('c1', 'file_write', { path: 'a' }),
      ]),
      results([result('c1', 'wrote a', 'file_write')]),
      reply([{ kind: 'text', text: 'Done.' }], { id: 'a2' }),
    ])
    expect(run.events).toEqual([
      { kind: 'user', text: 'write a' },
      { kind: 'thinking', text: 'a file named a' },
      { kind: 'assistant', text: 'Writing it.' },
      { kind: 'tool', text: 'wrote a', tool: 'file_write', args: { path: 'a' } },
      { kind: 'assistant', text: 'Done.' },
    ] satisfies TraceEvent[])
  })

  it('mark a failed call', () => {
    const run = read([
      reply([call('c1', 'terminal', { command: 'exit 3' })]),
      results([result('c1', 'exit 3', 'terminal', { isError: true })]),
    ])
    expect(run.events.map((e) => [e.text, e.error === true])).toEqual([['exit 3', true]])
  })

  it('match results to calls by id', () => {
    const run = read([
      reply([
        call('c1', 'terminal', { command: 'ls' }),
        call('c2', 'terminal', { command: 'pwd' }),
      ]),
      results([result('c2', '/workspace'), result('c1', 'a.txt')]),
    ])
    expect(run.events.map((e) => [e.args, e.text])).toEqual([
      [{ command: 'ls' }, 'a.txt'],
      [{ command: 'pwd' }, '/workspace'],
    ])
  })

  it('answer only the reply an id follows, when it is used again', () => {
    const run = read([
      reply([call('c1')], { id: 'a1' }),
      results([result('c1', 'first')], 't1'),
      reply([call('c1')], { id: 'a2' }),
      results([result('c1', 'second')], 't2'),
    ])
    expect(run.events.map((e) => e.text)).toEqual(['first', 'second'])
  })

  it('take results spread over tool messages', () => {
    const run = read([
      reply([call('c1'), call('c2')]),
      results([result('c1', 'one')], 't1'),
      results([result('c2', 'two')], 't2'),
    ])
    expect(run.events.map((e) => e.text)).toEqual(['one', 'two'])
  })

  it('leave a call with no result in flight', () => {
    const run = read([user('go'), reply([call('c1', 'terminal', { command: 'sleep 9' })])])
    const tool = run.events.find((e) => e.kind === 'tool')
    expect([tool?.text, tool?.error === true]).toEqual([null, false])
  })

  it('keep a result no call claims, on its own', () => {
    const run = read([
      reply([call('c1')]),
      results([result('c1', 'mine'), result('c9', 'stray', 'file_read')]),
      results([result('c8', 'orphan', 'file_write')], 't2'),
    ])
    expect(run.events.map((e) => [e.tool, e.text, e.args ?? null])).toEqual([
      ['terminal', 'mine', {}],
      ['file_read', 'stray', null],
      ['file_write', 'orphan', null],
    ])
  })

  it('join adjacent text, and drop empty parts', () => {
    const run = read([
      user(''),
      reply([
        { kind: 'thinking', text: '' },
        { kind: 'text', text: 'one ' },
        { kind: 'text', text: 'two' },
        call('c1'),
        { kind: 'text', text: '' },
      ]),
      results([result('c1', '')]),
    ])
    expect(run.events).toEqual([
      { kind: 'assistant', text: 'one two' },
      { kind: 'tool', text: '', tool: 'terminal', args: {} },
    ])
  })

  it("leave a result's images out", () => {
    const run = read([
      reply([call('c1', 'view_image', { path: 'p.png' })]),
      results([
        {
          kind: 'tool_result',
          callId: 'c1',
          name: 'view_image',
          content: 'an image',
          images: [{ kind: 'image', data: 'aGk=', mediaType: 'image/png' }],
        },
      ]),
    ])
    expect(run.events.map((e) => e.text)).toEqual(['an image'])
  })
})

const step = (over: Partial<ModelStep>): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
  ...over,
})
const calls = (name: string, args: Record<string, unknown> = {}) =>
  step({ tool_calls: [{ name, args }] })

describe('an agex session', () => {
  it('reads as a trace', async () => {
    const store = await Store.open(new Memory(), { traces: { [HARNESS]: new AgexTraces() } })
    const worker = await store.open('worker')
    const reader = await store.open('reader')
    try {
      const agent = new Agent({
        model: new ScriptedProvider([
          calls('file_write', { path: '/workspace/a.txt', content: 'A' }),
          calls('terminal', { command: 'exit 3' }),
          step({ text: 'wrote a' }),
        ]),
      })
      const outcome = await agent.session(worker).say('write a')
      expect(outcome.status).toBe('completed')

      await reader.files.attach('worker', 'w', { trace: true })
      const index = await reader.files.readText('w/.trace/index.md')
      expect(index).toContain('001-')
      expect(index).toContain('completed')
      const [dir] = await reader.files.fs.list('/workspace/w/.trace/runs')
      const base = `w/.trace/runs/${dir}`
      const runMd = await reader.files.readText(`${base}/run.md`)
      expect(runMd).toContain('- tool calls: 2 (1 error)')
      expect(runMd).toContain('- system prompt: (not kept)')
      expect(runMd).toContain('- files changed: 1 (changed.md)')
      expect(await reader.files.readText(`${base}/changed.md`)).toContain('- A a.txt')
      expect((await reader.files.fs.list(`/workspace/${base}/events`)).sort()).toEqual([
        '001-user.md',
        '002-tool-file_write.md',
        '003-tool-terminal.md',
        '004-assistant.md',
      ])
      expect(await reader.files.readText(`${base}/events/004-assistant.md`)).toContain('wrote a')
      expect(await reader.files.fs.exists('/workspace/w/.trace/system')).toBe(false)
    } finally {
      await reader.close()
      await worker.close()
    }
  })
})
