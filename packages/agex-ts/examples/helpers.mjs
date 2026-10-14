#!/usr/bin/env node
/**
 * Agent-defined tasks: the agent's own code hands work to helper
 * agents, each a delegate on a fork of its world.
 *
 *     pnpm build && ANTHROPIC_API_KEY=... node examples/helpers.mjs
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { createAnthropic } from '@ai-sdk/anthropic'
import { AGEX_GUIDE, Agent, agentTasks } from 'agex-ts'

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-haiku-5-5')
const agent = new Agent({ model, primer: 'You work in a sandboxed workspace. Be brief.' })

const store = await Store.open(new Memory())
const ws = await store.open('lead', { profile: { hostObjects: { agex: agentTasks(agent) } } })
const chat = agent.session(ws, { sessions: true, toolOptions: { codePrimer: AGEX_GUIDE } })

const out = await chat.say(
  'Find the capital of each of France, Kenya and Peru, one helper per country at once, and write them to /workspace/capitals.json as an object.',
)
console.log(out.text)
console.log(await ws.files.readText('/workspace/capitals.json').catch(() => '(no file)'))
for (const job of chat.sessions?.list() ?? []) console.log(`  ${job.name}: ${job.status}`)

await chat.close()
await ws.close()
