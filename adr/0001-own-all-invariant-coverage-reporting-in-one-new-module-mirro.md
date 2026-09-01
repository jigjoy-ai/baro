# ADR-0001: Own all invariant-coverage reporting in one new module mirroring obligation-coverage-report.ts

**Status:** Accepted
**Context:** The gap must be computed identically in the publisher, in the harness shim, in bus-session and on the coordinator path. obligation-coverage-report.ts already exists as the single owner for the obligation twin and its header states that role. Duplicating the computation per adapter is what produced run-72740 (validateGoalContractCoverage ran but never reported).
**Decision:** Create packages/baro-orchestrator/src/planning/domain/invariant-coverage-report.ts as the single owner. Exports (exact):
- `export function unownedInvariantIds(contract: GoalContract | null | undefined, stories: readonly Pick<PrdStory, "id" | "goalInvariantIds">[]): readonly string[]` — builds `GoalStoryInvariantMapping[]` as `{ storyId: story.id, invariantIds: story.goalInvariantIds ?? [] }`, calls `validateGoalContractCoverage(contract, mappings, "partial")` and returns `.missingInvariantIds`; on any throw returns every `contract.invariants[].id` (fail-as-full-gap, mirroring obligation-coverage-report.ts:27-30); returns `[]` for a null/undefined contract.
- `export function formatInvariantIdList(ids: readonly string[]): string` — `", "` join, cap `MAX_RENDERED_IDS = 40`, overflow suffix `` ` … (+${n} more)` ``, empty list → `""`.
- `export function invariantGapSummary(unowned: readonly string[], total: number): string` — `"N/T"` or `"N/T: id, id"`.
- `export function unownedInvariantsWithText(contract: GoalContract | null | undefined, ids: readonly string[]): readonly GoalInvariant[]` — contract order, unknown ids dropped.
- `export function renderUnownedInvariantLines(invariants: readonly GoalInvariant[]): string` — one `- [${id}] ${text}` per line, capped at `MAX_RENDERED_IDS` with a final `- … (+${n} more)` line.
Do NOT add a new dependency and do NOT re-implement `validateGoalContractCoverage`; extend it only as ADR-006 specifies. Do not change the inline mapping builders in runtime-replan.ts or orchestrate.ts in this run.
**Consequences:** Every other ADR imports from this file only. `unownedInvariantIds` intentionally ignores acceptance text; acceptance-claimed ids reach it through the folding in ADR-005. Fail-as-full-gap means a malformed contract announces a maximal gap rather than silently passing.
