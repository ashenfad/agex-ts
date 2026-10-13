/**
 * A provider that replies from a script, for tests, after Python agex's
 * `ScriptedProvider`.
 *
 * The script is the conformance corpus's: one `ModelStep` per model call
 * (text, reasoning, tool calls, or a failure). Give a list of steps, or a
 * function that returns the next one (a conformance runner's
 * `clock.next`, which fires the scenario's outside events between
 * replies, and is passed the text of each message the request carried).
 *
 * Tool calls get ids of their own (`call_1`, `call_2`, …), as a
 * provider's would. A step's `input_tokens` is the reply's reported
 * input. A list that runs out replies with the runner's exhausted step,
 * so a loop that asks once too often ends rather than hangs.
 */

import { EXHAUSTED, type ModelStep } from '@agex-ts/world/conformance'
import {
  type Provider,
  type ProviderEvent,
  type Settings,
  type StreamOptions,
  type ToolSpec,
  aborted,
} from './provider'
import { type Message, type Part, newId } from './record'

/** The model's name in a scripted reply. */
export const SCRIPTED = 'scripted'

/** What a step with `fail: 'provider'` throws: an overloaded provider,
 *  worth resuming. */
export class ScriptOverloaded extends Error {
  override readonly name: string = 'ScriptOverloaded'
  readonly status = 529
  constructor() {
    super('the script is overloaded')
  }
}

/** Replies from a script of model steps. */
export class ScriptedProvider implements Provider {
  readonly name = SCRIPTED
  /** What each request sent, in order. */
  readonly seen: (readonly Message[])[] = []
  readonly #next: (sent: readonly string[]) => ModelStep | Promise<ModelStep>
  #calls = 0

  constructor(
    steps: Iterable<ModelStep> | ((sent: readonly string[]) => ModelStep | Promise<ModelStep>),
  ) {
    if (typeof steps === 'function') {
      this.#next = steps
    } else {
      const queue = [...steps]
      this.#next = () => queue.shift() ?? EXHAUSTED
    }
  }

  async *stream(
    messages: readonly Message[],
    _tools: readonly ToolSpec[],
    _settings: Settings,
    opts: StreamOptions = {},
  ): AsyncIterable<ProviderEvent> {
    const signal = opts.signal
    // Checked at every point the stream waits, as a real request's is.
    const check = () => {
      if (signal?.aborted) throw aborted(signal)
    }
    check()
    this.seen.push([...messages])
    const step = await untilAborted(this.#next(texts(messages)), signal)
    if (step.fail === 'provider') throw new ScriptOverloaded()
    if (step.fail === 'error') throw new Error('the scripted model failed')
    const parts: Part[] = []
    if (step.thinking !== '') {
      yield { kind: 'ThinkingDelta', text: step.thinking }
      check()
      parts.push({ kind: 'thinking', text: step.thinking, provider: SCRIPTED })
    }
    if (step.text !== '') {
      yield { kind: 'TextDelta', text: step.text }
      check()
      parts.push({ kind: 'text', text: step.text, provider: SCRIPTED })
    }
    for (const call of step.tool_calls) {
      this.#calls += 1
      parts.push({
        kind: 'tool_call',
        callId: `call_${this.#calls}`,
        name: call.name,
        args: call.args,
        provider: SCRIPTED,
      })
    }
    yield {
      kind: 'Reply',
      message: {
        id: newId(),
        role: 'assistant',
        parts,
        model: SCRIPTED,
        provider: SCRIPTED,
        usage: {
          inputTokens: step.input_tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    }
  }

  transient(error: unknown): boolean {
    return error instanceof ScriptOverloaded
  }
}

/** `value`, unless `signal` aborts first: then the abort's error. */
function untilAborted<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return Promise.resolve(value)
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(aborted(signal))
    signal.addEventListener('abort', stop, { once: true })
    Promise.resolve(value).then(
      (v) => {
        signal.removeEventListener('abort', stop)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', stop)
        reject(e)
      },
    )
  })
}

/** The text of each part a request carried, in order: what a script's
 *  `clock.next` is passed. */
export function texts(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      const text =
        part.kind === 'text' || part.kind === 'thinking'
          ? part.text
          : part.kind === 'tool_result'
            ? part.content
            : ''
      if (text !== '') out.push(text)
    }
  }
  return out
}
