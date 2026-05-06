/**
 * TS-to-JS transform run on the host *before* code is shipped to the
 * worker.
 *
 * Default: `ts-blank-space`, the same lightweight type-stripper
 * `evalRuntime` uses. Whitespace-preserving, zero wasm download,
 * runs in microseconds. Throws on non-erasable TS (enum, namespace,
 * decorators, parameter properties) — fine because the agent's primer
 * already steers away from those forms.
 *
 * Embedders that need fuller TS coverage (or full bundling for
 * `helpers/*.ts` imports later) can pass their own `transform`:
 * `(code) => string | Promise<string>`. agex-studio plans to wire
 * `esbuild-wasm` here. The runtime-worker package itself stays
 * dependency-light by not importing esbuild.
 *
 * Running the transform on the host (not inside the worker) keeps
 * the worker bundle tiny, surfaces syntax errors before we pay the
 * cost of message-passing, and lets embedders amortize one-time
 * setup (esbuild-wasm initialization) on their side instead of
 * inside every fresh worker.
 */

import tsBlankSpace from 'ts-blank-space'

/** Function signature for a TS → JS transform. */
export type TransformFn = (code: string) => string | Promise<string>

export const defaultTransform: TransformFn = (code: string): string => tsBlankSpace(code)
