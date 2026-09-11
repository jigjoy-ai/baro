# ADR-0007: Admit declared commands against the effective budget and record it on the plan

**Status:** Accepted
**Context:** The goal requires the effective limit to replace the hard-coded 8, the overflow reason to name the limit and who negotiated it, translation inputs to scale with the limit, and visible evidence of every decision. `mergeVerifyPlans` would otherwise cut negotiated final additions back to 8.
**Decision:** verify.ts `VerifyPlan`: add `readonly declaredBudget?: DeclaredBudgetEvidence`.

`createVerifyPlan`:
- `const budget = resolveDeclaredBudget(options.testBudgets ?? [])`.
- Remove the private `MAX_DECLARED_TRANSLATION_INPUTS` and add `export function maxDeclaredTranslationInputs(effectiveLimit: number): number { return MAX_COMPACTED_RSTEST_PATHS * effectiveLimit }`. Use `maxDeclaredTranslationInputs(budget.effectiveLimit)` for the slice, the overflow check and the overflow count.
- Call `boundedDeclaredCommands(detected.commands, declaredCommands, budget)`.

`boundedDeclaredCommands`: cap at `budget.effectiveLimit`. The overflow reason is exactly:
- `${omitted} unique PRD test requirement(s) were not admitted; the safe limit is ${budget.effectiveLimit} ` followed by
- '(default; no story negotiated testBudget)' when `negotiatedBy` is null, or
- `(negotiated by story ${budget.negotiatedBy} testBudget)` otherwise.

`freezeVerifyPlan(commands, managers, declaredBudget?)`:
- Freeze the evidence and its decisions array and entries.
- Set the property only when `options.testBudgets !== undefined`, so a plan built without `testBudgets` has no `declaredBudget` key.

`mergeVerifyPlans`:
- `const finalBudget = plans.at(-1)?.declaredBudget`.
- `const finalAddedLimit = MAX_FINAL_ADDED_VERIFY_COMMANDS + Math.max(0, (finalBudget?.effectiveLimit ?? MAX_DECLARED_VERIFY_COMMANDS) - MAX_DECLARED_VERIFY_COMMANDS)`. Use it in place of the constant at :854 and in the :878 message.
- Pass `finalBudget` through to `freezeVerifyPlan`.
**Consequences:** Default behavior and existing messages keep the 'the safe limit is 8' prefix. The plan is still fail-closed: overflow stays a non-executable incompleteReason spec. Deep-equality tests on plans built without `testBudgets` are unaffected.
