# ADR-0004: Re-evaluate the tail tolerance against a snapshot taken at decision time before failing

**Status:** Accepted
**Context:** `discardRedundantFinalTail` (progressive-planning-coordinator.ts:682-734) snapshots at :689 but then composes the failure from that single evaluation, and falls back to the caller's entry-time `planning` captured at :539 (:690). A story that settles between the rejection and the terminal decision can therefore still be reported as unsettled. The host offers only a synchronous `snapshot()` (:77); adding an async host API or awaiting settlement would ripple through collective-board.ts:483-493 and every caller, so it is rejected. Re-reading the same synchronous accessor immediately before composing the failure is sufficient because the board hands out live `prd` by reference.
**Decision:** In progressive-planning-coordinator.ts add a private helper:

private evaluateTailToleranceNow(fallback: PrdProgressivePlanningState): { tolerance: FinalTailTolerance; planning: PrdProgressivePlanningState }

It always calls `this.opts.host.snapshot()` itself (never accepts a caller-held snapshot), prefers `state.prd?.runtimeGraph?.planning` and uses `fallback` only when that is absent, keeps the existing missing-PRD guard verbatim (`{tolerated:false, blocker:"unsettled_stories", detail:"the run no longer holds a PRD"}`, :697-701), and otherwise calls `evaluateFinalTailTolerance({ prd: state.prd, admittedStoryIds: <fresh planning>.admittedStoryIds, goalContract: deriveGoalContract(state.prd.goalEnvelope) })`.

Rewire `discardRedundantFinalTail` to:
1. `const first = this.evaluateTailToleranceNow(planning);`
2. If `first.tolerance.tolerated` — take the existing warn + `FinalTailDiscarded` branch (:717-733) unchanged and return true. Exactly one evaluator call on this path.
3. If not tolerated — call `this.evaluateTailToleranceNow(planning)` a SECOND time and use only that result. If the second result is tolerated, take the same warn + `FinalTailDiscarded` branch and return true (this is the fresh-board redundancy case the goal requires). Otherwise fail using the second result's `blocker`/`detail`.

`evaluateFinalTailTolerance` itself (src/planning/domain/final-tail-tolerance.ts) is NOT modified: its input struct, its three blockers, their order, `isSettled`, the obligation backstop at :63-86 and the exact `{tolerated:true}` return shape stay as they are. The unrelated `final_tail_rejected` path at :644-654 is not touched.
**Consequences:** The v0.99.0 tolerance semantics are extended by call-site re-evaluation only, and the fail-closed backstop for genuinely uncovered obligations is bit-for-bit unchanged — a genuinely uncovered obligation fails both evaluations. The failure path now calls the evaluator twice, so the call-count assertion at test/planning/progressive-planning-final-tail.test.ts:106 must be updated from 1 to 2; the tolerated-path count (:65-69) stays 1 and the zero-call assertions (:135-138, :163-167) stay 0. No new dependency, no async host method, no change to collective-board.ts:483-493.
