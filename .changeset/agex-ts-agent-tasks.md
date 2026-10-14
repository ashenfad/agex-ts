---
"agex-ts": minor
---

**Agent-defined tasks:** `agentTasks(agent)` grants `agex`, with which the agent's code defines a task (`agex.task({ name, instructions, params, returns })`, types as JSON Schema) and calls it or `.map`s it; each call runs a helper agent as a delegate of the calling world (or on a scratch world), and a helper that fails or asks throws `agex.TaskFailed` or `agex.TaskNeedsInput`. `standInTasks(answer?)` answers without a model, `AGEX_GUIDE` tells the model how, and `agex-ts/conformance` runs agex's code scenarios (`runCodeScenario`).
