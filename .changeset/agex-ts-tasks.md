---
"agex-ts": minor
---

**Tasks:** `agent.task({ name, instructions, params, returns })` runs the agent on a scratch world (`new Agent({ profile, scratch })`) or a fork of `world`, and hands back a value checked against its Standard Schema; `task.success`, `task.fail` and `task.needsInput` end the agent's script, and a task that asks resumes through its outcome or by ref from its `__task__` plane. `live()` declares an input whose methods the code calls on the host, `fromJsonSchema` makes a Standard Schema of a JSON Schema literal, and `agex-ts/conformance` runs agex's task scenarios (`AgexTasks`).
