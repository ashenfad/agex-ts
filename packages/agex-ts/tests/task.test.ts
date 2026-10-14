/**
 * Tasks: a typed call that runs an agent on a world of its own. After
 * agex's test_tasks.py and test_task_resume.py: the shape corpus checks
 * the contract (shape-corpus.test.ts); these check what agex decides.
 * Agent code is a scripted model's `run_ts` calls, run in the world's
 * kernel (build @agex-ts/world first).
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type Profile, Store, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  FINISHED,
  NUDGE,
  NeedsInput,
  PREVIEW,
  ScriptedProvider,
  TASK_PLANE,
  TaskFailed,
  TaskInterrupted,
  brief,
  fromJsonSchema,
  live,
  messageText,
  preview,
} from '../src/index'

const WORKER = new URL('../../world/dist/worker.node.js', import.meta.url)
const CODE: Profile = { code: { worker: { target: 'node', url: WORKER } } }

const step = (over: Partial<ModelStep>): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
  ...over,
})
const code = (c: string) => step({ tool_calls: [{ name: 'run_ts', args: { code: c } }] })
const says = (text: string) => step({ text })

const Score = z.object({ student: z.string(), total: z.number().int() })
const Ranking = z.object({ best: z.string(), scores: z.array(Score) })
const SCORES = [
  { student: 'ada', total: 7 },
  { student: 'bo', total: 2 },
]

let store: Store
let ws: Workspace

beforeEach(async () => {
  store = await Store.open(new Memory())
  ws = await store.open('main', { profile: CODE })
})

function agent(
  steps: ModelStep[] | ScriptedProvider,
  opts: { profile?: Profile; scratch?: Store } = {},
) {
  const provider = steps instanceof ScriptedProvider ? steps : new ScriptedProvider(steps)
  return {
    agent: new Agent({
      model: provider,
      profile: { ...CODE, ...opts.profile },
      ...(opts.scratch !== undefined && { scratch: opts.scratch }),
    }),
    provider,
  }
}

const rankTask = (a: Agent) =>
  a.task({
    name: 'rank',
    instructions: 'Rank the scores, best first.',
    params: { scores: z.array(Score) },
    returns: Ranking,
  })

const RANKS = 'await task.success({ best: scores[0].student, scores })'

/** What the last request said, as one text. */
const lastSent = (p: ScriptedProvider) =>
  (p.seen.at(-1) ?? [])
    .flatMap((m) =>
      m.parts.map((part) => ('text' in part ? part.text : 'content' in part ? part.content : '')),
    )
    .join('\n')

