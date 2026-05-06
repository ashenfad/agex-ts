// Public surface — the lean default entry: Agent + createAgent + types.
//
// Heavier surfaces live behind sub-path imports so unused code paths
// tree-shake cleanly:
//
//   - `agex-ts/types`        — contracts only, no runtime code
//   - `agex-ts/state`        — Live / KvgitState / connectState / backend types
//   - `agex-ts/llm-dummy`    — Dummy LLM client for tests
//   - `agex-ts/runtime-eval` — same-realm eval RuntimeAdapter
//
// Production runtime (`@agex-ts/runtime-worker`) and provider clients
// (`@agex-ts/anthropic` etc.) ship as separate packages.

export {
  Agent,
  type AgentOptions,
  type ClsRegistration,
  createAgent,
  type FnRegistration,
  type NsRegistration,
  type TerminalRegistration,
} from './agent'
export { shouldTriggerChaptering } from './chaptering'
export { prettyEvents, prettyTokens } from './pretty'
export type { TaskDefinition } from './task'
export * from './types'
