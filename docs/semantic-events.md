# Semantic events: migration policy and wire-format notes

`packages/baro-orchestrator/src/semantic-events.ts` defines every baro
orchestrator bus event as a Mozaik 3.10 `SemanticEvent`. It replaced the old
`BusEvent` class hierarchy (`types.ts`, plus `ConductorStateItem` in
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

## Why type discriminators, not `instanceof`

Class instances don't survive JSON serialisation (audit log → reload,
WebSocket → reload), but an `event.type === "knowledge"` check does. Every
event ships with a `create()` factory (typed input → `SemanticEvent`) and an
`is()` user-defined type guard via `defineSemanticEvent`.
