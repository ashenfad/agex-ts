/**
 * Anthropic Messages API provider for agex-ts.
 *
 * Implements `LLMClient.complete()` by lowering the agex-ts neutral
 * turn shape (`NeutralTurn[]`) into Anthropic's content blocks and
 * streaming the response via SSE — no SDK dependency, runs anywhere
 * `fetch` is available (Node 20+, browsers, edge runtimes).
 *
 * The four agex action tools (`ts_action`, `terminal_action`,
 * `write_file`, `edit_file`) are declared from the shared schemas in
 * `agex-ts/render`; this package only handles the Anthropic-specific
 * envelope translation, cache control, extended thinking, and stream
 * parsing.
 */

// Re-exports land here as files arrive.
export {}
