# Observer participants

This cheat sheet documents the TypeScript-side observer participants in
the orchestrator: passive bus listeners that watch bus traffic and
(optionally) emit their own events back onto the bus or stdout protocol.
Cartographer is **not** covered here — it lives Rust-side under
`crates/baro-tui/`.

Every observer extends Mozaik's `BaseObserver`. They subscribe via
`onExternalEvent(source, event: SemanticEvent<unknown>)` and gate per
event type with the `.is()` user-defined type guard from
[../semantic-events.ts](../semantic-events.ts). Mozaik LLM-shape items
(`FunctionCallItem`, `FunctionCallOutputItem`, `ModelMessageItem`,
`ReasoningItem`) flow through their own dedicated `onExternalXxx`
methods.

---

## Critic

A live acceptance-criteria evaluator. For every watched agent that
completes a turn without error, the Critic spawns a short-lived
`claude --print --model <model>` subprocess to ask whether the agent's
output satisfies the acceptance criteria associated with its `agentId`.
The verdict is always published as a `Critique` event (audit trail). On
a "fail" verdict, the Critic also sends an `AgentTargetedMessage` back
to the agent as its next conversational turn, up to
`maxEmissionsPerAgent` times, after which corrective messages are
suppressed but critiques keep accumulating.

- Subscribes to: `AgentResult`
- Emits: `Critique`, `AgentTargetedMessage`

Source: [critic.ts](./critic.ts)

---

## Surgeon

An adaptive DAG mutation participant. It watches terminal story failures
and emits `Replan` events that the Conductor applies at the next level
boundary. In the default deterministic mode it removes the failing story
so dependents either run with one fewer prerequisite or get
cascade-removed. In LLM mode it shells out to `claude --print` with a
compact PRD snapshot and the failure reason and asks for a structured
replan (split / prereq / rewire / skip / abort), falling back to the
deterministic strategy on any subprocess or parsing error.

- Subscribes to: `StoryResult`
- Emits: `Replan`

Source: [surgeon.ts](./surgeon.ts)

---

## Librarian

A cross-agent runtime memory observer. It watches tool calls and their
outputs for a fixed set of exploration tools (Read, Grep, Glob, Bash,
LSP, WebFetch, WebSearch), records each call's tags and a truncated copy
of its output, and exposes the resulting index through both a
`gatherContext(storyId, hints)` RPC (used to prepend findings to a new
story's prompt) and a `Knowledge` emission on the bus so other
observers can react. `FunctionCallItem` and `FunctionCallOutputItem`
come from `@mozaik-ai/core`.

- Subscribes to: `FunctionCallItem`, `FunctionCallOutputItem`
- Emits: `Knowledge`, plus `AgentTargetedMessage` for mid-flight
  cross-agent broadcasts of fresh findings.

Source: [librarian.ts](./librarian.ts)

---

## Sentry

A file-touch conflict detector. It tracks the `Edit`, `Write`,
`MultiEdit`, and `NotebookEdit` tool calls each agent issues and the
phase each agent has reached. When two agents touch the same path, it
calls the optional `onOverlap` callback and — at most once per path —
emits a `Coordination` event with `kind="notice"` so the overlap shows
up in the audit log. Phase-2 scope: detect and notify only, no
tool-execution preemption. `FunctionCallItem` comes from
`@mozaik-ai/core`.

- Subscribes to: `AgentState`, `FunctionCallItem`
- Emits: `Coordination`

Source: [sentry.ts](./sentry.ts)

---

## Auditor

A passive persistence observer. It serializes every bus event it sees
to a JSONL file for replay and post-mortem debugging. By default it
skips `ClaudeStreamChunk` payloads (partial-message chunks dominate
volume and rarely add audit value) and it honors an optional `filter`
callback that runs after the stream-chunk skip. If the very first
`mkdir` or any subsequent `append` fails, the Auditor disables itself
for the rest of the run, prints a single stderr warning, and silently
drops further items so the orchestrator keeps running.

- Subscribes to: every `SemanticEvent` plus the Mozaik LLM channels
  (no per-type filter); only `ClaudeStreamChunk` is explicitly skipped
- Emits: nothing (writes to a JSONL file)

Source: [auditor.ts](./auditor.ts)

---

## Finalizer

The "Ship" half of `Plan. Parallelize. Review. Ship.` It collects
run-level events from the bus, and when a `RunCompleted` event arrives
it composes a pull-request body — DAG plan, stories table with
durations and best-effort commit SHAs, diff stats, wall/sequential/
speedup numbers — and opens the PR via `gh pr create`. It degrades to
"no PR, log the reason" when the `gh` binary is missing, the branch
matches the base, no commits exist ahead of the base SHA, or all
stories failed. Every event below is a `SemanticEvent<T>` factory
defined in [../semantic-events.ts](../semantic-events.ts).

- Subscribes to: `RunStarted`, `LevelStarted`, `StoryResult`,
  `RunCompleted`
- Emits: `FinalizeStarted`, `PrCreated`

Source: [finalizer.ts](./finalizer.ts)

---

## TUI Forwarders

Stdout protocol adapters that translate Mozaik bus events and LLM item
callbacks into Rust TUI `BaroEvent` JSON. They are split by event family
under [forwarders/](./forwarders/) so each file owns one responsibility
and one set of mutable state. The old aggregate forwarder kept a
`tokensByStory` map, but that state was written and never read, so the
split drops it.

- [story-lifecycle.ts](./forwarders/story-lifecycle.ts): subscribes to
  `AgentState` and `StoryResult`; emits story start, retry, completion,
  and error events.
- [token-usage.ts](./forwarders/token-usage.ts): subscribes to
  `AgentResult` and completed `CodexTurnEvent`; emits token usage
  events.
- [progress.ts](./forwarders/progress.ts): subscribes to
  `ConductorState`; emits level progress events.
- [coordination.ts](./forwarders/coordination.ts): subscribes to
  `Coordination` and `Critique`; emits story log lines.
- [finalization.ts](./forwarders/finalization.ts): subscribes to
  `FinalizeStarted` and `PrCreated`; emits finalization lifecycle
  events.
- [agent-log.ts](./forwarders/agent-log.ts): subscribes to
  `ModelMessageItem`, `FunctionCallItem`, and `FunctionCallOutputItem`
  through Mozaik item hooks; emits model and tool story log lines.

These forwarders emit nothing back onto the Mozaik bus.
