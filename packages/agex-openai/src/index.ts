/**
 * OpenAI Chat Completions provider for agex-ts.
 *
 * Implements `LLMClient.complete()` against OpenAI's `/v1/chat/
 * completions` endpoint. Uses raw `fetch` + SSE — no SDK dep,
 * runs anywhere `fetch` is available.
 *
 * `baseUrl` override makes this drop-in for any OpenAI-compatible
 * server: ollama (`http://localhost:11434/v1`), vLLM, LM Studio,
 * OpenRouter, Together, Anyscale, etc.
 *
 * Scope (v1):
 *   - Chat Completions API (gpt-4o, gpt-4o-mini, gpt-4-turbo,
 *     local models)
 *   - Streaming, tool calls, AbortSignal cancellation, transient
 *     network retry
 *
 * Out of scope (deferred):
 *   - Responses API (gpt-5 / o-series reasoning models)
 *   - OpenRouter `reasoning_details` round-trip
 */

export { OpenAI, type OpenAIOptions } from './client'
