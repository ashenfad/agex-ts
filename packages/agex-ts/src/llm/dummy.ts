/**
 * `Dummy` — first-class shipped test double for `LLMClient`.
 *
 * Cycles through a scripted sequence of `LLMResponse | Error` items.
 * An `Error` entry is thrown on that turn — useful for simulating
 * provider failures mid-task.
 *
 * Inspection state on every instance:
 *   `callCount`, `allSystems`, `allEvents`
 * lets tests assert against what the agent sent. Subsequent commits
 * will add `allRenderedMessages` once the wire-format renderer
 * exists; for v1 the render-pass hook is a no-op extension point.
 *
 * Designed to be both internal (agex-ts's own integration tests)
 * and public (downstream consumers writing tests for THEIR agents
 * without spending tokens). Lives in core, not in any provider
 * package, because it has no provider dep.
 */

import type {
  AgentEvent,
  Emission,
  LLMClient,
  LLMConfig,
  LLMRequest,
  LLMResponse,
  TokenChunk,
} from '../types'

export interface DummyOptions {
  /** Scripted responses cycled by `callCount % len`. An `Error` entry
   *  is thrown on that turn. Defaults to a single one-emission
   *  response that just calls `taskSuccess(null)`. */
  readonly responses?: ReadonlyArray<LLMResponse | Error>
  /** Static value to return from `summarize()`. If omitted, the
   *  default is a deterministic stringification of the inputs. */
  readonly summaryResponse?: string
  /** Error to throw from `summarize()`. Takes precedence over
   *  `summaryResponse` when both are set. */
  readonly summaryError?: Error
  /** Surfaced via `dumpConfig()`. */
  readonly model?: string
  /** Surfaced via `dumpConfig()`. Default `60`. */
  readonly timeoutSeconds?: number
}

const DEFAULT_RESPONSES: ReadonlyArray<LLMResponse> = [
  {
    emissions: [
      {
        type: 'ts',
        code: 'taskSuccess(null)',
        thinking: 'Default Dummy response: succeed with null.',
      },
    ],
  },
]

export class Dummy implements LLMClient {
  readonly model: string
  readonly timeoutSeconds: number

  /** Scripted response sequence. */
  responses: ReadonlyArray<LLMResponse | Error>

  /** Number of `complete()` calls observed. Useful for tests asserting
   *  that the agent's loop made the expected number of turns. */
  callCount = 0

  /** Every `system` string the agent passed in, in order. */
  allSystems: string[] = []

  /** Every `events` array the agent passed in, in order. */
  allEvents: AgentEvent[][] = []

  summaryResponse: string | undefined
  summaryError: Error | undefined

  constructor(opts: DummyOptions = {}) {
    this.model = opts.model ?? 'dummy'
    this.timeoutSeconds = opts.timeoutSeconds ?? 60
    this.responses = opts.responses ?? DEFAULT_RESPONSES
    this.summaryResponse = opts.summaryResponse
    this.summaryError = opts.summaryError
  }

  // ---------- LLMClient surface ----------

  complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk> {
    this.allSystems.push(request.system)
    this.allEvents.push([...request.events])
    const item = this.responses[this.callCount % this.responses.length]
    this.callCount++

    if (item instanceof Error) throw item

    return emissionsToTokens(item as LLMResponse, signal)
  }

  async summarize(
    system: string,
    content: string | ReadonlyArray<AgentEvent>,
    _signal?: AbortSignal,
  ): Promise<string> {
    if (this.summaryError !== undefined) throw this.summaryError
    if (this.summaryResponse !== undefined) return this.summaryResponse
    const flat = typeof content === 'string' ? content : `${content.length} events`
    return `${system} ${flat}`.trim() || 'dummy'
  }

  dumpConfig(): LLMConfig {
    // Errors don't structured-clone cleanly across realms, so the
    // dumped config drops them — matches agex-py's behavior.
    const serializable = this.responses.filter((r): r is LLMResponse => !(r instanceof Error))
    return {
      provider: 'dummy',
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      extras: {
        responses: serializable,
      },
    }
  }

  static fromConfig(config: LLMConfig): Dummy {
    const extras = (config.extras ?? {}) as { responses?: LLMResponse[] }
    return new Dummy({
      model: config.model,
      timeoutSeconds: config.timeoutSeconds,
      responses: extras.responses ?? DEFAULT_RESPONSES,
    })
  }
}

// ---------------------------------------------------------------------------
// Internal — emit one TokenChunk per emission with done=true.
// ---------------------------------------------------------------------------

async function* emissionsToTokens(
  response: LLMResponse,
  signal: AbortSignal | undefined,
): AsyncIterable<TokenChunk> {
  const emissions = response.emissions
  for (let i = 0; i < emissions.length; i++) {
    if (signal?.aborted) return
    const em = emissions[i] as Emission
    yield {
      type: 'emission',
      content: emissionContent(em),
      done: true,
      emissionIndex: i,
      emission: em,
    }
  }
  // Final marker carries token totals (if the response specified them).
  yield {
    type: 'emission',
    content: '',
    done: true,
    emissionIndex: emissions.length,
    ...(response.inputTokens !== undefined && { inputTokens: response.inputTokens }),
    ...(response.outputTokens !== undefined && { outputTokens: response.outputTokens }),
  }
}

function emissionContent(em: Emission): string {
  switch (em.type) {
    case 'ts':
      return em.code
    case 'terminal':
      return em.commands
    case 'fileWrite':
      return em.content
    case 'fileEdit':
      return em.content
    case 'text':
      return em.text
    case 'thinking':
      return em.text
    default: {
      const exhaustive: never = em
      void exhaustive
      return ''
    }
  }
}
