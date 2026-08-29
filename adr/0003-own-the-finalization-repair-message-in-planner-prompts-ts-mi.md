# ADR-0003: Own the finalization repair message in planner-prompts.ts, mirroring the v0.100.0 architect recipe verbatim in structure

**Status:** Accepted
**Context:** The current retry text (planner-bus-session.ts:546-553) states neither the defect list, the terminal JSON shape, nor a discard warning. The architect path already solved this failure class at architect-bus-session.ts:446-452 with an inline literal built from `contractDefects`/`formatDefectList`, byte-pinned by test/architect-bus-session.test.ts:187-229. The goal forbids inventing new vocabulary, so the planner message must reuse those section labels and those shared primitives rather than paraphrasing. planning/domain/planner-prompts.ts already owns planner prompt text, mirroring architect-prompts.ts.
**Decision:** In packages/baro-orchestrator/src/planning/domain/planner-prompts.ts add two exports.
(a) `export const PLANNER_FINAL_PRD_SCHEMA_SUMMARY: string` — the terminal JSON shape, modeled on ARCHITECT_OUTCOME_SCHEMA_SUMMARY (architect-outcome.ts:76-81), exactly these joined lines:
`{"project": string, "branchName": string, "description": string, "userStories": [...]}`
`userStories[i]: {"id": string, "title": string, "description": string, "acceptance": string[]}`
`acceptance[i] claiming an obligation starts with the bracketed id, e.g. "[O-001] <criterion text>"`
(b) `export function buildFinalPrdRepairMessage(input: { reason: string; error?: unknown; unownedObligationIds: readonly string[] }): string` producing, in this order and with a blank line between sections:
1. `Your final PRD was rejected. Fix every defect listed below in one reply.`
2. `Defects (${defects.length}):\n${formatDefectList(defects)}` where `defects = contractDefects(input.error)` and, when that is empty, `[{ path: "", message: input.reason }]`. Import `contractDefects` and `formatDefectList` from ../../contract/contract-normalization.
3. Only when `unownedObligationIds.length > 0`: `Unowned architecture obligations (${n}):\n${formatObligationIdList(ids)}` followed by the line `Every id above must be claimed by an acceptance criterion of a story in THIS reply — already-published stories are immutable and cannot take them later.`
4. `Expected schema:\n${PLANNER_FINAL_PRD_SCHEMA_SUMMARY}` — unconditional here (unlike architect-bus-session.ts:448-450, whose summary is optional).
5. `Reply with ONLY the corrected final PRD JSON object. Anything that is not that JSON object is discarded. The host already holds every published story verbatim — userStories must contain only the stories that come after the published prefix (an empty array if nothing remains), plus the usual project, branchName and description metadata.`
Do NOT create a new module for this, do NOT export a second variant, and do NOT reword `Defects (N):` or the `- <path>: <message>` line format owned by contract-normalization.ts.
**Consequences:** One string owner for the planner repair prompt; tests byte-pin it the way test/architect-bus-session.test.ts:187-229 pins the architect one. Section 3 is conditional, so a non-coverage rejection (e.g. unparsable JSON) yields defects + schema + discard warning only. planner-prompts.ts gains an import from src/contract/ and from obligation-coverage-report.ts.
