/**
 * agex's own folding: past its budget, a conversation is folded into a
 * summary in what the model is sent, within a run as well, and recorded
 * as the world's fold records. After agex's test_compaction.py: the
 * harness corpus checks the record and its rules
 * (harness-corpus.test.ts); these check what agex decides.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store, type Workspace } from '@agex-ts/world'
import type { ModelStep } from '@agex-ts/world/conformance'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent, type Message, Policy, ScriptedProvider, messageText } from '../src/index'

const BUDGET = 1000
const SUMMARY = 'SUMMARY: the first of two steps has run.'

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
const echo = (word: string, inputTokens = 0) =>
  step({
    tool_calls: [{ name: 'terminal', args: { command: `echo ${word}` } }],
    input_tokens: inputTokens,
  })
const summarizes = (text: string, inputTokens = 0) => says(text, inputTokens)

// the run's first two steps; the second's request reports it over budget
const STEPS = [echo('FIRST-OUTPUT', 100), echo('SECOND-OUTPUT', 5 * BUDGET)]

let store: Store
let ws: Workspace

beforeEach(async () => {
  store = await Store.open(new Memory())
  ws = await store.open('main')
})

function agent(
  steps: ModelStep[] | ScriptedProvider,
  opts: { budget?: number | null; maxSteps?: number } = {},
) {
  const provider = steps instanceof ScriptedProvider ? steps : new ScriptedProvider(steps)
  const budget = opts.budget === undefined ? BUDGET : opts.budget
  const a = new Agent({
    model: provider,
    compaction: budget === null ? null : new Policy(budget),
    ...(opts.maxSteps !== undefined && { maxSteps: opts.maxSteps }),
  })
  return { agent: a, provider }
}

/** Everything a request said, as one text. */
const texts = (request: readonly Message[] | undefined) =>
  (request ?? [])
    .flatMap((m) =>
      m.parts.map((p) =>
        p.kind === 'tool_result'
          ? p.content
          : p.kind === 'tool_call'
            ? JSON.stringify(p.args)
            : p.text,
      ),
    )
    .join('\n')

