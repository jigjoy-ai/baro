# TUI protocol v2 — first-class semantic events

The BaroEvent stream (orchestrator stdout → Rust TUI / cloud control plane)
historically compressed most bus activity into `story_log` lines. v2 adds
STRUCTURED events so consumers can render run semantics first-class instead of
parsing log strings. All additions are backward compatible: old consumers
ignore unknown `type`s; every new event keeps emitting its old `story_log`
line alongside for one release.

## New BaroEvent variants (tui-protocol.ts)

| type | fields | source semantic event | consumer rendering |
|---|---|---|---|
| `replan` | `source, reason, added: [{id,title,depends_on}], removed: [id], rewired: [{id, depends_on}]` | `Replan` | DAG updates; "replanned" badge on affected stories; activity entry |
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

## Forwarder mapping rules

One forwarder concern per file (existing pattern in
`participants/forwarders/`). The forwarders own ALL translation — no `emit()`
calls for these events anywhere else. `story_log` mirror lines stay for one
release so older TUIs/dashboards keep working; structured events are the
source of truth for new consumers.

Existing `activity` events are unchanged; the TUI should now render them
(kind-colored, story-grouped) instead of relying on the raw `story_log`
firehose.
