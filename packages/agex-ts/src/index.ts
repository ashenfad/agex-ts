// Public surface — re-export the canonical types and runtime entry points.
// Sub-path consumers can import narrower slices from `agex-ts/types`,
// `agex-ts/state`, or `agex-ts/llm-dummy` without pulling everything.

export {
  Agent,
  type AgentOptions,
  type ClsRegistration,
  createAgent,
  type FnRegistration,
  type NsRegistration,
  type TerminalRegistration,
} from './agent'
export * from './types'
