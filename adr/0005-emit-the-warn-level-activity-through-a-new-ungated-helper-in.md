# ADR-0005: Emit the warn-level activity through a new ungated helper in `plan-events.ts`

**Status:** Accepted
**Context:** There is no severity field in the planning semantic events and no forwarder from planning events to the TUI feed, so a bus event alone is not user-visible. The only existing planning->TUI bridge is `plan-events.ts`, whose `emitPlanLine` is gated on `BARO_PLAN_EVENTS=1` — unsuitable, since the warning must always be visible.
**Decision:** In `packages/baro-orchestrator/src/planning/application/plan-events.ts` add one exported function, not gated by any env var:
```ts
export function emitPlanActivity(kind: "warn" | "error", text: string): void
```
It constructs a `BaroEvent` of the `activity` variant using exactly the required fields declared at `src/tui-protocol.ts:160-170` (no extra fields) and writes it with the `emit` exported at `src/tui-protocol.ts:223`. Callers, both in the final-tail block of the coordinator and nowhere else:
- tolerated: `emitPlanActivity("warn", `final planner tail discarded (${code}): ${reason}; dropped stories: ${storyIds.join(", ")}`)`
- not tolerated: `emitPlanActivity("error", `final planner tail rejected (${code}): ${reason}; blocker: ${blocker}: ${detail}`)` before `failPlanning`.
Do NOT add a forwarder under `src/execution/forwarders/`, do NOT introduce a severity field on any semantic event, and do NOT change `emitPlanLine`/`emitToolCall` or their gating.
**Consequences:** `plan-events.ts` becomes a second write surface for the story that owns it; the TUI needs no Rust-side change because `kind` is already a free-form string documented to include `warn`. The activity text is asserted in tests by spying on the `tui-protocol` emitter used by the existing test harness.
