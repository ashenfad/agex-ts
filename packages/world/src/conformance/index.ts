/**
 * nontainer's harness conformance corpus, and a runner for it: a
 * harness built on the world runs the scenarios its capabilities cover.
 */

export { SCENARIOS } from './corpus/index'
export { CorpusDelegates, PATIENCE } from './delegates'
export {
  type DelegateView,
  type Delegation,
  type Harness,
  type HarnessSession,
  type Observation,
  type OpenOptions,
  type RunView,
  Clock,
  EXHAUSTED,
  applies,
  check,
  eventNames,
  runScenario,
} from './runner'
export {
  type Act,
  CAPABILITIES,
  type CheckoutAct,
  type Delegate,
  type DelegateExp,
  type EventStep,
  type Expect,
  type ForkAct,
  type ModelStep,
  type Scenario,
  type Step,
  type ToolCall,
  type TurnAct,
} from './scenario'
