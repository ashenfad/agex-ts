---
"agex-ts": minor
"@agex-ts/runtime-worker": patch
---

Enforce `paramsSchema` on registered fns, and drop the inert capability flags.

`paramsSchema` was documented as validating the agent's call args before a host fn runs, but nothing ever read it — both runtimes invoked the handler with raw args. An embedder who attached a schema believing it gated agent-supplied arguments had an unguarded host function. It's now enforced at both runtimes' host-side dispatch sites via a shared `enforceParamsSchema` helper (exported from `agex-ts/policy`), including when an agent-authored helper module under `/helpers/` calls the fn.

The validation subject is the argument list, so a tuple schema is the natural shape (`z.tuple([z.number(), z.string()])`). A failure raises `SchemaError` into the agent's observation as an ordinary runtime error it can adjust to, and the host fn doesn't run. A transforming schema has its output spread as the call args; a non-array return is ignored in favor of the original args. Enforcement stays synchronous when the validator is synchronous — Zod, Valibot and ArkType all are for non-async schemas — so a registered sync fn doesn't silently become promise-returning under `evalRuntime`.

**Breaking for anyone who set `paramsSchema` expecting it to be ignored:** calls that don't satisfy the schema now fail instead of reaching the handler. That's the documented behavior, so this is a fix rather than a change of contract.

**Removed:** `hostFsAccess` and `networkAccess` on every registration. Both were declaration-only — no runtime ever read them — while `docs/concepts/sandboxing.md` presented them alongside the policy as if enforced. A capability flag that does nothing is worse than no flag; they can return designed against real enforcement. Registrations passing either field just need it deleted.