describe('a task', () => {
  it('hands back the value its code made', async () => {
    const { agent: a } = agent([code(RANKS)])
    expect(await rankTask(a)({ scores: SCORES })).toEqual({ best: 'ada', scores: SCORES })
  })

  it('run returns the outcome', async () => {
    const { agent: a } = agent([code(RANKS)])
    const out = await rankTask(a).run({ scores: SCORES })
    expect([out.status, out.message, out.ref]).toEqual(['success', null, null])
    expect(out.value).toEqual({ best: 'ada', scores: SCORES })
  })

  it('with no return type finishes with no value', async () => {
    const { agent: a } = agent([code('await task.success()')])
    const out = await a.task({ name: 'note', instructions: 'Note it.' }).run({})
    expect([out.status, out.value]).toEqual(['success', null])
  })

  it('refuses a value that does not fit, as a TypeError the script can fix', async () => {
    const { agent: a, provider } = agent([
      code(
        `try { await task.success({ best: 7, scores }) } catch (e) { console.log(String(e)); ${RANKS} }`,
      ),
    ])
    expect((await rankTask(a).run({ scores: SCORES })).status).toBe('success')
    expect(provider.seen).toHaveLength(1)
  })

  it('makes an uncaught TypeError a result the model reads and fixes', async () => {
    const { agent: a, provider } = agent([code("await task.success({ best: 'ada' })"), code(RANKS)])
    expect((await rankTask(a).run({ scores: SCORES })).status).toBe('success')
    expect(lastSent(provider)).toContain('TypeError: task.success: at value.scores: ')
  })

  it('hands back what the return type gives, transformed', async () => {
    const { agent: a } = agent([code("await task.success('ada')")])
    const shout = a.task({
      name: 'shout',
      instructions: 'Shout.',
      returns: z.string().transform((s) => s.toUpperCase()),
    })
    expect(await shout({})).toBe('ADA')
  })

  it('ends the script at the call that settles it, even one caught', async () => {
    const { agent: a } = agent([
      code(`try { ${RANKS} } catch {}\nawait fs.writeText('/workspace/after.txt', 'x')`),
    ])
    const out = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    expect(out.status).toBe('success')
    const kept = await store.open(out.ref as string)
    expect(await kept.files.exists('/workspace/after.txt')).toBe(false)
    await kept.close()
  })

  it('runs no call after the one that finished it', async () => {
    const both = step({
      tool_calls: [
        { name: 'run_ts', args: { code: RANKS } },
        { name: 'file_write', args: { path: '/workspace/late.txt', content: 'x' } },
      ],
    })
    const { agent: a } = agent([both])
    const out = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    const kept = await store.open(out.ref as string)
    expect(await kept.files.exists('/workspace/late.txt')).toBe(false)
    const [run] = await a.session(kept).runs()
    const results = run?.messages
      .at(-1)
      ?.parts.map((p) => (p.kind === 'tool_result' ? p.content : ''))
    expect(results?.[0]).toBe(FINISHED)
    expect(results?.[1]).toMatch(/^not run/)
    await kept.close()
  })

  it('ends failed with task.fail, which a call raises as TaskFailed', async () => {
    const { agent: a } = agent([code("await task.fail('there are no scores to rank')")])
    const out = rankTask(a)({ scores: [] })
    await expect(out).rejects.toThrow(TaskFailed)
    await expect(out).rejects.toThrow("task 'rank' failed: there are no scores to rank")
  })

  it('sends a model that stops back to finish, twice, then fails', async () => {
    const { agent: a, provider } = agent([says('hmm'), says('hmm'), says('hmm')])
    const out = await rankTask(a).run({ scores: SCORES })
    expect([out.status, out.message]).toEqual([
      'failed',
      'the model stopped 3 times without calling task.success, task.fail or task.needsInput',
    ])
    expect(provider.seen).toHaveLength(3)
    expect(lastSent(provider)).toContain(NUDGE)
  })

  it('carries on once a nudge brings the model back', async () => {
    const { agent: a } = agent([says('hmm'), code(RANKS)])
    expect((await rankTask(a).run({ scores: SCORES })).status).toBe('success')
  })

  it('is interrupted by a transient provider error, and failed by another', async () => {
    const { agent: a } = agent([step({ fail: 'provider' })])
    await expect(rankTask(a)({ scores: SCORES })).rejects.toThrow(TaskInterrupted)
    const { agent: b } = agent([step({ fail: 'error' })])
    expect((await rankTask(b).run({ scores: SCORES })).status).toBe('failed')
  })

  it('stops when its caller does, and a kept fork keeps the run', async () => {
    let reached: () => void = () => {}
    const asked = new Promise<void>((resolve) => {
      reached = resolve
    })
    const provider = new ScriptedProvider(() => {
      reached()
      return new Promise<ModelStep>(() => {})
    })
    const { agent: a } = agent(provider)
    const stop = new AbortController()
    const running = rankTask(a).run(
      { scores: SCORES },
      { world: ws, keep: true, signal: stop.signal },
    )
    await asked
    stop.abort()
    const out = await running
    expect(out.status).toBe('cancelled')
    const kept = await store.open(out.ref as string)
    expect((await a.session(kept).runs())[0]?.status).toBe('cancelled')
    await kept.close()
  })
})

