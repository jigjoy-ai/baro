# Observer participants

This cheat sheet documents the six TypeScript-side observer participants
in the orchestrator: passive bus listeners that watch ContextItem traffic
and (optionally) emit their own ContextItem-s back onto the bus.
Cartographer is **not** covered here — it lives Rust-side under
`crates/baro-tui/`.

Each observer below lists the ContextItem types that gate its
`onContextItem` method (via `instanceof`) under **Subscribes to**, and the
ContextItem types it constructs and delivers under **Emits**.

---

## Critic

A live acceptance-criteria evaluator. For every watched agent that
completes a turn without error, the Critic spawns a short-lived
`claude --print --model <model>` subprocess to ask whether the agent's
output satisfies the acceptance criteria associated with its `agentId`.
The verdict is always published as a `CritiqueItem` (audit trail). On a
"fail" verdict, the Critic also sends an `AgentTargetedMessageItem` back
to the agent as its next conversational turn, up to
`maxEmissionsPerAgent` times, after which corrective messages are
suppressed but critiques keep accumulating.

- Subscribes to: `AgentResultItem`
- Emits: `CritiqueItem`, `AgentTargetedMessageItem`

Source: [critic.ts](./critic.ts)

---

## Surgeon

An adaptive DAG mutation participant. It watches terminal story failures
and emits `ReplanItem`-s that the Conductor applies at the next level
boundary. In the default deterministic mode it removes the failing story
so dependents either run with one fewer prerequisite or get
cascade-removed. In LLM mode it shells out to `claude --print` with a
compact PRD snapshot and the failure reason and asks for a structured
replan (split / prereq / rewire / skip / abort), falling back to the
deterministic strategy on any subprocess or parsing error.

- Subscribes to: `StoryResultItem` (defined in `story-agent.ts`)
- Emits: `ReplanItem`

Source: [surgeon.ts](./surgeon.ts)

---

## Librarian

A cross-agent runtime memory observer. It watches tool calls and their
outputs for a fixed set of exploration tools (Read, Grep, Glob, Bash,
LSP, WebFetch, WebSearch), records each call's tags and a truncated copy
of its output, and exposes the resulting index through both a
`gatherContext(storyId, hints)` RPC (used to prepend findings to a new
story's prompt) and a `KnowledgeItem` emission on the bus so other
observers can react. `FunctionCallItem` and `FunctionCallOutputItem` come
from `@mozaik-ai/core`.

- Subscribes to: `FunctionCallItem`, `FunctionCallOutputItem`
- Emits: `KnowledgeItem`

Source: [librarian.ts](./librarian.ts)

---

## Sentry

A file-touch conflict detector. It tracks the `Edit`, `Write`,
`MultiEdit`, and `NotebookEdit` tool calls each agent issues and the
phase each agent has reached. When two agents touch the same path, it
calls the optional `onOverlap` callback and — at most once per path —
emits a `CoordinationItem` with `kind="notice"` so the overlap shows up
in the audit log. Phase-2 scope: detect and notify only, no
tool-execution preemption. `FunctionCallItem` comes from
`@mozaik-ai/core`.

- Subscribes to: `AgentStateItem`, `FunctionCallItem`
- Emits: `CoordinationItem`

Source: [sentry.ts](./sentry.ts)

---

## Auditor

A passive persistence observer. It serializes every ContextItem it sees
to a JSONL file for replay and post-mortem debugging. By default it
skips `ClaudeStreamChunkItem` (partial-message chunks dominate volume
and rarely add audit value) and it honors an optional `filter` callback
that runs after the stream-chunk skip. If the very first `mkdir` or any
subsequent `append` fails, the Auditor disables itself for the rest of
the run, prints a single stderr warning, and silently drops further
items so the orchestrator keeps running.

- Subscribes to: every ContextItem (no `instanceof` gate); only
  `ClaudeStreamChunkItem` is explicitly filtered out
- Emits: nothing (writes to a JSONL file)

Source: [auditor.ts](./auditor.ts)

---

## Finalizer

The "Ship" half of `Plan. Parallelize. Review. Ship.` It collects
run-level events from the bus, and when a `RunCompletedItem` arrives it
composes a pull-request body — DAG plan, stories table with durations
and best-effort commit SHAs, diff stats, wall/sequential/speedup
numbers — and opens the PR via `gh pr create`. It degrades to "no PR,
log the reason" when the `gh` binary is missing, the branch matches the
base, no commits exist ahead of the base SHA, or all stories failed.
`StoryResultItem` is defined in `story-agent.ts`; the rest come from
`types.ts`.

- Subscribes to: `RunStartedItem`, `LevelStartedItem`, `StoryResultItem`,
  `RunCompletedItem`
- Emits: `FinalizeStartedItem`, `PrCreatedItem`

Source: [finalizer.ts](./finalizer.ts)
