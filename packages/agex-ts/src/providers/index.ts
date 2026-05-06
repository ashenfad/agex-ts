/**
 * Shared building blocks for LLM provider packages.
 *
 * The agex-anthropic / agex-openai / agex-gemini packages each
 * implement the `LLMClient` contract by lowering `NeutralTurn[]`
 * into a provider-specific wire format and translating provider-
 * specific streaming events back into the agent loop's
 * `TokenChunk` stream. The translation cadence is identical
 * across all three:
 *
 *   provider stream events
 *     → translator (provider-specific)
 *     → ToolCallEvent stream (this module's vocabulary)
 *     → parseToolEvents (this module)
 *     → TokenChunk stream (consumed by agex-ts task loop)
 *
 * Plus the SSE byte-decoder (`parseSseEvents`) and the streaming
 * JSON-string extractor (`JsonStringExtractor`), neither of which
 * has anything to say about which provider is on the other end.
 *
 * Provider packages import from `agex-ts/providers` for these
 * pieces and only ship their adapter, stream translator, and
 * client (request body shape, auth, defaults).
 */

export type {
  TextDelta,
  TextPartEvent,
  ThinkingDelta,
  ThinkingPartEvent,
  ToolCallArgDelta,
  ToolCallEnd,
  ToolCallEvent,
  ToolCallStart,
  UsageHolder,
} from './events'
export { type JsonStringDelta, JsonStringExtractor } from './json-stream'
export { parseToolEvents } from './parser'
export { parseSseEvents } from './sse'
export {
  isTransientNetworkError,
  safeReadText,
  sleep,
  sseLinesToEventDicts,
} from './http'
