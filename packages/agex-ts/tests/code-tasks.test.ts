/**
 * Agent-defined tasks: agent code defines a task with `agex`, and each
 * call runs a helper agent. After agex's test_agent_tasks.py: the shape
 * corpus checks the contract (shape-corpus.test.ts); these check what
 * agex decides. A lead's code and its helpers are one scripted model,
 * routed by what each conversation opens with.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type Profile, Store, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Agent,
  ScriptedProvider,
  type Session,
  agentTasks,
  messageText,
  standInTasks,
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
const runs = (code: string) => step({ tool_calls: [{ name: 'run_ts', args: { code } }] })
const says = (text: string) => step({ text })

type Scripted = ModelStep | (() => Promise<ModelStep>)

/** One model for the lead and its helpers: the lead's conversation
 *  opens with LEAD, and each helper's with its task's instructions,
 *  which open with HELPER. Each helper follows `helper` from its
 *  start. */
function routed(lead: Scripted[], helper: Scripted[] | ((brief: string) => Scripted[])) {
  const turns = new Map<string, number>()
  const briefs: string[] = []
  const provider = new ScriptedProvider((sent) => {
    const first = sent[1] ?? ''
    if (first.startsWith('LEAD')) {
      const next = lead.shift() ?? says('(the lead ran out)')
      return typeof next === 'function' ? next() : next
    }
    const turn = turns.get(first) ?? 0
    turns.set(first, turn + 1)
    if (turn === 0) briefs.push(first)
    const script = typeof helper === 'function' ? helper(first) : helper
    const next = script[turn] ?? says('(the helper ran out)')
    return typeof next === 'function' ? next() : next
  })
  return { agent: new Agent({ model: provider, profile: CODE }), provider, briefs }
}

const SHOUT = `const shout = agex.task({
  name: 'shout',
  instructions: 'HELPER Shout the word back.',
  params: { word: { type: 'string' } },
  returns: { type: 'string' },
})`

let store: Store
const opened: Workspace[] = []
const sessions: Session[] = []

beforeEach(async () => {
  store = await Store.open(new Memory())
})

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close()
  for (const w of opened.splice(0)) await w.close()
})

/** A lead session on a world granted `agex`, delegating unless
 *  `delegating` is false. */
async function lead(
  agent: Agent,
  opts: { tasks?: object; profile?: Profile; delegating?: boolean; session?: string } = {},
) {
  const ws = await store.open(opts.session ?? 'lead', {
    profile: {
      ...CODE,
      ...opts.profile,
      hostObjects: { ...opts.profile?.hostObjects, agex: opts.tasks ?? agentTasks(agent) },
    },
  })
  opened.push(ws)
  const chat = agent.session(ws, { sessions: opts.delegating ?? true })
  sessions.push(chat)
  return { ws, chat }
}

/** What the lead's code printed in its last run. */
async function printed(chat: Session): Promise<string> {
  const run = (await chat.runs()).at(-1)
  return (run?.messages ?? [])
    .flatMap((m) => m.parts.flatMap((p) => (p.kind === 'tool_result' ? [p.content] : [])))
    .join('\n')
}

