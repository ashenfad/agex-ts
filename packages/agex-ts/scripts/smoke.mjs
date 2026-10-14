#!/usr/bin/env node
/**
 * A manual smoke test against real models: a session per provider, run
 * from the built package (`pnpm build` first). Not part of the suite: it
 * spends tokens, and needs keys.
 *
 * Each provider whose key is set runs two turns with thinking on: one
 * that writes a file through a tool (so the reply's reasoning and tool
 * calls go back to the provider within the turn), and one that asks
 * about it (so the stored run goes back across turns); then a session
 * whose second turn is over a small budget, so it folds the first; then
 * a session that delegates writing a file and waits for the answer; then
 * a task that hands back a typed value, and one that asks and resumes. Then
 * one session moves from the first provider to another
 * mid-conversation, and one turn is stopped mid-stream.
 *
 * Keys come from the environment and are never printed:
 * ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY.
 * Models may be overridden with SMOKE_<PROVIDER>_MODEL.
 *
 * Usage: node scripts/smoke.mjs [anthropic|openai|google|openrouter ...]
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { z } from 'zod'
import { Agent, Policy, runUsage } from '../dist/index.js'

const env = process.env
const PROVIDERS = {
  anthropic: () =>
    env.ANTHROPIC_API_KEY &&
    createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(
      env.SMOKE_ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
    ),
  openai: () =>
    env.OPENAI_API_KEY &&
    createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.SMOKE_OPENAI_MODEL ?? 'gpt-5.4-mini'),
  google: () =>
    env.GEMINI_API_KEY &&
    createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })(
      env.SMOKE_GOOGLE_MODEL ?? 'gemini-3.8-flash',
    ),
  openrouter: () =>
    env.OPENROUTER_API_KEY &&
    createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(
      env.SMOKE_OPENROUTER_MODEL ?? 'anthropic/claude-haiku-5.5',
    ),
}

const wanted = process.argv.slice(2)
const models = Object.entries(PROVIDERS)
  .filter(([key]) => wanted.length === 0 || wanted.includes(key))
  .map(([key, make]) => [key, make()])
  .filter(([key, model]) => {
    if (!model) console.log(`${key}: skipped, no key`)
    return Boolean(model)
  })

const settings = { maxTokens: 8000, thinking: 'medium' }
const primer = 'You work in a sandboxed workspace through tools. Be brief.'
let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function workspace() {
  const store = await Store.open(new Memory())
  return store.open('smoke')
}

const said = (outcome) =>
  `${outcome.status}${outcome.message ? ` (${outcome.message})` : ''}: ${JSON.stringify(outcome.text.slice(0, 120))}`

for (const [key, model] of models) {
  console.log(`${key} (${model.modelId})`)
  try {
    const ws = await workspace()
    const session = new Agent({ model, primer, settings }).session(ws)
    const first = await session.say(
      'Which of 391, 397 and 403 is prime? Work it out, then write just that number to /workspace/prime.txt and reply DONE.',
    )
    check('writes through a tool', first.status === 'completed', said(first))
    const content = await ws.files.readText('/workspace/prime.txt').catch(() => null)
    check('the file landed', content?.trim() === '397', JSON.stringify(content))
    const second = await session.say('What number did you write? Answer from memory, no tools.')
    check('remembers across turns', /397/.test(second.text), said(second))
    const [run] = await session.runs()
    const parts = run.messages.flatMap((m) => m.parts.map((p) => p.kind))
    const usage = runUsage(run)
    console.log(
      `       parts ${[...new Set(parts)].join(',')}; usage in ${usage.inputTokens} out ${usage.outputTokens} cache ${usage.cacheReadTokens}/${usage.cacheWriteTokens}`,
    )
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

for (const [key, model] of models) {
  console.log(`${key}, folded`)
  try {
    const ws = await workspace()
    const opening = await new Agent({ model, primer, settings })
      .session(ws)
      .say('Remember the code word PELICAN. Then list thirty fruits, one per line. No tools.')
    check('first turn', opening.status === 'completed', said({ ...opening, text: '…' }))
    // a budget just above the first request: the second turn's is over it
    const [run] = await new Agent({ model }).session(ws).runs()
    const first = run.messages.find((m) => m.role === 'assistant')?.usage?.inputTokens ?? 0
    const session = new Agent({
      model,
      primer,
      settings,
      compaction: new Policy(first + 10),
    }).session(ws)
    const out = await session.say('What was the code word? Answer from memory, no tools.')
    const folds = out.events.filter((e) => e.kind === 'Compacted').length
    check('folds', folds > 0, `${folds} fold(s), budget ${first + 10}`)
    check('remembers through the fold', /PELICAN/i.test(out.text), said(out))
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

for (const [key, model] of models) {
  console.log(`${key}, delegating`)
  try {
    const ws = await workspace()
    const session = new Agent({ model, primer, settings }).session(ws, { sessions: true })
    try {
      const out = await session.say(
        'Delegate this with the sessions tool, waiting for the answer: write the word OTTER to /workspace/d.txt. Then reply with what the delegate said.',
      )
      check('asks and hears back', out.status === 'completed', said(out))
      const jobs = session.sessions?.list() ?? []
      check(
        'a delegate answered',
        jobs.some((j) => j.status === 'answered'),
        jobs.map((j) => `${j.name} ${j.status}`).join(', '),
      )
      const name = jobs[0]?.name
      const child = name === undefined ? null : await ws.store.open(name)
      const content = await child?.files.readText('/workspace/d.txt').catch(() => null)
      await child?.close()
      check('the delegate wrote it', content?.trim() === 'OTTER', JSON.stringify(content))
    } finally {
      await session.close()
    }
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

for (const [key, model] of models) {
  console.log(`${key}, tasks`)
  try {
    const agent = new Agent({ model, settings })
    const factor = agent.task({
      name: 'factor',
      instructions: 'Factor each number into primes, smallest first.',
      params: { numbers: z.array(z.number().int()) },
      returns: z.array(z.object({ n: z.number().int(), primes: z.array(z.number().int()) })),
    })
    const out = await factor.run({ numbers: [391, 403] })
    const got = JSON.stringify(out.value)
    check(
      'hands back a typed value',
      out.status === 'success' &&
        got ===
          JSON.stringify([
            { n: 391, primes: [17, 23] },
            { n: 403, primes: [13, 31] },
          ]),
      `${out.status}${out.message ? ` (${out.message})` : ''}: ${got}`,
    )
    const pick = agent.task({
      name: 'pick',
      instructions:
        "Pick a colour for the team's logo. You can't know their taste: ask them first with task.needsInput, then hand back their answer, lower case.",
      returns: z.string(),
    })
    const asked = await pick.run({})
    check('asks', asked.status === 'needs_input', `${asked.status}: ${asked.message}`)
    const done = await asked.resume?.('Teal, please.')
    check(
      'resumes from the answer',
      done?.value === 'teal',
      `${done?.status}: ${JSON.stringify(done?.value)}`,
    )
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

if (models.length >= 2) {
  const [[fromKey, from], [toKey, to]] = models
  console.log(`${fromKey} then ${toKey}, one session`)
  try {
    const ws = await workspace()
    const one = await new Agent({ model: from, primer, settings })
      .session(ws)
      .say('Write /workspace/n.txt containing 42, then reply DONE.')
    check(`${fromKey} turn`, one.status === 'completed', said(one))
    const two = await new Agent({ model: to, primer, settings })
      .session(ws)
      .say('What number did you write to n.txt? Answer from memory, no tools.')
    check(`${toKey} reads it`, two.status === 'completed' && /42/.test(two.text), said(two))
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

if (models.length >= 1) {
  const [key, model] = models[0]
  console.log(`${key}, stopped mid-stream`)
  try {
    const ws = await workspace()
    const session = new Agent({ model, primer, settings: { maxTokens: 4000 } }).session(ws)
    const stream = session.stream('Count from 1 to 300, one number per line. No tools.')
    let deltas = 0
    for await (const event of stream) {
      if (event.kind === 'TextDelta' && ++deltas === 3) session.cancel('enough')
    }
    const outcome = await stream.wait()
    check('cancelled', outcome.status === 'cancelled', said(outcome))
  } catch (error) {
    check('ran', false, String(error?.message ?? error))
  }
}

console.log(failures === 0 ? 'all ok' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
