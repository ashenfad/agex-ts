---
"agex-ts": patch
---

Correct documentation drift, and remove the dead `EventLog.at()` stub.

Docs had fallen behind several shipped features. Fixed: `FileEvent`'s field is `source: 'user' | 'agent'`, not `fileSource: string`; `ErrorEvent` carries `recoverable` and is embedder-emitted rather than framework-emitted (as is `FileEvent`); `RuntimeAdapter` has five members, not three; `ActionSurface` has three values, and the `'agex-patch'` surface is now documented; `captureSpawnEvents` is documented for the first time, including that it makes clone events durable — which the events page previously described as impossible; Node `worker_threads` is documented as shipped in `sandboxing.md` and `quick-start.md` rather than as roadmap material; `docs/index.md` lists `@agex-ts/git`; `errors.md` no longer claims the bundled providers throw `TransientError` / `FatalError` (they classify with `isTransientNetworkError` and re-throw — the classes are an extension point for custom `LLMClient`s); `quick-start.md` no longer implies task type parameters are validated at runtime without a schema.

Eight source comments pointed at `docs/roadmap/spawn.md`, which doesn't exist; they now point at the spawn section of `docs/api/agent.md`. Three comments stated *wrong reasons* for correct behavior — the event-log index comment claimed the chapter task runs in a child session (it runs in the parent's, and non-overlap comes from the parent awaiting it at a task boundary), the chaptering header described a removed `agent.chapterTask()` API and an after-every-action trigger (it fires at task boundaries), and runtime-worker's Node vitest config claimed the lane had nothing to run.

**Removed:** `EventLog.at()`. It returned `null` unconditionally while its interface doc implied a historical view on versioned state, and the docs already redirected callers to `agent.eventsAt(hash, session)`, which is the working path.

`PolicyBuilder.fingerprint()` now hashes each registration's agent-visible config rather than name-and-count. Registration is add-only, so the old form already caught every mutation of one builder over time; the change matters for comparing two policies, where identical names with different descriptions render different primers but previously produced identical fingerprints. Also exports `ReconfigurableOptions`, `SkillRegistration` and `UrlSpec`, which the docs referenced by name but weren't importable.