describe('a task agent code defines', () => {
  it('runs a helper per call, as a delegate, and hands back its value', async () => {
    const { agent } = routed(
      [runs(`${SHOUT}\nconsole.log(await shout({ word: 'hi' }))`), says('done')],
      [runs('await task.success(word.toUpperCase())')],
    )
    const { chat } = await lead(agent)
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('HI')
    expect(chat.sessions?.list().map((j) => [j.name, j.status, j.task])).toEqual([
      ['lead.shout-1', 'answered', 'shout(word="hi")'],
    ])
  })

  it('maps over items at once, the values in order', async () => {
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = async () => {
      started += 1
      if (started === 3) release()
      await gate
      return runs('await task.success(word.toUpperCase())')
    }
    const { agent } = routed(
      [
        runs(
          `${SHOUT}\nconsole.log(JSON.stringify(await shout.map([{ word: 'a' }, { word: 'b' }, { word: 'c' }])))`,
        ),
        says('done'),
      ],
      [held],
    )
    const { chat } = await lead(agent)
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('["A","B","C"]')
  })

  it('runs no more than maxParallel helpers at once', async () => {
    let running = 0
    let most = 0
    const slow = async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 30))
      running -= 1
      return runs('await task.success(word)')
    }
    const { agent } = routed(
      [
        runs(
          `${SHOUT}\nconsole.log(JSON.stringify(await shout.map([{ word: 'a' }, { word: 'b' }, { word: 'c' }])))`,
        ),
        says('done'),
      ],
      [slow],
    )
    const { chat } = await lead(agent, { tasks: agentTasks(agent, { maxParallel: 1 }) })
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('["a","b","c"]')
    expect(most).toBe(1)
  })

  it('raises a helper’s failure or question in the calling code', async () => {
    const code = `${SHOUT}
for (const word of ['fail', 'ask']) {
  try { await shout({ word }) } catch (e) {
    console.log(e.name, e instanceof agex.TaskFailed, e instanceof agex.TaskNeedsInput, e.question ?? '', e.message)
  }
}`
    const { agent } = routed([runs(code), says('done')], (brief) => [
      brief.includes('"fail"')
        ? runs("await task.fail('no voice today')")
        : runs("await task.needsInput('how loud?')"),
    ])
    const { chat } = await lead(agent)
    await chat.say('LEAD go')
    const out = await printed(chat)
    expect(out).toContain("TaskFailed true false  task 'shout' failed: no voice today")
    expect(out).toContain("TaskNeedsInput true true how loud? task 'shout' needs input: how loud?")
  })

  it('refuses a definition where it’s written, saying what to write', async () => {
    const tries = [
      "{ name: 'a b', instructions: 'x' }",
      "{ name: 'shout', instructions: '' }",
      "{ name: 'shout', instructions: 'x', params: { word: null } }",
      "{ name: 'shout', instructions: 'x', params: { agex: { type: 'string' } } }",
      "{ name: 'look', instructions: 'x', returns: { $ref: '#/$defs/D', $defs: { D: { 'x-kind': 'live' } } } }",
      "{ name: 'shout', instructions: 'x', params: { word: 7 } }",
    ]
    const code = tries
      .map((t) => `try { agex.task(${t}) } catch (e) { console.log(e.name + ': ' + e.message) }`)
      .join('\n')
    const { agent } = routed([runs(code), says('done')], [])
    const { chat } = await lead(agent)
    await chat.say('LEAD go')
    expect((await printed(chat)).split('\n').slice(0, tries.length)).toEqual([
      'TypeError: a task\'s name is an identifier, not "a b"',
      "TypeError: task 'shout' has no instructions: they are the job its helper is given",
      "TypeError: task 'shout': parameter 'word' has no type: give it a JSON Schema",
      "TypeError: task 'shout' has a parameter named 'agex', which its helper's world binds (task, host, agex)",
      "TypeError: task 'look' takes or returns D, which is live: a task takes and returns values",
      "TypeError: task 'shout': parameter 'word''s type is a JSON Schema, not number",
    ])
  })

  it('refuses inputs that don’t fit, and takes a Standard Schema with JSON Schema', async () => {
    const code = `${SHOUT}
try { await shout({ word: 7 }) } catch (e) { console.log(e.name + ': ' + e.message) }
const schema = { type: 'string' }
const typed = { '~standard': { version: 1, vendor: 'mine', validate: (v) => ({ value: v }), jsonSchema: { input: () => schema, output: () => schema } } }
const echo = agex.task({ name: 'echo', instructions: 'HELPER Echo.', params: { word: typed }, returns: typed })
console.log(await echo({ word: 'same' }))`
    const { agent } = routed([runs(code), says('done')], [runs('await task.success(word)')])
    const { chat } = await lead(agent)
    await chat.say('LEAD go')
    const out = await printed(chat)
    expect(out).toContain(
      "TypeError: shout()'s argument 'word' must be string: expected a string, got an integer",
    )
    expect(out).toContain('same')
  })

  it('gives the helper its caller’s world, without agex or its files', async () => {
    const db = { find: (word: string) => word.toUpperCase() }
    const look = `const look = agex.task({ name: 'look', instructions: 'HELPER Look around.', params: { word: { type: 'string' } }, returns: { type: 'array', items: {} } })
console.log(JSON.stringify(await look({ word: 'w' })))`
    const { agent, briefs } = routed(
      [runs(look), says('done')],
      [
        runs(
          "await task.success([await fs.exists('/workspace/seed.md'), typeof agex, await db.find(word)])",
        ),
      ],
    )
    const { ws, chat } = await lead(agent, { profile: { hostObjects: { db } } })
    await ws.files.write('/workspace/seed.md', 'seed')
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('[false,"undefined","W"]')
    expect(briefs[0]).toMatch(/^HELPER Look around\./)
  })

  it('lands the caller’s script in its own commit, and tells its model nothing', async () => {
    const code = `await fs.writeText('/workspace/notes.md', 'mine')\n${SHOUT}\nconsole.log(await shout({ word: 'hi' }))`
    const { agent } = routed([runs(code), says('done')], [runs('await task.success(word)')])
    const { ws, chat } = await lead(agent)
    await chat.say('LEAD go')
    const tools = (await ws.log()).map((c) => c.info?.tool)
    expect(tools.slice(0, 2)).toEqual(['turn', 'run_ts'])
    expect(await ws.files.readText('/workspace/notes.md')).toBe('mine')
    const [run] = await chat.runs()
    expect(run?.messages.every((m) => !messageText(m).includes('delegate'))).toBe(true)
    expect(chat.sessions?.take()).toEqual([])
    expect(chat.sessions?.outstanding()).toEqual([])
  })

  it('doesn’t count a helper’s time against the caller’s script', async () => {
    const slow = (code: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      return runs(code)
    }
    const { agent } = routed(
      [runs(`${SHOUT}\nconsole.log(await shout({ word: 'took it' }))`), says('done')],
      [slow('const x = 1'), slow('await task.success(word)')],
    )
    const { chat } = await lead(agent, { profile: { code: { ...CODE.code, timeout: 1 } } })
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('took it')
  })

  it('runs on a scratch world with no helper open, or when the embedder says', async () => {
    for (const [delegating, scratch] of [
      [false, false],
      [true, true],
    ] as const) {
      store = await Store.open(new Memory())
      const { agent } = routed(
        [runs(`${SHOUT}\nconsole.log(await shout({ word: 'hi' }))`), says('done')],
        [runs('await task.success(word.toUpperCase())')],
      )
      const { chat } = await lead(agent, { delegating, tasks: agentTasks(agent, { scratch }) })
      await chat.say('LEAD go')
      expect(await printed(chat)).toContain('HI')
      expect(await store.sessions()).toEqual(['lead'])
    }
  })

  it('gives a helper only the objects its task names', async () => {
    const db = { find: () => 'db' }
    const mail = { send: () => 'mail' }
    const code = `const held = (objects) => agex.task({ name: 'held', instructions: 'HELPER What do you hold?', objects, returns: { type: 'array', items: { type: 'string' } } })
console.log(JSON.stringify(await held(['db'])({})))
console.log(JSON.stringify(await held([])({})))
try { await held(['nope'])({}) } catch (e) { console.log(e.name + ': ' + e.message) }`
    const { agent } = routed(
      [runs(code), says('done')],
      // both helpers open with the same brief, so share one count of turns
      Array(2).fill(runs("await task.success(['db', 'mail'].filter((n) => n in host))")),
    )
    const { chat } = await lead(agent, { profile: { hostObjects: { db, mail } } })
    await chat.say('LEAD go')
    const out = (await printed(chat)).split('\n')
    expect(out.slice(0, 3)).toEqual([
      '["db"]',
      '[]',
      "TypeError: task 'held': objects names nope, which its caller doesn't hold",
    ])
  })

  it('stops the helpers the code is waiting on when the turn is cancelled', async () => {
    let reached: () => void = () => {}
    const asked = new Promise<void>((resolve) => {
      reached = resolve
    })
    const forever = async () => {
      reached()
      return new Promise<ModelStep>(() => {})
    }
    const { agent } = routed(
      [runs(`${SHOUT}\nawait shout({ word: 'hi' })`), says('done')],
      [forever],
    )
    const { chat } = await lead(agent)
    const running = chat.say('LEAD go')
    await asked
    chat.cancel('stopped')
    expect((await running).status).toBe('cancelled')
    const [job] = chat.sessions?.list() ?? []
    expect(job?.status).toBe('cancelled')
    await chat.close() // waits for the helper to wind down
    const helper = await store.open('lead.shout-1')
    expect((await agent.session(helper).runs())[0]?.status).toBe('cancelled')
    await helper.close()
  })
})

