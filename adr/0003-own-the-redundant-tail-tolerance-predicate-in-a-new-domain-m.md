# ADR-0003: Own the redundant-tail tolerance predicate in a new domain module `final-tail-tolerance.ts`

**Status:** Accepted
**Context:** Acceptance requires closing planning as `completed` when the rejected tail is redundant, while the fail-closed backstop for a tail carrying an obligation no admitted story owns must stay intact. The obligation source of truth is `architecture-obligation-contract.ts` (`validateArchitectureObligationCoverage`); the `GoalInvariantLedger` is private to `GoalGuardian` and knows only `G-*` ids, so it cannot be consulted from the coordinator. Putting this predicate inline in the coordinator would make it untestable in isolation and invite a second, divergent definition of 'settled'.
**Decision:** New file `packages/baro-orchestrator/src/planning/domain/final-tail-tolerance.ts` is the single owner of this logic and exports exactly:
```ts
export interface FinalTailToleranceInput {
    prd: Prd
    admittedStoryIds: readonly string[]
    goalContract: GoalContractV1 | null | undefined
}
export type FinalTailTolerance =
    | { tolerated: true }
    | { tolerated: false; blocker: "unsettled_stories" | "obligation_unowned" | "goal_contract_incomplete"; detail: string }
export function evaluateFinalTailTolerance(input: FinalTailToleranceInput): FinalTailTolerance
```
Implementation, evaluated in this order, first blocker wins:
1. `unsettled_stories`: resolve each id in `admittedStoryIds` against `prd.userStories`; a missing story or a story whose status is not terminal blocks. Reuse the existing terminal-status predicate/status union already exported from `packages/baro-orchestrator/src/prd.ts` (grep for an existing `isTerminal`/settled helper first and import it); do NOT hand-roll a second status list in this file. `detail` = comma-joined unsettled/missing ids.
2. `obligation_unowned`: build `contract = architectureObligationsFromDecision(prd.decisionDocument, goalContract)` and call `validateArchitectureObligationCoverage(contract, obligationMappingsForStories(admittedStories), "complete")` inside try/catch; a throw or a non-empty `missingObligationIds` blocks, with `detail` = the error message or `no admitted story owns: <ids>`.
3. `goal_contract_incomplete`: call the same `validateGoalContractCoverage` the coordinator already uses at :565-573, over `admittedStories` with mode `"complete"`, inside try/catch; a throw blocks with `detail` = the error message.
4. Otherwise `{ tolerated: true }`.
The coordinator calls this only on `{status:"rejected"}` and never elsewhere. The pre-existing `"complete"` obligation call at coordinator :574-581 and the `"partial"` calls at :335-350 and :565-573 are NOT modified, removed, or reordered.
**Consequences:** The fail-closed backstop is preserved twice over: unchanged at :574-581, and re-asserted over admitted-only stories before any tolerance is granted. `evaluateFinalTailTolerance` is a pure function and is the unit under test for both acceptance scenarios. No new dependency; no change to `goal-contract.ts` or `goal-guardian.ts`.
