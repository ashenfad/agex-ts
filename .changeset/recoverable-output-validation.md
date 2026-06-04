---
"agex-ts": minor
---

Output validation is now enforced but recoverable. Previously, a `taskSuccess` value that failed the task's `output` schema hard-rejected the whole task with a `SchemaError` the agent never saw. Now the mismatch is surfaced to the agent as a system reminder, costs one iteration, and lets it re-issue `taskSuccess` with a corrected value — a persistent mismatch is bounded by `maxIterations` and becomes the terminal failure only on exhaustion (the message carries the validation detail). Mirrors agex-py's return-type idiom, where a mismatch is a recoverable error counted against the loop rather than a hard fail.
