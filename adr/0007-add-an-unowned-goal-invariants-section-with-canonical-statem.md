# ADR-0007: Add an unowned-goal-invariants section with canonical statements to buildFinalPrdRepairMessage

**Status:** Accepted
**Context:** buildFinalPrdRepairMessage (planner-prompts.ts:573-612) emits obligation ids only, and its section ordering plus byte-identity when an optional input is absent is asserted by test/planning/planner-prompts-repair.test.ts:87-125. The goal requires invariant ids together with their canonical statements so the planner can copy them.
**Decision:** Extend the input of `buildFinalPrdRepairMessage` with the OPTIONAL field `readonly unownedInvariants?: readonly GoalInvariant[]`. When present and non-empty, push exactly one section AFTER the unowned-obligations section (:593-601) and BEFORE the `Expected schema:` section (:602):
```
Unowned goal invariants (${n}):
${renderUnownedInvariantLines(invariants)}
Every id above must appear in the goalInvariantIds of a story in THIS reply — already-published stories are immutable and cannot take them later. Copy each statement verbatim as the acceptance criterion text, prefixed with its bracketed id.
```
where the trailing sentence pair is one concatenated string with no internal newline, matching the obligation section's style. Section order is therefore: intro, Defects, write-surface overlap, unowned obligations, unowned goal invariants, Expected schema, terminal-shape paragraph; sections still joined with `"\n\n"`. When the field is absent or empty the message must be byte-identical to today. Add the third line rule to `PLANNER_FINAL_PRD_SCHEMA_SUMMARY` only if it does not already state the goalInvariantIds shape; do not otherwise reword that constant. The caller is planner-bus-session.ts:580-585, building the array via `unownedInvariantsWithText(goalContract, resolveUnownedInvariants(error))`.
**Consequences:** Optional field preserves the existing byte-identity test. Statements are rendered from GoalInvariant.text only, never from story acceptance, so the prompt cannot propagate drift.
