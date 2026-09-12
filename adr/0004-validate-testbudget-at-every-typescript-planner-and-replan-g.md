# ADR-0004: Validate testBudget at every TypeScript planner and replan gate using judgeTestBudget

**Status:** Accepted
**Context:** The conformance test requires every gate to name each planner-authored field. The progressive and replan gates reject unknown keys, so without these changes a story carrying testBudget would be rejected or silently lose the field. The progressive OpenAI tool schema is strict (every property required, `additionalProperties:false`), so adding a property there would force a nullable union onto every story.
**Decision:** planner-validation.ts: after the model check (:101-105), add:
`if (story.testBudget !== undefined) { const j = judgeTestBudget(story.testBudget); if (!j.accepted) throw new Error(`final PRD story ${id} ${j.rejection}`) }`

planner-prompts.ts: add one bullet in the 'Plan shape' section, right after the tests bullet (:152-156). Wording: optional "testBudget": {"commands": <integer 9-24>, "reason": "<why this story needs more than 8 declared test commands>"}, which raises the run's declared-test admission limit (default 8, max 24); use it only when necessary. Do NOT add it to the example JSON (:159-179).

progressive-plan.ts `validateProgressivePlannerStory`:
- Add 'testBudget' to the optional keys list at :213.
- If present and `!judgeTestBudget(...).accepted`, throw `contractError('invalid_fragment', `${label} '${id}' ${rejection}`)`.
- Copy `{commands, reason}` into the returned story.

planner-openai-progressive.ts:
- Add 'testBudget' to `OPTIONAL_PRD_STORY_KEYS`.
- Copy it in `progressiveFinalPrd` and `snapshotPlannerStory` using `...(story.testBudget !== undefined ? { testBudget: { ...story.testBudget } } : {})`.
- Do NOT change the strict tool schema at :150-207, and do NOT change the prompt text at :99-100.

runtime-replan.ts `validateAddedStoryShape`:
- Add 'testBudget' to the key list.
- Return `added story '${id}' ${rejection}` when the judge rejects.
- Copy the field in the story builders at ~:620, :638 and :665.

legacy-replan.ts: add the key at ~:207, treat a rejected judgement as invalid, and copy the field at ~:249.
**Consequences:** Planner-produced PRDs can only carry valid budgets. Invalid budgets in hand-edited or persisted PRDs are still caught at admission. Progressive tool-calling planners cannot author testBudget yet; that is a follow-up, but their fragments preserve it. Add tests to test/planner-validation.test.ts for blank reason, a non-integer, a value above the ceiling, and a valid value passing.