describe("a task's world", () => {
  it('is a fork, gone after, and the world is untouched', async () => {
    await ws.files.write('/workspace/notes.md', 'mine')
    const head = ws.head
    const { agent: a } = agent([
      code(`await fs.writeText('/workspace/notes.md', 'theirs')\n${RANKS}`),
    ])
    await rankTask(a)({ scores: SCORES }, { world: ws })
    expect(ws.head).toBe(head)
    expect(await ws.files.readText('/workspace/notes.md')).toBe('mine')
    expect(await store.sessions()).toEqual(['main'])
  })

  it('kept, holds the task’s work and its run', async () => {
    const { agent: a } = agent([code(`await fs.writeText('/workspace/out.md', 'done')\n${RANKS}`)])
    const out = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    expect(out.ref).toMatch(/^main\.rank-[0-9a-f]{8}$/)
    const kept = await store.open(out.ref as string)
    expect(await kept.files.readText('/workspace/out.md')).toBe('done')
    expect((await a.session(kept).runs())[0]?.status).toBe('completed')
    await kept.close()
  })

  it('starts from the last commit, committing nothing here', async () => {
    const lazy = await store.open('lazy', { profile: CODE, autocommit: false })
    await lazy.files.write('/workspace/pending.md', 'not yet')
    const head = lazy.head
    const { agent: a } = agent([
      code("await task.success(await fs.exists('/workspace/pending.md'))"),
    ])
    const seen = a.task({ name: 'seen', instructions: 'Look.', returns: z.boolean() })
    expect(await seen({}, { world: lazy })).toBe(false)
    expect(lazy.head).toBe(head)
    expect(lazy.uncommitted).toBe(true)
    await lazy.close()
  })

  it('has the world’s profile, and the agent’s for a scratch world', async () => {
    const who = await store.open('who', { profile: { ...CODE, variables: { WHO: 'the world' } } })
    const say = (a: Agent) => a.task({ name: 'who', instructions: 'Who?', returns: z.string() })
    const { agent: a } = agent([code('await task.success(env.WHO)')])
    expect(await say(a)({}, { world: who })).toBe('the world')
    const { agent: b } = agent([code('await task.success(env.WHO)')], {
      profile: { variables: { WHO: 'the agent' } },
    })
    expect(await say(b)({})).toBe('the agent')
    await who.close()
  })

  it('refuses an input named like a host object of the world, and keep with no world', async () => {
    const held = await store.open('held', { profile: { ...CODE, hostObjects: { scores: {} } } })
    const { agent: a } = agent([])
    await expect(rankTask(a).run({ scores: SCORES }, { world: held })).rejects.toThrow(
      /already binds scores/,
    )
    await expect(rankTask(a).run({ scores: SCORES }, { keep: true })).rejects.toThrow(
      /keep needs world/,
    )
    await held.close()
  })
})

describe("a task's inputs", () => {
  it('are checked at the call, before any model call', async () => {
    const { agent: a, provider } = agent([])
    await expect(
      rankTask(a)({ scores: [{ student: 'ada', total: '7' }] } as never),
    ).rejects.toThrow(
      "rank()'s argument 'scores' must be { student: string; total: number }[]: at [0].total",
    )
    await expect(rankTask(a)({ scores: SCORES, more: 1 } as never)).rejects.toThrow(
      "rank() got inputs it doesn't take: more",
    )
    expect(provider.seen).toHaveLength(0)
  })

  it('are a copy: a task that changes them leaves the caller’s alone', async () => {
    const { agent: a } = agent([code(`scores[0].total = 99\n${RANKS}`)])
    const mine = structuredClone(SCORES)
    const out = await rankTask(a)({ scores: mine })
    expect(out.scores[0]?.total).toBe(99)
    expect(mine[0]?.total).toBe(7)
  })

  it('refuse a live part in data', async () => {
    const { agent: a } = agent([])
    const anything = a.task({ name: 'any', instructions: 'Hold it.', params: { x: z.any() } })
    await expect(anything({ x: { call: () => 1 } })).rejects.toThrow(
      "any()'s argument 'x' holds a live part (at call: a live function)",
    )
  })

  it('bind a live input as it is, its methods run on the host and checked', async () => {
    const looked: string[] = []
    const directory = {
      lookup(key: string) {
        looked.push(key)
        return key.toUpperCase()
      },
    }
    const { agent: a, provider } = agent([
      code(
        "try { await directory.lookup(7) } catch (e) { console.log(String(e)) }\nawait task.success(await directory.lookup('ada'))",
      ),
    ])
    const look = a.task({
      name: 'look',
      instructions: 'Look up ada.',
      params: {
        directory: live({
          name: 'Directory',
          description: 'The school’s directory.',
          methods: {
            lookup: {
              args: { key: z.string() },
              returns: z.string(),
              description: 'A name as filed.',
            },
          },
        }),
      },
      returns: z.string(),
    })
    expect(await look({ directory })).toBe('ADA')
    expect(looked).toEqual(['ada'])
    expect(messageText(provider.seen[0]?.[1] as never)).toContain(
      '/** The school’s directory. */\nconst directory: {\n  /** A name as filed. */\n  lookup(key: string): Promise<string>\n}',
    )
  })

  it('a live input with no methods given offers its public ones', async () => {
    class Counter {
      n = 0
      bump() {
        this.n += 1
        return this.n
      }
      _secret() {
        return 1
      }
    }
    const counter = new Counter()
    const { agent: a, provider } = agent([
      code('await counter.bump()\nawait task.success(await counter.bump())'),
    ])
    const count = a.task({
      name: 'count',
      instructions: 'Count.',
      params: { counter: live() },
      returns: z.number(),
    })
    expect(await count({ counter })).toBe(2)
    expect(messageText(provider.seen[0]?.[1] as never)).toContain(
      '  bump(...args: unknown[]): Promise<unknown>\n}',
    )
  })
})