describe('the stand-in', () => {
  const ask = `${SHOUT}
const rank = agex.task({ name: 'rank', instructions: 'Rank.', params: { scores: { type: 'array', items: { type: 'integer' } } }, returns: { type: 'object', properties: { best: { type: 'integer' }, names: { type: 'array', items: { type: 'string' } }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['best', 'names', 'note'] } })
console.log(JSON.stringify([await shout({ word: 'hi' }), await rank({ scores: [3, 1] })]))`

  it('answers at once with the simplest value of the return type', async () => {
    const { agent, provider } = routed([runs(ask), says('done')], [])
    const { chat } = await lead(agent, { tasks: standInTasks() })
    await chat.say('LEAD go')
    expect(await printed(chat)).toContain('["",{"best":0,"names":[],"note":null}]')
    expect(provider.seen).toHaveLength(2) // the lead's two replies, no helper's
  })

  it('answers by its answer, checked, and says when it can’t', async () => {
    const answer = (name: string, inputs: Record<string, unknown>) =>
      name === 'shout' ? String(inputs.word).toUpperCase() : { best: 'three' }
    const code = `${ask.replace(/console.log[^\n]*$/, '')}
console.log(await shout({ word: 'hi' }))
try { await rank({ scores: [3] }) } catch (e) { console.log(e.name + ': ' + e.message) }`
    const { agent } = routed([runs(code), says('done')], [])
    const { chat } = await lead(agent, { tasks: standInTasks(answer) })
    await chat.say('LEAD go')
    const out = await printed(chat)
    expect(out).toContain('HI')
    expect(out).toContain("TaskFailed: task 'rank' failed: the stand-in's value doesn't fit:")
  })
})
