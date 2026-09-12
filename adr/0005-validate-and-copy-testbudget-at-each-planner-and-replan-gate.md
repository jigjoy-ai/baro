# ADR-0005: Validate and copy testBudget at each planner and replan gate with fixed messages

**Status:** Accepted
**Context:** ADR 0004. The progressive and replan gates reject unknown keys and rebuild stories key by key.
**Decision:** planner-validation.ts, inside the per-story loop directly after the model check: `if (story.testBudget !== undefined) { const judgement = judgeTestBudget(story.testBudget); if (!judgement.accepted) throw new Error(`final PRD story ${id} ${judgement.rejection}`) }`.

progressive-plan.ts validateProgressivePlannerStory:
- Optional keys become ["model","goalInvariantIds","writes","testBudget"].
- After the writes check: if value.testBudget !== undefined and the judge rejects, `throw contractError("invalid_fragment", `${label} '${id}' ${judgement.rejection}`)`.
- In the returned object, after the writes spread: `...(value.testBudget !== undefined ? { testBudget: { commands: (value.testBudget as PrdTestBudget).commands, reason: (value.testBudget as PrdTestBudget).reason } } : {})`.
- Leave comparableStory unchanged.

planner-openai-progressive.ts:
- `const OPTIONAL_PRD_STORY_KEYS = ["writes", "testBudget"] as const`.
- progressiveFinalPrd: after the writes spread, add `...(story.testBudget !== undefined ? { testBudget: { ...(story.testBudget as PrdTestBudget) } } : {})`.
- snapshotPlannerStory: after the writes spread, add `...(story.testBudget !== undefined ? { testBudget: { ...story.testBudget } } : {})`.
- Nothing else changes: not the tool schema, not FINAL_PRD_STORY_KEYS, not the prompt strings.

runtime-replan.ts:
- validateAddedStoryShape: add "testBudget" to hasOnlyKeys. After the writes check, add `if (story.testBudget !== undefined) { const judgement = judgeTestBudget(story.testBudget); if (!judgement.accepted) return `added story '${story.id}' ${judgement.rejection}` }`.
- clonePrd, toPrdStory and snapshotStoryAdd each add `...(story.testBudget !== undefined ? { testBudget: { ...story.testBudget } } : {})` after their writes spread.
- Leave validPrdStoryShape unchanged.

legacy-replan.ts parseAddedStory:
- Add "testBudget" to onlyKeys.
- Add `(value.testBudget !== undefined && !judgeTestBudget(value.testBudget).accepted) ||` to the malformed condition. The reason string stays unchanged.
- In the returned story, after writes: `...(value.testBudget !== undefined ? { testBudget: { commands: (value.testBudget as { commands: number }).commands, reason: (value.testBudget as { reason: string }).reason } } : {})`.
**Consequences:** Progressive tool-calling planners still cannot author testBudget, because the schema is unchanged, but they keep it on fragments. Rejections from the gates reuse the leaf's exact strings.
