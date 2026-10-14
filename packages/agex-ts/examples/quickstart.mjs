#!/usr/bin/env node
/**
 * A session and a task, end to end, on a real model.
 *
 *     pnpm build && ANTHROPIC_API_KEY=... node examples/quickstart.mjs
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { createAnthropic } from '@ai-sdk/anthropic'
import { Agent } from 'agex-ts'
import { z } from 'zod'

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-haiku-5-5')
const agent = new Agent({ model, primer: 'You work in a sandboxed workspace. Be brief.' })

// A session: the agent works in a workspace, turn by turn. Each change
// it makes is a commit on the workspace's branch.
const store = await Store.open(new Memory())
const ws = await store.open('notes')
const chat = agent.session(ws)

for await (const event of chat.stream('Write a haiku about rivers to /workspace/haiku.txt')) {
  if (event.kind === 'ToolStarted') console.log(`  [${event.name}]`)
}
console.log(await ws.files.readText('/workspace/haiku.txt'))

const again = await chat.say('Now make its second line rhyme with its first.')
console.log(again.text)
console.log(await ws.files.readText('/workspace/haiku.txt'))
console.log(`${(await ws.log()).length} commits on '${ws.session}'`)

// A task: a typed call that runs the agent on a world of its own.
const factor = agent.task({
  name: 'factor',
  instructions: 'Factor n into its primes, smallest first.',
  params: { n: z.number().int() },
  returns: z.array(z.number().int()),
})
console.log('391 =', (await factor({ n: 391 })).join(' × '))

await ws.close()
