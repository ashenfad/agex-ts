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
 * Scope:
 *   - Chat Completions API and compatible reasoning extensions
 *   - Streaming text, reasoning, tool calls, AbortSignal
 *     cancellation, and transient network retry
 *
 * Out of scope (deferred):
 *   - Responses API
 */

export { OpenAI, type OpenAIOptions, type ReasoningEffort } from './client'
