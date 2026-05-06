/**
 * Mathematical computing — TS port of agex-py's examples/mathy.py.
 *
 * The agent gets the JS `Math` object as a namespace, plus two
 * task functions: one that solves a single math problem, and one
 * that transforms a list of numbers based on a prompt.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... pnpm --filter mathy-example start
 */

import { Anthropic } from 'agex-anthropic'
import { createAgent } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'
import type { AgentEvent } from 'agex-ts/types'

const apiKey = process.env.ANTHROPIC_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('Set ANTHROPIC_API_KEY in the environment.')
}

const agent = await createAgent({
  name: 'mathy_agent',
  primer: 'You are an expert at solving math problems.',
  llm: new Anthropic({
    apiKey,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  }),
  runtime: evalRuntime(),
})

agent.namespace('Math', Math, {
  description: "JavaScript's standard library of math functions and constants.",
})

const runCalculation = agent.task<string, number>({
  description: 'Solve the mathematical problem and return the numeric result.',
})

const transform = agent.task<{ prompt: string; numbers: number[] }, number[]>({
  description: 'Transform a list of numbers based on a prompt.',
})

function logEvent(e: AgentEvent): void {
  if (e.type === 'action') {
    for (const em of e.emissions) {
      if (em.type === 'ts') console.log(`  [ts]\n${indent(em.code)}`)
      else if (em.type === 'terminal') console.log(`  [terminal] ${em.commands}`)
      else if (em.type === 'thinking') console.log(`  [thinking] ${em.text}`)
      else if (em.type === 'text') console.log(`  [text] ${em.text}`)
      else if (em.type === 'fileWrite') console.log(`  [fileWrite] ${em.path}`)
      else if (em.type === 'fileEdit') console.log(`  [fileEdit] ${em.path}`)
    }
  } else if (e.type === 'output') {
    for (const p of e.parts) {
      if (p.type === 'text') console.log(`  [stdout] ${p.text.trim().slice(0, 200)}`)
      else console.log(`  [stdout] <image ${p.format}>`)
    }
  } else if (e.type === 'fail') {
    console.log(`  [fail] ${e.message}`)
  } else if (e.type === 'success') {
    console.log('  [success]')
  } else {
    console.log(`  [${e.type}]`)
  }
}

function indent(s: string, by = '    '): string {
  return s
    .split('\n')
    .map((l) => by + l)
    .join('\n')
}

async function tryRun<T>(label: string, fn: () => Promise<T>): Promise<void> {
  console.log(`\nPROMPT: ${label}`)
  try {
    const result = await fn()
    console.log(`Result: ${JSON.stringify(result, null, 2).slice(0, 500)}`)
  } catch (err) {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await tryRun('What is the square root of 256, multiplied by pi?', () =>
  runCalculation('What is the square root of 256, multiplied by pi?', { onEvent: logEvent }),
)
// Expect ≈ 50.26548245743669

const nums = Array.from({ length: 360 }, (_, i) => i)
await tryRun('Transform these degrees into radians', async () => {
  const r = await transform(
    { prompt: 'Transform these degrees into radians', numbers: nums },
    { onEvent: logEvent },
  )
  return { count: r.length, last3: r.slice(-3) }
})
// Expect 360 entries, last three near 6.23 / 6.25 / 6.27
