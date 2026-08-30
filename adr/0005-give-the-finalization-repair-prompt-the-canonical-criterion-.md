# ADR-0005: Give the finalization repair prompt the canonical criterion text for every unowned obligation id

**Status:** Accepted
**Context:** buildFinalPrdRepairMessage (planner-prompts.ts:546-579) lists unowned ids through `formatObligationIdList` (obligation-coverage-report.ts:33-39) and receives `readonly string[]` only (:549), so the model must reconstruct canonical text it is required to reproduce verbatim — the exact failure canonicalization now papers over. The contract exists at the call chain but is trapped as a closure-local in planner-openai-progressive.ts:239 and is not on the support interface (:57-58, :66-67).
**Decision:** 1. planner-openai-progressive.ts: add `obligationContract(): ArchitectureObligationContractV1 | null` to the progressive support interface (:57-58) and implement it (:66-67) by returning the closure-local `obligationContract` (:239), `null` when unparsed. No other interface change.
2. planner-prompts.ts: widen the input to `{ reason: string; error?: unknown; unownedObligationIds: readonly string[]; obligationContract?: ArchitectureObligationContractV1 | null }`. When `obligationContract` is present, replace the id-list body of the existing section (:560-568) with, for each unowned id that resolves to a contract obligation, two lines:
```
<id>:
<renderArchitectureObligationCriterion(obligation)>
```
Cap at the first 12 obligations; render the remaining ids with the existing `formatObligationIdList` under the line `Remaining unowned ids: …`. Ids that do not resolve fall back to the id-only form. The heading `Unowned architecture obligations (N):` and the closing sentence at :566-568 stay verbatim, and one instruction line is added immediately before the list: `Copy each criterion text below verbatim, character for character, as an acceptance criterion of a story in THIS reply.` When `obligationContract` is absent or null, output is byte-identical to today.
3. planner-bus-session.ts:567-575: pass `obligationContract: progressive.obligationContract()`.
Do NOT change `renderArchitectureObligationCriterion` or `formatObligationIdList`.
**Consequences:** The repair prompt now carries the exact string the validator compares against, so repairs land without relying on canonicalization. The prompt grows by roughly one rendered criterion per unowned obligation, bounded by the 12-item cap. planner-openai-progressive.ts:301-308 (publish-receipt warning) is explicitly out of scope and stays id-only.
