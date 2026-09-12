# ADR-0004: Add PrdTestBudget to the story contract in prd.ts and runtime-graph.ts

**Status:** Accepted
**Context:** ADR 0003. Normalization must keep invalid values visible so admission can reject them.
**Decision:** prd.ts:
- `export interface PrdTestBudget { commands: number; reason: string }`.
- On PrdStory, add `testBudget?: PrdTestBudget` directly after goalInvariantIds.
- Append 'testBudget' as the last element of PRD_STORY_FIELDS and of PLANNER_AUTHORED_STORY_FIELDS.

normalizeStory:
- `const testBudget = plainRecord(input.testBudget) ? { commands: input.testBudget.commands as number, reason: input.testBudget.reason as string } : undefined`. Use the file's existing plainRecord helper or its equivalent object check.
- Spread `...(testBudget ? { testBudget } : {})` into the output next to goalInvariantIds.

validStoredRuntimeStory:
- Add 'testBudget' to its onlyKeys list.
- Add `value.testBudget === undefined || judgeTestBudget(value.testBudget).accepted` to the validity conjunction.

Copy sites:
- cloneReplanStoryAdd: `...(story.testBudget ? { testBudget: { ...story.testBudget } } : {})`.
- The PrdStory builder in applyReplanWithEffectiveDelta: the same spread. applyReplan inherits it.

src/events/runtime-graph.ts ReplanStoryAdd: add `testBudget?: { readonly commands: number; readonly reason: string }` after writes.
**Consequences:** loadPrd/savePrd round-trips keep {commands, reason} verbatim, including invalid numbers. A non-object value is dropped. Replan copies never share a reference with their source.
