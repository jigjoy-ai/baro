# ADR-0003: Add optional `testBudget` to the PrdStory contract in prd.ts

**Status:** Accepted
**Context:** The goal requires the story contract, known keys, validation, normalization and cloning to support the field. The raw reader must still see invalid values so they can be rejected visibly. Validating inside normalization would silently drop invalid values on persistence.
**Decision:** prd.ts changes:
- Add `export interface PrdTestBudget { commands: number; reason: string }` and a `testBudget?: PrdTestBudget` field on `PrdStory`, placed after `goalInvariantIds`.
- Append 'testBudget' to both `PRD_STORY_FIELDS` and `PLANNER_AUTHORED_STORY_FIELDS`.

`normalizeStory` (:795):
- If `plainRecord(input.testBudget)`, emit `testBudget: { commands: raw.commands as number, reason: raw.reason as string }`. The values are copied verbatim and not validated; admission judges them.
- Otherwise omit the field. Spread it as `...(testBudget ? { testBudget } : {})`.

The other gates:
- `validStoredRuntimeStory` (:731): add 'testBudget' to the `onlyKeys` list and require `value.testBudget === undefined || judgeTestBudget(value.testBudget).accepted`.
- `cloneReplanStoryAdd` (:1010): add `...(story.testBudget ? { testBudget: { ...story.testBudget } } : {})`.
- Wherever `applyReplan`/`applyReplanWithEffectiveDelta` turn a `ReplanStoryAdd` into a `PrdStory`, copy `testBudget` the same way.
- events/runtime-graph.ts `ReplanStoryAdd`: add `testBudget?: { readonly commands: number; readonly reason: string }`.
**Consequences:** `loadPrd`/`savePrd` round-trips keep the object shape. Tests go in test/prd.test.ts: an object value survives normalization, a non-object value is dropped, and cloning deep-copies.
