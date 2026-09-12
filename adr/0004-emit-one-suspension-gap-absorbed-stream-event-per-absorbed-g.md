# ADR-0004: Emit one `suspension_gap_absorbed` stream event per absorbed gap, from a single bridge file

**Status:** Accepted
**Context:** The run-level convention is `emit(event: BaroEvent)` (tui-protocol.ts:223-225) with snake_case fields and a `BaroEvent` union member. awake-clock.ts must stay import-free, so it cannot call `emit` itself; without a single designated bridge each adopter would log its own ad-hoc line and the acceptance criterion ('one clear line naming the gap duration and the affected budget') would produce N lines per gap.
**Decision:** awake-clock.ts only exposes `onGapAbsorbed`. Add one bridge file `packages/baro-orchestrator/src/runtime/awake-clock-log.ts` exporting `export function installAwakeGapReporter(clock: AwakeClock = sharedAwakeClock()): () => void`, which subscribes once (idempotent per clock — a second call returns the existing unsubscribe) and calls `emit`.

Add to the `BaroEvent` union in `src/tui-protocol.ts` (alongside the existing members at :83-216), exactly:
`| { type: "suspension_gap_absorbed"; gap_ms: number; budget: string; awake_elapsed_ms: number; wall_elapsed_ms: number }`
Field `budget` carries an `AwakeBudgetName` value, or `"*"` when the gap is detected outside any armed budget.

Do NOT add this type to `MILESTONE_TYPES` (src/operator/protocol.ts:11-29) or its twin (packages/baro-dsh/src/domain/protocol.ts) — it is diagnostic, not a milestone. Do NOT define a `defineSemanticEvent` bus event for it; no bus consumer needs it. Call `installAwakeGapReporter()` from exactly two places: `src/orchestrate.ts` (once, at run start) and `scripts/run-architect.ts` `main()` (once, after the phase origin is established) — the script additionally writes the same fact to stderr as `awake-clock: absorbed <gap_ms>ms suspension gap (budget=<budget>)`, matching its existing stderr style. Nowhere else emits gap lines.

Verify that `crates/baro-tui/src/events.rs` tolerates an unrecognised `type` value; if the deserializer is strict, add an ignoring fallback variant there rather than rendering the event.
**Consequences:** One event per absorbed gap regardless of how many deadlines are armed. Machines that never sleep emit zero such events, keeping stdout byte-identical. Any new consumer that switches exhaustively on `BaroEvent` will need a branch for the new member — the TypeScript compiler will point at them.
