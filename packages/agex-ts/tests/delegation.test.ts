/**
 * Delegation: a session asks through its `sessions` tool, and each
 * delegate is an agex session of the asking agent on a fork of its
 * world (`Runner`). After agex's test_delegation.py: the harness corpus
 * checks the contract (tier 5); these check what agex decides.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Agent, Runner, ScriptedProvider, type Session, messageText } from '../src/index'

const step = (over: Partial<ModelStep>): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
  ...over,
})
const says = (text: string) => step({ text })
const calls = (name: string, args: Record<string, unknown>) =>
  step({ tool_calls: [{ name, args }] })
const ask = (name: string, task: string, more: Record<string, unknown> = {}) =>
  calls('sessions', { action: 'ask', name, task, ...more })
const writes = (path: string, content: string) => calls('file_write', { path, content })
const shell = (command: string) => calls('terminal', { command })

type Scripted = ModelStep | (() => Promise<ModelStep>)

/** One scripted model for every session: a request goes to the script
 *  whose key opens the session's first message, so a parent and its
 *  delegates each follow their own. A step may be a function, for one
 *  the test holds. */
function routed(scripts: Record<string, Scripted[]>) {
  const queues = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, [...v]]))
  const asked: string[] = []
  const provider = new ScriptedProvider((sent) => {
    for (const text of sent) {
      const key = Object.keys(queues).find((k) => text.startsWith(k))
      if (key === undefined) continue
      asked.push(key)
      const next = queues[key]?.shift()
      if (next === undefined) throw new Error(`${key}'s script ran out`)
      return typeof next === 'function' ? next() : next
    }
    throw new Error(`no script for a session opening ${JSON.stringify(sent[1]?.slice(0, 60))}`)
  })
  return { agent: new Agent({ model: provider }), asked }
}

/** A step held until `release`. */
function held(then: ModelStep) {
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const step = async () => {
    reached()
    await gate
    return then
  }
  return { step, started, release: () => release() }
}

let store: Store
let ws: Workspace
const open: Session[] = []

beforeEach(async () => {
  store = await Store.open(new Memory())
  ws = await store.open('lead')
})

afterEach(async () => {
  for (const session of open.splice(0)) await session.close()
  await ws.close()
})

function delegating(agent: Agent, on: Workspace = ws): Session {
  const session = agent.session(on, { sessions: true })
  open.push(session)
  return session
}

