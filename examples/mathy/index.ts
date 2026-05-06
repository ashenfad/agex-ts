/**
 * Mathematical computing — TS port of agex-py's examples/mathy.py.
 *
 * The agent gets the JS `Math` object as a namespace, plus two
 * task functions: one that solves a single math problem, and one
 * that transforms a list of numbers based on a prompt.
 *
 * Run:
 *   GEMINI_API_KEY=... pnpm --filter mathy-example start
 */

import { Gemini } from 'agex-gemini'
import { createAgent, prettyEvents } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment.')
}

const agent = await createAgent({
  name: 'mathy_agent',
  primer: 'You are an expert at solving math problems.',
  llm: new Gemini({
    apiKey,
    model: process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
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

async function tryRun<T>(label: string, fn: () => Promise<T>): Promise<void> {
  console.log(`\nPROMPT: ${label}`)
  try {
    const result = await fn()
    console.log(`\nResult: ${JSON.stringify(result, null, 2).slice(0, 500)}`)
  } catch (err) {
    console.log(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// prettyEvents prints one block per discrete AgentEvent — the chunky
// after-the-fact log; pair the funcy example to see prettyTokens
// (the per-character streaming variant).
await tryRun('What is the square root of 256, multiplied by pi?', () =>
  runCalculation('What is the square root of 256, multiplied by pi?', { onEvent: prettyEvents }),
)
// Expect ≈ 50.26548245743669

const nums = Array.from({ length: 360 }, (_, i) => i)
await tryRun('Transform these degrees into radians', async () => {
  const r = await transform(
    { prompt: 'Transform these degrees into radians', numbers: nums },
    { onEvent: prettyEvents },
  )
  return { count: r.length, last3: r.slice(-3) }
})
// Expect 360 entries, last three near 6.23 / 6.25 / 6.27
