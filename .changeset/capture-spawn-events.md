---
"agex-ts": minor
---

Add an opt-in `captureSpawnEvents` flag (on `AgentOptions` /
`ReconfigurableOptions`, default `false`). When on, each `spawn` clone's
full event timeline is captured onto the parent task's terminal event
(`SuccessEvent` / `FailEvent` / `CancelledEvent`) as a new optional
`spawnEvents` field — an array of `{ spawnIndex, events }` entries
(`SpawnEventsEntry`), keyed by the clone's `spawnIndex` and covering
every clone the task launched across all its turns. This gives a durable,
groupable record of sub-task activity for host UX drill-down and audit,
without the per-clone kvgit keys / lifecycle a separate sub-session would
need.

The payload is invisible to the parent LLM: `renderEvents` reads only
`result` / `message` / `taskName` off a terminal event, so the captured
events ride along unseen (no filtering required). Capture also works with
no host `onEvent` attached. Off by default and uncapped when on — a wide
fan-out produces a correspondingly large terminal event.