describe('delegation', () => {
  it('a delegate does the work, and its answer comes back', async () => {
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT write s.txt', { wait: true }), says('the scout wrote it')],
      SCOUT: [writes('/workspace/s.txt', 'S'), says('wrote s.txt')],
    })
    const chat = delegating(agent)
    const outcome = await chat.say('LEAD get it written')
    expect([outcome.status, outcome.text]).toEqual(['completed', 'the scout wrote it'])
    const [job] = chat.sessions?.list() ?? []
    expect([job?.name, job?.status]).toEqual(['lead.scout', 'answered'])
    const answer = chat.sessions?.result('lead.scout')
    expect(answer?.text).toBe('wrote s.txt')
    expect(answer?.changed.seed).toEqual(['/workspace/s.txt'])
    // the caller's world is its own: the work is on the delegate's branch
    expect(await ws.files.exists('/workspace/s.txt')).toBe(false)
    const scout = await store.open('lead.scout')
    expect(await scout.files.readText('/workspace/s.txt')).toBe('S')
    await scout.close()
    // the answer was the result the lead's model read
    const [run] = await chat.runs()
    const result = run?.messages[2]?.parts[0]
    expect(result?.kind === 'tool_result' && result.content).toMatch(/^wrote s\.txt\n/)
  })

  it('a delegate hears from its own delegate before it answers', async () => {
    // the scout asks a sub-delegate and ends its turn to wait; the sub's
    // answer wakes it, and the reply it gives then is its answer
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT find it', { wait: true }), says('done')],
      SCOUT: [ask('sub', 'SUB look in the attic'), says('waiting on sub'), says('sub found it')],
      SUB: [says('it is in the attic')],
    })
    const chat = delegating(agent)
    await chat.say('LEAD find it')
    expect(chat.sessions?.result('lead.scout').text).toBe('sub found it')
    expect(await store.exists('lead.scout.sub')).toBe(true)
  })

  it('a delegate whose turn fails answers failed, saying how', async () => {
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT try', { wait: true }), says('it failed')],
      SCOUT: [step({ fail: 'error' })],
    })
    const chat = delegating(agent)
    await chat.say('LEAD try it')
    const answer = chat.sessions?.result('lead.scout')
    expect(answer?.status).toBe('failed')
    expect(answer?.text).toMatch(/ended failed/)
  })

  it('an answer that lands between turns opens a woken turn', async () => {
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT note it'), says('asked'), says('the scout noted it')],
      SCOUT: [says('noted')],
    })
    const chat = delegating(agent)
    await chat.say('LEAD have it noted')
    expect(await chat.sessions?.wait(10_000)).toEqual(['lead.scout'])
    const outcome = await chat.wake()
    expect(outcome.text).toBe('the scout noted it')
    const opening = messageText((await chat.runs()).at(-1)?.messages[0] as never)
    expect(opening).toMatch(/noted/)
    expect(opening).toMatch(/scout/)
    // delivered once: nothing is left waiting
    expect(chat.sessions?.outstanding()).toEqual([])
  })

  it('a delegate holds its parent’s profile', async () => {
    const own = await store.open('host', { profile: { variables: { WHO: 'the lead' } } })
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT who', { wait: true }), says('done')],
      SCOUT: [shell('echo $WHO'), says('said who')],
    })
    expect(new Runner(agent, own).settings.profile.variables).toEqual({ WHO: 'the lead' })
    const chat = delegating(agent, own)
    await chat.say('LEAD ask who')
    const scout = await store.open('host.scout')
    const [run] = await agent.session(scout).runs()
    const result = run?.messages[2]?.parts[0]
    expect(result?.kind === 'tool_result' && result.content).toMatch(/the lead/)
    await scout.close()
    await chat.close()
    await own.close()
  })

  it('cancelling a delegate stops its turn', async () => {
    const hold = held(says('unreachable'))
    const { agent } = routed({
      LEAD: [ask('scout', 'SCOUT take your time'), says('asked')],
      SCOUT: [hold.step],
    })
    const chat = delegating(agent)
    await chat.say('LEAD start it')
    await hold.started
    expect(chat.sessions?.cancel('lead.scout').status).toBe('cancelled')
    await chat.close() // waits for the scout's run to wind down
    const scout = await store.open('lead.scout')
    const [run] = await agent.session(scout).runs()
    expect(run?.status).toBe('cancelled')
    await scout.close()
  })
})

describe('across agents', () => {
  it('new delegates run on the agent asking, and those in flight on theirs', async () => {
    const hold = held(says('one done'))
    const a = routed({
      LEAD: [ask('one', 'ONE take your time'), says('asked one')],
      ONE: [hold.step],
    })
    const lead = delegating(a.agent)
    await lead.say('LEAD start one')
    await hold.started
    // a new agent for the next turn: the workspace's helper, its job too
    const b = routed({
      LEAD: [ask('two', 'TWO quickly'), says('asked two')],
      TWO: [says('two done')],
    })
    const next = delegating(b.agent)
    expect(next.sessions).toBe(lead.sessions)
    expect(next.sessions?.outstanding()).toEqual(['lead.one'])
    await next.say('LEAD start two')
    hold.release()
    const helper = next.sessions
    // wait() returns at once while an answer is uncollected: poll
    while (helper?.list().some((job) => job.status === 'running')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(helper?.result('lead.one').text).toBe('one done')
    expect(helper?.result('lead.two').text).toBe('two done')
    // each delegate's model is its asker's (the order is the runs')
    expect([a.asked.sort(), b.asked.sort()]).toEqual([
      ['LEAD', 'LEAD', 'ONE'],
      ['LEAD', 'LEAD', 'TWO'],
    ])
  })

  it('a turn after the helper closed opens another', async () => {
    const { agent } = routed({ LEAD: [says('one'), says('two')] })
    const chat = delegating(agent)
    await chat.say('LEAD one')
    const before = chat.sessions
    await chat.close()
    await chat.say('LEAD two')
    expect(chat.sessions).not.toBe(before)
    expect(chat.sessions?.closed).toBe(false)
  })
})
