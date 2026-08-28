# ADR-0001: Return a structured admission outcome from `onPlanFragmentProposed` instead of inferring it from a snapshot

**Status:** Accepted
**Context:** The board rejection reason exists (`rejectPlanFragment` emits it) but is thrown away because `onPlanFragmentProposed` returns `void`, forcing the caller to infer failure from `nextOrdinal`. Alternatives rejected: a mutable `lastRejection` instance field (action-at-a-distance, breaks on nesting) and parsing the emitted event (no synchronous listener exists on this host).
**Decision:** In `packages/baro-orchestrator/src/planning/application/progressive-planning-coordinator.ts` only:
1. Add exported type next to the coordinator class:
```ts
export type PlanFragmentAdmissionOutcome =
    | { status: "admitted" }
    | { status: "replayed" }
    | { status: "rejected"; code: PlanFragmentRejectionCode; reason: string }
```
2. Change `private rejectPlanFragment(correlation, code, reason)` (:727) return type from `void` to `PlanFragmentAdmissionOutcome` and end it with `return { status: "rejected", code, reason }`. Its emitted `PlanFragmentRejected` payload is unchanged.
3. Change `private onPlanFragmentProposed(fragment: PlanFragmentProposedData)` (:238) return type from `void` to `PlanFragmentAdmissionOutcome`. Rewrite every existing `this.rejectPlanFragment(...); return` branch (:244-250, :253-258, :260-267, :352-355, :365-371, :386-392, :394-399, :486-493) as `return this.rejectPlanFragment(...)`. The success path (:496-520) ends with `return { status: "admitted" }`; the replay short-circuit (:372-383) ends with `return { status: "replayed" }`.
4. The dispatch call site (:165-171) ignores the value; do NOT change its behaviour or the `handleEvent` boolean return.
5. Do NOT add codes to `PlanFragmentRejectionCode` (`src/events/planning.ts:48-56`) and do NOT change `PlanFragmentRejectedData`.
**Consequences:** The final-tail block now has the real `{code, reason}` in hand. No public/protocol surface changes (`onPlanFragmentProposed` stays private, `ProgressivePlanningCoordinatorHost` untouched), so `collective-board.ts` needs no edit. All other rejection semantics stay byte-identical.
