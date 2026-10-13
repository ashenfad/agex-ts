---
"@agex-ts/world": minor
---

**The inbox:** words for an agent that is already working. `inbox.put(text)` queues a note at any moment, and a turn opened with `{inbox}` delivers it on the next tool result.
- **Delivery:** `turn.deliver(result)` appends the queued notes behind a visible mark, framed by who is speaking: the principal the session works for, or the mechanism around the agent. `turn.opening()` opens a turn woken for what is waiting. A turn's `sources` add notes of their own at each delivery.
- **States:** notes go from pending to delivered, then settle when the turn ends, whatever its status, or go back to the queue if its run can't be stored. `inbox.requeue()` puts a thrown-away attempt's notes back. `splitNotes` separates a result from its notes by the block's trailer.
- **Turn events:** `Delivered` comes before the `ToolEnded` whose result carried the notes.

**Conformance:** a harness session has an `inbox`, and may have `wake()` for woken turns. The runner delivers `queue_note` events, and the reference harness passes tiers 0 to 3.
