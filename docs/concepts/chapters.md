# Chapters: Agent-Directed Context Compaction

As agents work through long sessions, their context grows. Every action, output, and result accumulates in the event log and eventually presses against the LLM's context window. Chapters solve this by letting **the agent decide** what to compact and how to summarize it — keeping full detail where it matters and distilling the rest.

## The problem with automated summarization

A common approach is to summarize old events with an LLM call when context gets large. This works, but has drawbacks:

- **The framework guesses** what's important — it doesn't know what the agent still needs.
- **Details are lost** — the summary replaces the originals.
- **Timing is rigid** — summarization fires based on token counts, not logical boundaries.

Chapters flip the model: the agent itself decides what to close out, writes the summary, and keeps active work intact.

## How it works

### `ChapterEvent`

A `ChapterEvent` replaces a contiguous range of events in the active log with a named summary. The original events are preserved in storage and accessible via `ChapterEvent.eventRefs` — nothing is lost.

```
📖 Chapter: "Data exploration"

Loaded the CSV (12,450 rows × 8 columns). Found 3% null values
concentrated in the `income` column. Schema: id, name, age, income,
city, state, signup_date, plan_type.

Full details: /chapters/data-exploration/
```

When the agent sees this in its rendered context, it gets the summary plus a path to browse the originals if it needs them.

### The chapter task

When a task completes (success / fail, including the budget-exhausted fail) and the most recent `ActionEvent`'s `inputTokens` exceeds the configured `chapteringTrigger`, the framework invokes the `__chapter__` task. Chaptering fires at task boundaries — never mid-action — so a task always either completes cleanly or runs into the limit and ends, with chaptering happening *between* tasks. This is a regular agex-ts task — auto-registered when `chapteringTrigger` is set, runs through the same action loop as any other task, sees the agent's registered fns / namespaces / classes.

A consequence: a single long-running task with no completed sub-tasks gets no relief from chaptering — its only boundary is in-progress until it ends. The deferred [overflow-protection mechanism](https://github.com/ashenfad/agex-ts/blob/main/roadmap.md) covers that case (force task end + chapter + optional resume) when it lands.

Crucially, the chapter task runs **in the parent's session**. Its loop renders the parent's full event log as conversation history when calling the LLM, so the agent reflects on its own work with actual context (real code, results, outputs) — not a skeletal summary string.

The chapter task's input is a numbered **boundary index**:

```
[1] task "Analyze the dataset": Load and characterize the data → success
[2] task "Build the pipeline": Build the data pipeline → success
[3] chapter "Setup work" — Configured environment and loaded base data
[4] task "Run experiments" (in progress)
```

Each `[N]` is a boundary — a `TaskStartEvent` (with its outcome found by scanning forward) or a prior `ChapterEvent`. The agent picks contiguous ranges over these boundaries:

```ts
taskSuccess([
  { start: 1, end: 2, name: 'Setup', message: 'Loaded data, built pipeline...' },
])
```

The framework converts each `Chapter` into a `ChapterEvent`, splicing it into the log in place of the boundary's underlying events.

### Why boundaries, not raw events

Picking ranges over boundaries (rather than every event position) means:

- The chapter task can't fold a partial task — only complete units.
- ChapterEvents are boundary entries themselves, so picking a range that includes a prior chapter is **nested chaptering** — the new chapter's `eventRefs` includes the inner chapter's storage key, producing a tree of summaries.
- The index stays short and scannable as the log grows.

The trade-off: chaptering doesn't help a single long-running task with no sub-tasks (only one boundary in the index). Decompose into sub-tasks if you want chaptering to operate within that work.

### Browsing chaptered history

Original events are accessible via a read-only VFS overlay at `/chapters`:

```
/chapters/data-exploration/
    summary.md              # Chapter name + message
    events/
        001-taskstart.md    # Original TaskStartEvent
        002-action.md       # Original ActionEvent
        003-output.md       # Original OutputEvent
        004-success.md      # Original SuccessEvent
```

Agents browse these with standard file tools (`ls`, `cat`) — no special API needed. Nested chapters recurse naturally into `/chapters/<outer>/chapters/<inner>/`.

## The two filters

The chapter task lives in the same session as the parent, so its own bookkeeping (`taskStart "__chapter__"`, action, success) lands in the parent's event log alongside everything else. Two filters keep this from polluting things:

### Filter A — at LLM render time

`renderEvents` skips closed `__chapter__`-scoped events when building the parent agent's conversation. Without this, the chapter task's action emission (which embeds `taskSuccess([Chapter(message: '...')])` with the full summary text in code form) would duplicate the summary the `ChapterEvent` already shows. **Open** chapter scopes (the chapter task currently running) are not filtered — that's how the chapter task's own multi-turn loop sees its prompt and prior turns.

### Filter B — at index-build time

The boundary index handed to a future chapter task skips both open and closed `__chapter__` scopes. The chapter task can't be asked to fold itself, and prior chaptering bookkeeping isn't enumerable as foldable work.

The bookkeeping events stay in the log for UI, undo, and `iter()` — only LLM render and the foldable-boundary index filter them.

## Configuration

One setting:

```ts
const agent = await createAgent({
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
  state: { type: 'versioned', storage: 'memory' },
  chapteringTrigger: 100_000,
})
```

Setting `chapteringTrigger` enables chaptering. The framework auto-registers an internal chapter task with the default primer. Without `chapteringTrigger`, no chapter task exists and chaptering never runs.

Optionally override the primer if you want different framing or domain-specific guidance:

```ts
const agent = await createAgent({
  /* ... */
  chapteringTrigger: 100_000,
  chapterPrimer: 'Compact older completed tasks. Be terse — one sentence summaries.',
})
```

The framework guards the chapter task from being invoked when there's nothing safe to fold (e.g., a single in-progress task with no prior completed work). This avoids burning an LLM call that would just return `[]`.

## Design principles

### Agent autonomy

The agent chooses *what* to chapter and *how* to summarize. The framework only decides *when* to ask. Completed work gets chaptered; active investigations stay in full context.

### Default to folding

When the chapter task is invoked, context is over budget — the framework doesn't ask casually. The default primer reflects this: "Compact your context… you were invoked because your context is over budget — default to folding something." Returning `taskSuccess([])` is a last resort for the case where every boundary really is in-progress or actively needed.

### Lossless compaction

Nothing is deleted. `ChapterEvent.eventRefs` holds the original state keys; the kvgit substrate keeps the underlying values. The `/chapters/<slug>/` overlay walks those refs on demand. An agent that needs a specific detail from earlier work can find it.

### Single round per trigger

When a task ends and the trigger fires, the framework invokes the chapter task once, applies the returned chapters, and returns control to the caller. If context is still above the trigger after one round, the trigger naturally fires again at the next task's boundary — but each round can only see one boundary index, so producing all useful chapters in one call is the agent's job.

## Compared to plain compaction

A simpler "summarize old events with an LLM call when context gets large" approach has half the implementation surface but throws away these properties:

| Property | Chapters | Plain compaction |
|---|---|---|
| Agent picks what to fold | ✅ | ❌ (mechanical: oldest N events) |
| Multiple summaries per pass | ✅ | ❌ (one blob) |
| Originals browsable | ✅ via `/chapters/<slug>/` | ❌ (replaced) |
| Hierarchical organization | ✅ via nested chapters | ❌ |
| Undo-able as events | ✅ | Awkward |

The cost is the conceptual surface area — boundaries, two filters, a chapter primer — but it's bounded to a few files and an opt-in feature.
