# ADR-0004: Add a `FinalTailDiscarded` semantic event rather than widening `PlanFragmentRejectionCode`

**Status:** Accepted
**Context:** The tolerated path must leave a durable trace naming the discarded stories and the board reason. Reusing `PlanFragmentRejected` alone is insufficient (it carries no story ids and does not say the tail was tolerated); adding a rejection code would alter the meaning of an existing union consumed by the untouched rejection paths.
**Decision:** In `packages/baro-orchestrator/src/events/planning.ts`, append (leaving :48-68 unchanged):
```ts
export interface FinalTailDiscardedData {
    runId: string
    planningId: string
    fragmentId: string
    ordinal: number
    storyIds: readonly string[]
    code: PlanFragmentRejectionCode
    reason: string
}
export const FinalTailDiscarded =
    defineSemanticEvent<FinalTailDiscardedData>("final_tail_discarded")
```
The coordinator emits it via `this.opts.host.emit(FinalTailDiscarded.create({...}))` exactly once, only in the tolerated branch, immediately before `closePlanning(current, "completed")`; `storyIds` = ids of the rejected `tail` stories, `code`/`reason` = the outcome's values, `fragmentId`/`ordinal` = the values sent to `onPlanFragmentProposed`. In the not-tolerated branch no new semantic event is added — the inner `PlanFragmentRejected` already emitted by `rejectPlanFragment` is the rejection trace.
**Consequences:** Both scenarios emit a reason-bearing bus event (`PlanFragmentRejected` always; plus `FinalTailDiscarded` when tolerated). Existing consumers of `PlanFragmentRejected` are unaffected; nothing is required to subscribe to the new event.