describe('folding', () => {
  it('folds a run over budget at its earlier steps', async () => {
    const { agent: a, provider } = agent([...STEPS, summarizes(SUMMARY), says('done')])
    const session = a.session(ws)
    const out = await session.say('Do the work in two steps.')
    expect(out.status).toBe('completed')
    expect(out.events.filter((e) => e.kind === 'Compacted')).toHaveLength(1)
    const [fold] = await ws.compaction.folds()
    // the event carries what the fold's record holds, for a transcript
    const event = out.events.find((e) => e.kind === 'Compacted')
    expect(event).toMatchObject({
      summary: fold?.summary,
      tokensBefore: fold?.tokensBefore,
      tokensAfter: fold?.tokensAfter,
    })
    const [run] = await session.runs()
    expect(fold?.through).toBe(run?.messages[2]?.id) // the first step's tool result
    expect([fold?.runs, fold?.first, fold?.summary]).toEqual([1, null, SUMMARY])
    expect(fold?.model).toBe('scripted')
    const sent = texts(provider.seen.at(-1))
    expect(sent).toContain(SUMMARY)
    expect(sent).toContain('Do the work in two steps.')
    expect(sent).toContain('SECOND-OUTPUT')
    expect(sent).not.toContain('FIRST-OUTPUT')
    // the summary request: the run so far up to the fold, then the ask
    const asked = texts(provider.seen.at(-2))
    expect(asked).toContain('FIRST-OUTPUT')
    expect(asked).not.toContain('SECOND-OUTPUT')
    expect(asked).toContain('Reply with the summary alone')
  })

  it('keeps every message in the stored run, and the reply names its fold', async () => {
    const { agent: a } = agent([...STEPS, summarizes(SUMMARY), says('done')])
    const session = a.session(ws)
    await session.say('Do the work in two steps.')
    const [run] = await session.runs()
    expect(run?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(run?.messages.every((m) => !messageText(m).includes(SUMMARY))).toBe(true)
    const [fold] = await ws.compaction.folds()
    expect(run?.messages.at(-1)?.fold).toBe(fold?.through)
    expect(run?.messages[1]?.fold).toBeNull()
    expect(run?.compactionCalls).toBe(1)
  })

  it('lands the fold with the turn, and holds it in the next', async () => {
    const { agent: a, provider } = agent([
      ...STEPS,
      summarizes(SUMMARY),
      says('done'),
      says('again'),
    ])
    const session = a.session(ws)
    await session.say('Do the work in two steps.')
    expect(await ws.compaction.folds()).toHaveLength(1)
    expect(ws.uncommitted).toBe(false)
    const out = await session.say('And now?')
    expect(out.events.map((e) => e.kind)).not.toContain('Compacted')
    const sent = texts(provider.seen.at(-1))
    expect(sent).toContain(SUMMARY)
    expect(sent).toContain('Do the work in two steps.')
    expect(sent).not.toContain('FIRST-OUTPUT')
    expect(sent).toContain('And now?')
  })

  it('folds the earlier runs when a run is too small to fold within', async () => {
    const { agent: a, provider } = agent([
      says('noted', 5 * BUDGET),
      summarizes(SUMMARY),
      says('done'),
    ])
    const session = a.session(ws)
    await session.say('Remember the plan.')
    const out = await session.say('Now act on it.')
    expect(out.events.map((e) => e.kind)).toContain('Compacted')
    const [fold] = await ws.compaction.folds()
    const [first] = await session.runs()
    expect(fold?.through).toBe(first?.messages.at(-1)?.id)
    const sent = texts(provider.seen.at(-1))
    expect(sent).toContain(SUMMARY)
    expect(sent).not.toContain('Remember the plan.')
  })

  it('falls back to a transcript, sent without tools, for a summary with no text', async () => {
    const { agent: a, provider } = agent([...STEPS, echo('1'), summarizes(SUMMARY), says('done')])
    const session = a.session(ws)
    const out = await session.say('Do the work in two steps.')
    expect((await ws.compaction.folds())[0]?.summary).toBe(SUMMARY)
    const transcript = texts(provider.seen.at(-2))
    expect(transcript).toContain('<transcript>')
    expect(transcript).toContain('FIRST-OUTPUT')
    expect(provider.seen.at(-2)?.map((m) => m.role)).toEqual(['user'])
    // the call the summary reply made never ran, and isn't in the run
    expect(out.events.filter((e) => e.kind === 'ToolStarted')).toHaveLength(2)
    expect((await session.runs())[0]?.messages).toHaveLength(6)
  })

  it('folds nothing without a budget, but sends a fold already recorded', async () => {
    const { agent: folding } = agent([...STEPS, summarizes(SUMMARY), says('done')])
    await folding.session(ws).say('Do the work in two steps.')
    const { agent: plain, provider } = agent([says('again', 50 * BUDGET), says('more')], {
      budget: null,
    })
    const session = plain.session(ws)
    await session.say('And now?')
    await session.say('And then?')
    expect(await ws.compaction.folds()).toHaveLength(1)
    expect(texts(provider.seen.at(-1))).toContain(SUMMARY)
  })

  it('measures a reply under a fold as its request was', async () => {
    // A reply's usage counts the request it answered, which had the fold
    // in force then: what that fold had already taken out isn't taken off
    // again. Here the folded turn is large, and the reply after the fold
    // still reports the request over budget, so it folds again.
    const { agent: a } = agent([
      echo('x'.repeat(20_000), 100),
      says('printed', 6 * BUDGET),
      summarizes(SUMMARY),
      says('next', 2 * BUDGET),
      summarizes('SUMMARY: both turns.'),
      says('done'),
    ])
    const session = a.session(ws)
    for (const prompt of ['Print a lot.', 'Go on.', 'And on.']) {
      expect((await session.say(prompt)).status).toBe('completed')
    }
    expect((await ws.compaction.folds()).map((f) => f.runs)).toEqual([1, 2])
  })

  it('counts summary calls against maxSteps', async () => {
    // A fold is made only with a call to spare for the request after it:
    // with no call left over, the request goes unfolded, and no run makes
    // more model calls than maxSteps.
    for (const [limit, folded] of [
      [3, false],
      [4, true],
    ] as const) {
      const own = await (await Store.open(new Memory())).open(`limit${limit}`)
      const { agent: a, provider } = agent([...STEPS, summarizes(SUMMARY), says('done')], {
        maxSteps: limit,
      })
      await a.session(own).say('Do the work in two steps.')
      expect(provider.seen).toHaveLength(limit)
      expect((await own.compaction.folds()).length > 0).toBe(folded)
    }
  })

  it('counts a resumed run’s summary calls against maxSteps', async () => {
    const { agent: a, provider } = agent(
      [...STEPS, summarizes(SUMMARY), step({ fail: 'provider' }), echo('THIRD'), says('done')],
      { maxSteps: 4 },
    )
    const session = a.session(ws)
    expect((await session.say('Do the work in two steps.')).status).toBe('interrupted')
    expect((await session.runs())[0]?.compactionCalls).toBe(1)
    // two replies and a summary before it stopped: one call is left
    const out = await session.resume()
    expect(out.status).toBe('failed')
    expect(out.message).toBe('the model made 4 calls without finishing the turn')
    expect(provider.seen).toHaveLength(5)
  })

  it('puts summary calls in the usage streamed and stored', async () => {
    const { agent: a } = agent([...STEPS, summarizes(SUMMARY, 777), says('done')])
    const session = a.session(ws)
    const out = await session.say('Do the work in two steps.')
    const reported = out.events.flatMap((e) => (e.kind === 'Usage' ? [e.inputTokens] : []))
    expect(reported).toContain(777)
    const [run] = await session.runs()
    expect(run?.compaction?.inputTokens).toBe(777)
  })

  it('stops a turn in its summary call, folding nothing', async () => {
    const steps = [...STEPS]
    let asked: () => void = () => {}
    const summaryAsked = new Promise<void>((resolve) => {
      asked = resolve
    })
    const provider = new ScriptedProvider(() => {
      const next = steps.shift()
      if (next !== undefined) return next
      asked()
      return new Promise<ModelStep>(() => {})
    })
    const { agent: a } = agent(provider)
    const session = a.session(ws)
    const running = session.say('Do the work in two steps.')
    await summaryAsked
    session.cancel('stopped by the person')
    const out = await running
    expect([out.status, out.message]).toEqual(['cancelled', 'stopped by the person'])
    expect(await ws.compaction.folds()).toEqual([])
  })
})

describe('a fold over a range', () => {
  it('replaces its range alone, the summary where the range began', async () => {
    const { agent: first } = agent([says('one'), says('two'), says('three')], { budget: null })
    const session = first.session(ws)
    for (const prompt of ['First.', 'Second.', 'Third.']) await session.say(prompt)
    const runs = await session.runs()
    // a chapter: the second turn alone
    await ws.compaction.record({
      through: runs[1]?.messages.at(-1)?.id as string,
      first: runs[1]?.messages[0]?.id as string,
      summary: 'CHAPTER: the second turn.',
    })
    const { agent: next, provider } = agent([says('four')], { budget: null })
    await next.session(ws).say('Fourth.')
    const sent = (provider.seen.at(-1) ?? []).slice(1).map((m) => messageText(m))
    expect(sent).toEqual([
      'First.',
      'one',
      expect.stringContaining('CHAPTER: the second turn.'),
      "Understood. I'll continue from this summary.",
      'Third.',
      'three',
      'Fourth.',
    ])
  })
})

describe('folding now', () => {
  it('folds the turns so far into a summary, whatever the budget, and commits it', async () => {
    // replies long enough that a summary is the smaller
    const long = (word: string) => `${word} `.repeat(500)
    const { agent: a } = agent([says(long('one'), 300), says(long('two'), 1800)], { budget: null })
    const session = a.session(ws)
    await session.say('First.')
    await session.say('Second.')
    const before = await session.context()
    expect(before).toEqual({ tokens: expect.any(Number), fold: null })
    expect(before.tokens).toBeGreaterThanOrEqual(1800)

    const { agent: folder } = agent([summarizes(SUMMARY, 450)], { budget: null })
    const events: string[] = []
    const out = await folder.session(ws).fold({ onEvent: (e) => events.push(e.kind) })
    expect(out?.fold.summary).toBe(SUMMARY)
    expect(out?.fold.runs).toBe(2)
    expect(out?.usage?.inputTokens).toBe(450)
    expect(events).toEqual(['Usage', 'Compacted'])
    expect((await ws.log({ limit: 1 }))[0]?.info).toMatchObject({ tool: 'fold' })

    const after = await folder.session(ws).context()
    expect(after.fold?.through).toBe(out?.fold.through)
    expect(after.tokens).toBeLessThan(before.tokens)

    // the next turn starts from the summary
    const { agent: next, provider } = agent([says('three')], { budget: null })
    await next.session(ws).say('Third.')
    const sent = (provider.seen.at(-1) ?? []).slice(1).map((m) => messageText(m))
    expect(sent).toEqual([
      expect.stringContaining(SUMMARY),
      "Understood. I'll continue from this summary.",
      'Third.',
    ])
  })

  it('folds nothing with no turn since the last fold, or none at all', async () => {
    const { agent: a } = agent([summarizes(SUMMARY)], { budget: null })
    expect(await a.session(ws).fold()).toBeNull()
    const { agent: b } = agent([says('one'), summarizes(SUMMARY), summarizes('AGAIN')], {
      budget: null,
    })
    const session = b.session(ws)
    await session.say('First.')
    expect(await session.fold()).not.toBeNull()
    expect(await session.fold()).toBeNull()
    expect(await ws.compaction.folds()).toHaveLength(1)
  })

  it('is taken back by a checkout before it', async () => {
    const { agent: a } = agent([says('one'), summarizes(SUMMARY)], { budget: null })
    const session = a.session(ws)
    await session.say('First.')
    const head = (await ws.log({ limit: 1 }))[0]?.hash as string
    await session.fold()
    expect(await ws.compaction.folds()).toHaveLength(1)
    await ws.checkout(head)
    expect(await ws.compaction.folds()).toEqual([])
  })

  it('refuses while the workspace has a turn open, whoever opened it', async () => {
    const { agent: a } = agent([says('one'), summarizes(SUMMARY)], { budget: null })
    await a.session(ws).say('First.')
    // a turn another session of the workspace has open
    await ws.turn('r-other', { harness: 'agex' })
    await expect(a.session(ws).fold()).rejects.toThrow(/a turn is running on this workspace/)
    expect(await ws.compaction.folds()).toEqual([])
  })

  it("leaves another harness's conversation alone", async () => {
    const turn = await ws.turn('r1', { harness: 'other' })
    await turn.end('completed', { body: { said: 'hi' } })
    const { agent: a } = agent([summarizes(SUMMARY)], { budget: null })
    await expect(a.session(ws).fold()).rejects.toThrow(/'other' wrote/)
    await expect(a.session(ws).context()).rejects.toThrow(/'other' wrote/)
    expect(await ws.compaction.folds()).toEqual([])
  })

  it('waits for no turn: one running refuses it', async () => {
    const { agent: a } = agent([echo('WORK'), says('done')], { budget: null })
    const session = a.session(ws)
    const turn = session.stream('Work.')
    const running = turn.wait()
    await expect(session.fold()).rejects.toThrow(/a turn is running/)
    await running
  })
})