describe("a task's definition", () => {
  it('refuses reserved and odd names, a live return, and what is no schema', () => {
    const { agent: a } = agent([])
    const t = (opts: object) => () => a.task({ name: 'ok', instructions: '', ...opts } as never)
    expect(t({ params: { task: z.string() } })).toThrow(/parameter named 'task'/)
    expect(t({ params: { 'a-b': z.string() } })).toThrow(/parameter named 'a-b'/)
    expect(t({ name: 'not ok' })).toThrow(/a task's name is an identifier/)
    expect(t({ returns: live({ name: 'Client' }) })).toThrow(
      "task 'ok' returns Client, which is live",
    )
    expect(t({ params: { x: 'a string' } })).toThrow(/parameter 'x' is a Standard Schema/)
  })

  it('briefs the model: the job, the inputs, how to finish, and the types', () => {
    const { agent: a } = agent([])
    const defs = {
      Score: {
        type: 'object',
        description: 'One student’s total.',
        properties: {
          student: { type: 'string' },
          total: { type: 'integer', description: 'Points.' },
        },
        required: ['student', 'total'],
      },
    }
    const rank = a.task({
      name: 'rank',
      instructions: 'Rank them.',
      params: { scores: fromJsonSchema({ type: 'array', items: { $ref: '#/$defs/Score' } }, defs) },
      returns: fromJsonSchema({ type: 'array', items: { $ref: '#/$defs/Score' } }, defs),
    })
    expect(brief(rank.spec, { data: { scores: SCORES }, live: {} })).toBe(
      [
        'Rank them.',
        'Inputs, bound by name:\n- `scores: Score[]` = [{"student":"ada","total":7},{"student":"bo","total":2}]',
        "When it's done, call `await task.success(value)` with a `Score[]`.",
        'The types its values have; build values of these shapes:\n```ts\n/** One student’s total. */\ntype Score = {\n  student: string\n  /** Points. */\n  total: number\n}\n```',
      ].join('\n\n'),
    )
  })

  it('previews an input within bounds', () => {
    const text = preview('x'.repeat(2 * PREVIEW))
    expect(text.startsWith(`"${'x'.repeat(PREVIEW - 1)}…`)).toBe(true)
    expect(preview(new Uint8Array(3))).toBe('"<3 bytes>"')
  })
})

describe('a task that asks', () => {
  const asks = code("await task.needsInput('By total, or by the best single score?')")

  it('ends needs_input with its question, and a call raises NeedsInput', async () => {
    const { agent: a } = agent([asks, asks])
    const out = await rankTask(a).run({ scores: SCORES })
    expect([out.status, out.message]).toEqual([
      'needs_input',
      'By total, or by the best single score?',
    ])
    expect(out.ref).toMatch(/^rank-/)
    const error = await rankTask(a)({ scores: SCORES }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NeedsInput)
    expect((error as NeedsInput).question).toBe('By total, or by the best single score?')
    expect((error as NeedsInput).ref).toMatch(/^rank-/)
  })

  it('resumes from the answer, with its conversation', async () => {
    const { agent: a, provider } = agent([asks, code(RANKS)])
    const out = await rankTask(a).run({ scores: SCORES })
    const done = await out.resume?.('By total.')
    expect(done?.status).toBe('success')
    const sent = lastSent(provider)
    expect(sent).toContain('Rank the scores, best first.')
    expect(sent).toContain('The answer to your question:\nBy total.')
    // a scratch world resumed to its end is gone
    expect(done?.ref).toBeNull()
    await expect(rankTask(a).resume(out.ref as string, 'again')).rejects.toThrow(
      /no scratch world .* is kept in this process/,
    )
  })

  it('shows an answer that is not text as a value, and can ask again', async () => {
    const { agent: a, provider } = agent([asks, asks, code(RANKS)])
    const first = await rankTask(a).run({ scores: SCORES })
    const second = await first.resume?.({ by: 'total' })
    expect(lastSent(provider)).toContain('The answer to your question:\n{"by":"total"}')
    expect(second?.status).toBe('needs_input')
    expect((await second?.resume?.('total'))?.status).toBe('success')
  })

  it('keeps its fork while it waits, and a finished resume drops it unless kept', async () => {
    const { agent: a } = agent([asks, code(RANKS), asks, code(RANKS)])
    const first = await rankTask(a).run({ scores: SCORES }, { world: ws })
    expect(await store.exists(first.ref as string)).toBe(true)
    await first.resume?.('By total.')
    expect(await store.exists(first.ref as string)).toBe(false)
    const kept = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    const done = await kept.resume?.('By total.')
    expect(done?.ref).toBe(kept.ref)
    expect(await store.exists(kept.ref as string)).toBe(true)
  })

  it('records the spec, inputs, state and value on its plane', async () => {
    const { agent: a } = agent([asks, code(RANKS)])
    const out = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    const plane = async () => {
      const kept = await store.open(out.ref as string)
      const p = kept.plane(TASK_PLANE)
      const read = { keys: await p.keys(), spec: await p.get('spec'), state: await p.get('state') }
      await kept.close()
      return read
    }
    const waiting = await plane()
    expect(waiting.keys).toEqual(['inputs/scores', 'spec', 'state'])
    expect(waiting.state).toEqual({
      status: 'needs_input',
      question: 'By total, or by the best single score?',
    })
    expect(waiting.spec).toMatchObject({
      format: 1,
      name: 'rank',
      world: 'main',
      params: { scores: { type: '{ student: string; total: number }[]', stored: true } },
    })
    await out.resume?.('By total.')
    const done = await plane()
    expect(done.keys).toEqual(['inputs/scores', 'spec', 'state', 'value'])
    expect(done.state).toEqual({ status: 'success' })
  })

  it('resumes by ref after a restart, from the agent’s scratch store', async () => {
    const kv = new Memory()
    const scratch = await Store.open(kv)
    const { agent: a } = agent([asks], { scratch })
    const out = await rankTask(a).run({ scores: SCORES })
    // a restart: the store opened again, the agent and task made again
    const again = await Store.open(kv)
    const { agent: b } = agent([code(RANKS)], { scratch: again })
    const done = await rankTask(b).resume(out.ref as string, 'By total.')
    expect(done.value).toEqual({ best: 'ada', scores: SCORES })
    expect(await again.exists(out.ref as string)).toBe(false)
  })

  it('refuses a resume that does not fit', async () => {
    const { agent: a } = agent([asks, code(RANKS)])
    const out = await rankTask(a).run({ scores: SCORES }, { world: ws, keep: true })
    const ref = out.ref as string
    const rank = rankTask(a)
    await expect(rank.resume(ref, 'x', { world: ws, live: { scores: {} } })).rejects.toThrow(
      "rank.resume(): 'scores' is stored with the task",
    )
    await expect(rank.resume(ref, 'x', { world: ws, live: { other: {} } })).rejects.toThrow(
      "rank.resume() got inputs the task doesn't take: other",
    )
    const elsewhere = await store.open('elsewhere', { profile: CODE })
    await expect(rank.resume(ref, 'x', { world: elsewhere })).rejects.toThrow(
      "ran on world 'main', not 'elsewhere'",
    )
    const other = a.task({
      name: 'rank',
      instructions: '',
      params: { scores: z.array(z.string()) },
    })
    await expect(other.resume(ref, 'x', { world: ws })).rejects.toThrow(
      /isn't a world of this task: it holds rank\(scores: \{ student: string; total: number \}\[\]\)/,
    )
    await out.resume?.('By total.')
    await expect(rank.resume(ref, 'x', { world: ws })).rejects.toThrow(
      `task 'rank' at '${ref}' isn't waiting for an answer: it is success`,
    )
    await elsewhere.close()
  })

  it('a success has nothing to resume', async () => {
    const { agent: a } = agent([code(RANKS)])
    expect((await rankTask(a).run({ scores: SCORES })).resume).toBeUndefined()
  })
})
