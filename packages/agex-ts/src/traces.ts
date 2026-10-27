/**
 * agex's stored runs, read into the world's neutral trace shape.
 *
 * {@link AgexTraces} is the `TraceSource` for the conversations agex-ts
 * writes: each run under `__conversation__/runs/<id>` is a
 * {@link Run} as {@link dumpRun} stored it. Register it under agex's
 * harness name, and the world renders an agex session as files, at
 * `.trace` beside a worktree's files (`ws-git worktree add --trace`):
 *
 *     const store = await Store.open(kv, { traces: { [HARNESS]: new AgexTraces() } })
 *
 * What it reads from a run, as Python agex's `AgexTraces` does:
 *
 * - **status**: already the world's words; a run with none is
 *   `running`.
 * - **times**: `startedAt` and `endedAt`, milliseconds made seconds.
 * - **model**: the models its replies name, in the order they first
 *   replied, joined by `", "`.
 * - **tokens**: {@link runUsage}, its replies' and its summary calls'.
 *   agex counts no reasoning tokens, so that count is unknown.
 * - **events**, from the messages in order: a `user` message's text; an
 *   `assistant` message's parts as they came, its reasoning, its text,
 *   and one tool event per call, whose result is the `tool` message part
 *   with the call's id among the ones that follow it; and a result no
 *   call claims, on its own. A result's images are left out.
 *
 * agex builds its system prompt for each request and doesn't store it,
 * so a trace has no system prompt unless a run holds a `system` message.
 * Python agex stores its runs under the same harness name in its own
 * spelling; a store holds one or the other.
 */

import type { TraceEvent, TraceRun, TraceSource } from '@agex-ts/world'
import {
  type Message,
  RecordError,
  type Run,
  type ToolCall,
  type ToolResult,
  loadRun,
  messageText,
  runUsage,
} from './record'

/** The trace source for runs agex stored. Register it under the harness
 *  name agex's index carries: `{ traces: { [HARNESS]: new AgexTraces() } }`. */
export class AgexTraces implements TraceSource {
  /** @throws RecordError for a body that isn't an agex run. */
  read(body: unknown): TraceRun {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RecordError(`an agex run is an object, got ${JSON.stringify(body) ?? 'undefined'}`)
    }
    const run = loadRun(body)
    const usage = runUsage(run)
    const system = run.messages.find((m) => m.role === 'system' && messageText(m) !== '')
    return {
      id: run.runId,
      status: run.status ?? 'running',
      started: seconds(run.startedAt),
      ended: seconds(run.endedAt),
      model: models(run),
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        reasoning: null,
      },
      system: system === undefined ? null : messageText(system),
      events: events(run.messages),
    }
  }
}

const seconds = (ms: number | null | undefined): number | null =>
  ms === null || ms === undefined ? null : ms / 1000

function models(run: Run): string | null {
  const out: string[] = []
  for (const message of run.messages) {
    if (message.role === 'assistant' && message.model && !out.includes(message.model)) {
      out.push(message.model)
    }
  }
  return out.join(', ') || null
}

function toolEvent(call: ToolCall | null, result: ToolResult | null): TraceEvent {
  return {
    kind: 'tool',
    text: result === null ? null : result.content,
    tool: call?.name ?? result?.name ?? null,
    ...(call !== null && { args: { ...call.args } }),
    ...(result?.isError === true && { error: true }),
  }
}

function events(messages: readonly Message[]): TraceEvent[] {
  const out: TraceEvent[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i] as Message
    i++
    if (message.role === 'user') {
      const text = messageText(message)
      if (text) out.push({ kind: 'user', text })
    } else if (message.role === 'assistant') {
      // the results of this reply's calls: the tool messages right after it
      const unclaimed: ToolResult[] = []
      while (i < messages.length && (messages[i] as Message).role === 'tool') {
        for (const p of (messages[i] as Message).parts)
          if (p.kind === 'tool_result') unclaimed.push(p)
        i++
      }
      let texts: string[] = []
      const said = () => {
        const text = texts.join('')
        if (text) out.push({ kind: 'assistant', text })
        texts = []
      }
      for (const part of message.parts) {
        if (part.kind === 'text') {
          texts.push(part.text)
          continue
        }
        said()
        if (part.kind === 'thinking') {
          if (part.text) out.push({ kind: 'thinking', text: part.text })
        } else if (part.kind === 'tool_call') {
          const at = unclaimed.findIndex((r) => r.callId === part.callId)
          const result = at < 0 ? null : (unclaimed.splice(at, 1)[0] as ToolResult)
          out.push(toolEvent(part, result))
        }
      }
      said()
      for (const r of unclaimed) out.push(toolEvent(null, r))
    } else if (message.role === 'tool') {
      for (const p of message.parts) if (p.kind === 'tool_result') out.push(toolEvent(null, p))
    }
  }
  return out
}
