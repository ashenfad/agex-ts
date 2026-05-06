/**
 * Function generation — TS port of agex-py's examples/funcy.py.
 *
 * The agent generates an executable JS function from a text prompt
 * and returns it via `taskSuccess(fn)`. Because evalRuntime runs in
 * the host realm, the returned function is a real callable JS
 * function the host can invoke directly — no JSON serialization or
 * RPC bridge in between.
 *
 * Run:
 *   GOOGLE_API_KEY=... pnpm --filter funcy-example start
 */

import { Gemini } from 'agex-gemini'
import { createAgent, prettyTokens } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'

const apiKey = process.env.GOOGLE_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('Set GOOGLE_API_KEY in the environment.')
}

const agent = await createAgent({
  name: 'funcy',
  primer:
    'You are great at providing custom functions to the user. You also like to write modules.',
  llm: new Gemini({
    apiKey,
    model: process.env.GOOGLE_MODEL ?? 'gemini-3.1-flash',
  }),
  runtime: evalRuntime(),
  state: { type: 'versioned', storage: 'memory' },
})

agent.namespace('Math', Math, {
  description: "JavaScript's standard library of math functions and constants.",
})

// We don't have a runtime check for "is callable" via Standard
// Schema, so we type the output as `unknown` and cast at the call
// site. That matches agex-py's `Callable` return type — it's about
// what the agent emits, not a validated shape.
type GeneratedFn = (...args: unknown[]) => unknown

const fnBuilder = agent.task<string, GeneratedFn>({
  description: 'Build a callable JS function from a text prompt and return it via taskSuccess.',
})

async function buildAndCall(prompt: string, callWith: number): Promise<void> {
  console.log(`\nPROMPT: ${prompt}`)
  try {
    // prettyTokens streams the model's thinking + code character-by-
    // character as it arrives — the same role pprint_tokens plays in
    // agex-py.
    const fn = await fnBuilder(prompt, { onToken: prettyTokens })
    if (typeof fn !== 'function') {
      console.log(`\nReturned value isn't a function: ${typeof fn}`)
      return
    }
    const result = await fn(callWith)
    console.log(`\nfn(${callWith}) = ${JSON.stringify(result)}`)
  } catch (err) {
    console.log(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// First call: agent invents a "next prime above N" function.
await buildAndCall('a fn for the first prime larger than a given number.', 500_000)
// Expect 500009

// Second call: agent reuses the conversation context — "next lower"
// implies the same prime-finding subject. Without the multi-task
// session memory we render in renderEvents, this would be
// underspecified.
await buildAndCall('Okay, now make it the next lower prime.', 500_000)
// Expect 499979
