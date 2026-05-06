/**
 * Google Gemini provider for agex-ts.
 *
 * Implements `LLMClient.complete()` against Gemini's
 * `:streamGenerateContent?alt=sse` endpoint. No SDK dep; raw `fetch`
 * + SSE — same architecture as agex-anthropic / agex-openai.
 *
 * Scope (v1):
 *   - generateContent streaming with function calling
 *   - Gemini 3 native thought parts (round-trip via thought_signature)
 *   - tool_config.mode = ANY (force a function call each turn)
 *   - AbortSignal cancellation, transient network retry
 *
 * Out of scope (deferred):
 *   - Grounding tools (google_search, url_context)
 *   - Vertex AI auth (only AI Studio API-key auth)
 *   - File / video parts in multimodal input
 */

export { Gemini, type GeminiOptions } from './client'
