# TUI protocol v2 — first-class semantic events

The BaroEvent stream (orchestrator stdout → Rust TUI / cloud control plane)
historically compressed most bus activity into `story_log` lines. v2 adds
STRUCTURED events so consumers can render run semantics first-class instead of
parsing log strings. Old consumers ignore unknown `type`s. Where an older
`story_log` mirror already existed it remains for compatibility; new runtime
DAG projection uses the established structured `replan` shape directly and
does not invent a duplicate log line.

## New BaroEvent variants (tui-protocol.ts)

| type | fields | source semantic event | consumer rendering |
|---|---|---|---|
| `replan` | `source, reason, added: [{id,title,depends_on}], removed: [id], rewired: [{id, depends_on}]` | `Replan`, or an authoritative `RuntimeReplanApplied` projection | DAG updates; "replanned" badge on affected stories; activity entry |
| `intervention` | `id, source, action, reason` | `StoryIntervention` | "stalled → aborted" pill on the agent row; activity warn |
| `story_merged` | `id, mode: "worktree"\|"shared-tree"` | `StoryMerged` | ✓ merged pill on the agent row |
| `merge_failed` | `id, error` | `StoryMergeFailed` | ✗ merge-failed pill (worktree preserved) |
| `level_started` | `ordinal, story_ids` | `LevelStarted` | DAG level highlight |
| `level_completed` | `ordinal, passed: [id], failed: [id]` | `LevelCompleted` | DAG level state |
| `recovery_started` | `attempt, story_ids` | `RecoveryStarted` (new) | "recovery attempt N" banner + DAG |
| `routed` | `id, backend, model` | `StoryRouted` (new) | model lane on the agent row |
| `critique` | `id, verdict: "pass"\|"fail", reasoning, violated: [string]` | `Critique` | critic pill (✓/✗) on the agent row; activity entry |

## New semantic events (semantic-events.ts)

- `RecoveryStarted { attempt: number, storyIds: string[] }` — wire type
  `recovery_started`. Emitted by Conductor when `tryStartRecoveryLevel`
  actually starts a recovery level (visibility; the recovery FLOW stays
  hook-driven for now — see docs/semantic-events.md deferred list).
- `StoryRouted { storyId: string, backend: string, model: string }` — wire
  type `story_routed`. Emitted by StoryFactory right after `resolveStoryRoute`
  (replaces the stderr-only `[story-factory] S1 → backend:model` as the
  machine-readable source of truth; the stderr line stays).
- `RuntimeReplanProposed` / `RuntimeReplanApplied` /
  `RuntimeReplanRejected` retain their distinct wire types in the Mozaik audit
  stream. Only an authoritative, first-seen `Applied` decision is projected
  to the existing stdout `replan` shape, after durable graph commit. The
  projection's source is `agent:<storyId>@graph-v<commitVersion>`.

There is deliberately no second runtime-specific TUI event. The Rust client
applies the projected `replan` and rebuilds its DAG view immediately. Metrics
must count the semantic audit event, not both it and this stdout projection.

## Forwarder mapping rules

One forwarder concern per file (existing pattern in
`participants/forwarders/`). The forwarders own ALL translation — no `emit()`
calls for these events anywhere else. Existing `story_log` mirrors stay where
they already formed part of the compatibility contract; structured events are
the source of truth for new consumers.

Existing `activity` events are unchanged; the TUI should now render them
(kind-colored, story-grouped) instead of relying on the raw `story_log`
firehose.

## Stdin commands (TUI → orchestrator)

The reverse channel: the Rust TUI pipes the orchestrator's stdin and writes
one JSON command per line (`subscribeCommands` in tui-protocol.ts parses
them). The channel is additive and fault-tolerant by contract: malformed
lines and unknown `type`s are ignored silently — a bad command must never
crash a run.

| type | fields | effect |
|---|---|---|
| `agent_message` | `id, text` | Operator emits `AgentTargetedMessage { recipientId: id, text, metadata: { source: "user" } }` on the bus; the running story agent consumes it between turns (same delivery path as Critic corrective feedback). A `story_log` line `[you → <id>] <text>` is mirrored to stdout so the message lands in the TUI log, audit JSONL and cloud. |

Notes:
- Commands arriving before the Operator has joined the bus (startup window)
  are dropped, like any other unparseable line.
- Backends that don't poll `AgentTargetedMessage` simply never see the
  message — acceptable for v1.
- TUI side: `m` targets the explorer-selected / pinned / tab-selected
  running agent and sends on Enter, echoing `you → <id>: <text>` into that
  agent's activity feed immediately.
