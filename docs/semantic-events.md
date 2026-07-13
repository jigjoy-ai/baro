# Semantic events: migration policy and wire-format notes

`packages/baro-orchestrator/src/semantic-events.ts` defines every baro
orchestrator bus event as a Mozaik `SemanticEvent`. The conversion began on
Mozaik 3.10; the runtime now uses Mozaik 3.12. It replaced the old `BusEvent`
class hierarchy (`types.ts`, plus `ConductorStateItem` in
`participants/conductor.ts` and `StoryResultItem` in
`participants/story-agent.ts`).

## Migration policy (Mozaik 3.10 upgrade, "Commit 2")

See the `mozaik-3.10-upgrade` branch root commit and memory
`mozaik-3-10-blocker.md`.

- **Pure addition.** None of the old `BusEvent` classes were touched during
  the migration. Sites could mix old `BusEvent`/`instanceof` and new
  `SemanticEvent`/`*.is` without conflict during the cutover.
- **Wire `type` strings are frozen.** Each event keeps its wire `type`
  identical to the pre-migration `toJSON().type` so audit-log readers
  (mozaik-replay legacy adapter, baro's older replay tooling) recognise the
  same event names across the cutover. Example: `AgentResult` still uses wire
  type `claude_result`.
- **Data interfaces match runtime usage.** Where the previous `toJSON()`
  deliberately dropped or renamed a field, the decision is noted per-event in
  the source. Known deltas:
  - `StorySpawnRequest`: old `toJSON()` replaced the full prompt with
    `promptLen` to keep audit logs small; the new wire format carries the full
    prompt (StoryFactory needs it, and replay/debug round-tripping is worth
    the size).
  - `AgentResult`: the in-memory `raw` field from the old `AgentResultItem`
    is not included — the old `toJSON()` already excluded it.
  - `Replan.modifiedDeps`: flat `Record<storyId, dependsOn>` instead of the
    old `Map` + `Array.from(entries)` serialisation dance, for JSON
    compatibility.
  - `Critique`: historic wire JSON used snake_case keys (`agent_id`,
    `violated_criteria`, `model_used`) to match the Rust TUI. The data
    interface is camelCase; no in-process consumer reads snake_case keys, so
    any snake_case mapping would happen at the audit-log boundary.

## Post-migration additions (event-driven pass, 2026-07)

New wire types with no legacy counterpart (added AFTER the freeze, so they
carry no compat constraint beyond "don't rename once shipped"):

- `story_intervention` — a participant (Supervisor) requests an abort of a
  RUNNING story; StoryFactory consumes it. Replaced the `onStall` callback so
  interventions are observable on the bus (audit log, TUI, kaleidoskop).
- `story_merged` / `story_merge_failed` — emitted by the GitCoordinator when a
  passed story's work lands on the run branch (worktree merge-back or
  shared-tree reconcile) or the merge-back fails and the worktree is preserved.
- `recovery_started` — emitted by the Conductor when `tryStartRecoveryLevel`
  actually starts a recovery level (`attempt` is a 1-based run-level counter).
  Visibility only: the recovery flow itself stays hook-driven.
- `story_routed` — emitted by StoryFactory right after `resolveStoryRoute`;
  the machine-readable twin of the `[story-factory] S1 → backend:model`
  stderr line (which stays). See docs/tui-protocol-v2.md for the structured
  BaroEvents these feed.
- `replan_applied` — the legacy Conductor accepted a buffered Surgeon
  `Replan`, applied it at a level boundary, and persisted the PRD. Raw
  `replan` remains a proposal and is never projected as committed state.
- `runtime_replan_proposed` — a collective worker proposes a closed,
  correlated mutation of the not-yet-started DAG. Its run/story/lease/
  generation identify the active authority and `baseGraphVersion` is the
  optimistic-concurrency precondition.
- `runtime_replan_applied` — the Board accepted the candidate only after the
  graph, incremented version and applied-decision ledger were atomically
  persisted. `graphVersion` is the immutable commit version;
  `currentGraphVersion` is the latest version at delivery time and may be
  newer on an idempotent replay.
- `runtime_replan_rejected` — the correlated proposal did not mutate the DAG.
  It carries a stable machine-readable rejection `code` and the Board's
  current graph version so the worker does not continue from stale state.

`proposalId` is the runtime-replan idempotency key. The same ID and identical
content replays the remembered decision; the same ID with different content
is rejected as `proposal_id_conflict`. Applied decisions are kept in the
PRD's `runtimeGraph` metadata and can be restored by a host that resumes the
same `runId`. The current public CLI starts a new identity after a process
restart, so it keeps the graph/version baseline but does not yet expose
end-to-end replay of an old decision. This runtime contract is distinct from
the older `Replan` event, which remains the Surgeon/Conductor recovery
proposal contract; in collective mode only the Board's persisted Applied
decision reaches stateful projections.

## Why type discriminators, not `instanceof`

Class instances don't survive JSON serialisation (audit log → reload,
WebSocket → reload), but an `event.type === "knowledge"` check does. Every
event ships with a `create()` factory (typed input → `SemanticEvent`) and an
`is()` user-defined type guard via `defineSemanticEvent`.
