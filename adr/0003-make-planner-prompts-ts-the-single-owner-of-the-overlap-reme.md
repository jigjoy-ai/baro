# ADR-0003: Make planner-prompts.ts the single owner of the overlap remedy wording

**Status:** Accepted
**Context:** The repo's existing ADR puts the finalization repair message in planner-prompts.ts, and the goal requires one recipe, not a second dialect. planner-prompts.ts already owns the `Label (N):` section vocabulary. Placing the wording in runtime-replan.ts or the coordinator would create a second dialect and mix validation with prompting.
**Decision:** In packages/baro-orchestrator/src/planning/domain/planner-prompts.ts add exactly one exported renderer (type imported type-only from ../../events/runtime-graph.js):

export function buildWriteSurfaceOverlapRemedySection(facts: WriteSurfaceOverlapFacts): string

It returns a single block, lines joined by "\n", in this exact shape:

Write-surface overlap (<owners.length>):
- story '<storyId>' owns: <ownedFiles joined ", ">; collides on: <collidingPaths joined ", ">
  (one such line per owner, in `owners` order)
Remedies (pick one):
1. Drop the overlapping file(s) from this story and keep only the files still available to it: <remainingPaths joined ", "> — or "no files remain available to this story" when `remainingPaths` is empty.
2. Drop this story entirely if its purpose is already covered by a settled story's merged output.
3. Re-scope this story onto files no settled story owns.

Extend `buildFinalPrdRepairMessage` (planner-prompts.ts:546-579) input to `{ reason, error?, unownedObligationIds, writeSurfaceOverlap?: WriteSurfaceOverlapFacts }`. When `writeSurfaceOverlap` is present, insert `buildWriteSurfaceOverlapRemedySection(writeSurfaceOverlap)` as a section AFTER the `Defects (N):` section (:558) and BEFORE the unowned-obligations section (:560-568); all other sections, their order and their text stay byte-identical. Sections remain joined by "\n\n" (:578). Do not add a remedy dialect anywhere else; `mode-enforcement.ts:96-104` and planner-prompts.ts:341 stay as they are.
**Consequences:** One function owns the wording for both the fragment-rejection tool error and the finalization repair message. Existing repair-message assertions that match the four fixed sections still pass because insertion is additive and only occurs when facts are present.
