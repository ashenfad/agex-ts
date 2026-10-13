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
 * whose second turn is over a small budget, so it folds the first. Then
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
      compaction: new Policy(first + 100),
    }).session(ws)
    const out = await session.say('What was the code word? Answer from memory, no tools.')
    const folds = out.events.filter((e) => e.kind === 'Compacted').length
    check('folds', folds > 0, `${folds} fold(s), budget ${first + 100}`)
    check('remembers through the fold', /PELICAN/i.test(out.text), said(out))
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
