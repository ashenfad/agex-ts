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
 *   ANTHROPIC_API_KEY=... pnpm --filter funcy-example start
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
  name: 'funcy',
  primer:
    'You are great at providing custom functions to the user. You also like to write modules.',
  llm: new Anthropic({
    apiKey,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
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

function logEvent(e: AgentEvent): void {
  if (e.type === 'action') {
    for (const em of e.emissions) {
      if (em.type === 'ts') console.log(`  [ts]\n${indent(em.code)}`)
      else if (em.type === 'thinking') console.log(`  [thinking] ${em.text}`)
      else if (em.type === 'text') console.log(`  [text] ${em.text}`)
      else if (em.type === 'terminal') console.log(`  [terminal] ${em.commands}`)
      else if (em.type === 'fileWrite') console.log(`  [fileWrite] ${em.path}`)
      else if (em.type === 'fileEdit') console.log(`  [fileEdit] ${em.path}`)
    }
  } else if (e.type === 'output') {
    for (const p of e.parts) {
      if (p.type === 'text') console.log(`  [stdout] ${p.text.trim().slice(0, 200)}`)
      else console.log(`  [stdout] <image ${p.format}>`)
    }
  } else if (e.type === 'fail') console.log(`  [fail] ${e.message}`)
  else if (e.type === 'success') console.log('  [success]')
  else console.log(`  [${e.type}]`)
}

function indent(s: string, by = '    '): string {
  return s
    .split('\n')
    .map((l) => by + l)
    .join('\n')
}

async function buildAndCall(prompt: string, callWith: number): Promise<void> {
  console.log(`\nPROMPT: ${prompt}`)
  try {
    const fn = await fnBuilder(prompt, { onEvent: logEvent })
    if (typeof fn !== 'function') {
      console.log(`Returned value isn't a function: ${typeof fn}`)
      return
    }
    const result = await fn(callWith)
    console.log(`fn(${callWith}) = ${JSON.stringify(result)}`)
  } catch (err) {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
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
