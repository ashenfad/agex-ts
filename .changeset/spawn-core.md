---
"agex-ts": minor
---

Add `spawn` — agent-authored ephemeral sub-tasks. Under a spawn-capable runtime (the same-realm `evalRuntime` for now), a top-level agent's code gets a `spawn` builtin that runs an ephemeral, memoryless clone of the agent to fulfil a typed sub-task: `await spawn('summarize /docs/spec.md')`, or the structured form `await spawn({ task, input, output })` where `output` is a JSON Schema the result is validated against. Fan out with native `Promise.all`; concurrency is bounded by the new `maxSpawns` agent option (default 8; set `0` to disable).

Clones run the same task loop on throwaway state (fresh in-memory event log + cache, a blank VFS with the parent's `/skills` overlay mounted), so nothing touches the parent's session and clone events stream to `onEvent` (tagged `<name>:spawn#<n>`) without entering the durable log. Clones are depth-1 (no nested `spawn`), inherit the parent's registrations, and inherit output enforce-and-retry. A clone failure rejects the `spawn` promise as an ordinary recoverable error the parent can catch or surface — never as the parent's own failure.

The worker-runtime bridge for `spawn` is a follow-up; under the worker runtime `spawn` is not yet injected (and the primer won't teach it).
