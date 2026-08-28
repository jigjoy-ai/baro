# ADR-0002: Treat a replayed final tail as admitted and drive the tail check from the outcome, not from `nextOrdinal`

**Status:** Accepted
**Context:** The replay branch (:372-383) admits nothing new and leaves `nextOrdinal` unchanged, so today's `nextOrdinal !== ordinal + 1` check (:628) fails a legitimately-replayed tail. Keeping the ordinal comparison as the primary signal would preserve that latent bug.
**Decision:** Replace lines 616-636 of `progressive-planning-coordinator.ts` with logic that keeps the same slice/ordinal computation (`tail = finalStories.slice(planning.admittedStoryIds.length)`, `ordinal = planning.nextOrdinal`) but branches on the returned outcome:
- `status === "admitted"` or `status === "replayed"` -> fall through to the existing close path at :637-639 unchanged.
- `status === "rejected"` -> apply ADR on redundant-tail tolerance.
The `nextOrdinal` snapshot comparison is deleted as a control-flow decision. Keep one defensive assertion only for the `admitted` case: after a `{status:"admitted"}` outcome, re-snapshot and if `afterAdmission?.nextOrdinal !== ordinal + 1`, call `failPlanning(afterAdmission ?? planning, "final_tail_rejected", "admission reported success but the planning ordinal did not advance")` and return.
**Consequences:** Replayed tails no longer fail the run. The `final_tail_rejected` code survives for both the rejected-and-not-tolerated case and the impossible-in-theory inconsistent-success case.
