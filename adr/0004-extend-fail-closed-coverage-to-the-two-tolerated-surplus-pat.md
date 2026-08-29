# ADR-0004: Extend fail-closed coverage to the two tolerated-surplus paths normalizeRecordKeys never sees

**Status:** Accepted
**Context:** Scout evidence shows two records that bypass normalizeRecordKeys entirely: obligations[i].evidence[j] is copied raw at architect-obligation-segments.ts:546 and only shape-checked later, and decisionDocument / decisionDocument.decisions[i] are read key-by-key (architect-outcome.ts:687-738, :800-809) with surplus keys intentionally ignored and no note. A denylist that stops at the top level would let a provider smuggle a forged sessionId one level down. The goal requires the denylist to cover both the outcome and obligation flows.
**Decision:** Call the shared `assertNoHostAssignedCorrelation` at exactly these three additional sites, and nowhere else:

1. packages/baro-orchestrator/src/planning/domain/architect-obligation-segments.ts — immediately before the raw evidence copy at :546, for each evidence element that is a non-null non-array object, with path `"obligations[" + index + "].evidence[" + j + "]"` using the same index expression already in scope at that site.
2. packages/baro-orchestrator/src/planning/domain/architect-outcome.ts — in the decisionDocument object branch (the `requiredKeys` tolerance at :800-809 / parseDecisionDrafts entry :713-738), for the decisionDocument record itself, path `"decisionDocument"`.
3. packages/baro-orchestrator/src/planning/domain/architect-outcome.ts — for each `decisions[i]` record inside parseDecisionDrafts, path `"decisionDocument.decisions[" + i + "]"`.

Do NOT make these calls recursive, do NOT add a generic deep walker, and do NOT change what those parsers otherwise tolerate: non-denylisted surplus keys remain silently ignored with no note, exactly as today (architect-outcome.ts:687-692).
**Consequences:** Three shallow guards, one shared implementation. Errors from site 1 surface through the existing catch at :805-813; errors from sites 2 and 3 propagate out of parseDecisionDrafts and must land on the same ArchitectOutcomeContractError path as other outcome parse failures — implementers wrap them in the enclosing accumulating validator so the defect keeps its supplied path rather than collapsing to `path: ""`. Deeply nested objects below evidence values are still uninspected; that is accepted scope and should be noted in the PR description.
