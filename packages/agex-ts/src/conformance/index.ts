/**
 * agex's shape corpus, vendored (`scripts/sync-shape-corpus.mjs`): the
 * task API's scenarios, which agex-ts runs as Python agex does.
 */

export { AGEX_COMMIT, CODE_SCENARIOS, TASK_SCENARIOS } from './corpus/index'
export * from './shape'
export { AgexHarnessSession, agexHarness } from './harness'
export {
  AgexTasks,
  type Observed,
  OpenedScenario,
  type OutcomeView,
  type PlaneView,
  RAN_OUT,
  Script,
  checkTaskScenario,
  runTaskScenario,
} from './tasks'
export {
  type CodeView,
  LEAD,
  MARK,
  SPELLED,
  checkCodeScenario,
  runCodeScenario,
} from './code-tasks'
