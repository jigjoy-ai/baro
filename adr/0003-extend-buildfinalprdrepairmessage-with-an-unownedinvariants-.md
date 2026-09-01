# ADR-0003: Extend buildFinalPrdRepairMessage with an `unownedInvariants` input rendered by renderUnownedInvariantLines

**Status:** Accepted
**Context:** The finalization repair prompt (planner-prompts.ts:573-611) lists unowned obligation ids only. The goal requires it to additionally list unowned INVARIANT ids with their canonical statements, sourced from the #116 coverage report. invariant-coverage-report.ts already owns the `- [ID] text` renderer (`renderUnownedInvariantLines`, :62-72, cap 40 with `- … (+N more)`), which is the #116 vocabulary; passing raw ids and re-rendering text in planner-prompts.ts would fork the format.
**Decision:** In packages/baro-orchestrator/src/planning/domain/planner-prompts.ts:
- Extend the input object of `buildFinalPrdRepairMessage` with one optional field: `unownedInvariants?: readonly GoalInvariant[]` (type imported from the same module planner-prompts.ts already uses for goal-contract types; import `renderUnownedInvariantLines` from "./invariant-coverage-report.js"). Do NOT add an ids-only field, do NOT add a GoalContract parameter, do NOT make it required.
- Emit a new section immediately AFTER the obligations section and BEFORE the `Expected schema:` section, skipped entirely when the list is empty, with exactly these three lines (sections joined by the existing `\n\n`):
  `Unowned goal invariants (<N>):`
  `<renderUnownedInvariantLines(input.unownedInvariants)>`
  `Every id above must be claimed via goalInvariantIds of a story in THIS reply — already-published stories are immutable and cannot take them later.`
  where `<N>` is `input.unownedInvariants.length`.
- Leave the obligations section bytes untouched (test/planner-finalization-repair.test.ts:556 pins them).
**Consequences:** Existing callers (test/planner-finalization-repair.test.ts:528,545; test/planning/planner-prompts-repair.test.ts:89,114,118,121) compile unchanged because the field is optional; their expected strings stay valid since the section is omitted when absent. The `- [ID] text` shape has exactly one owner.
