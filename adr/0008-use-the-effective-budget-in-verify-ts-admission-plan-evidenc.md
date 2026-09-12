# ADR-0008: Use the effective budget in verify.ts admission, plan evidence and the merge limit

**Status:** Accepted
**Context:** ADR 0007
**Decision:** Types:
- VerifyPlanOptions adds `readonly testBudgets?: readonly DeclaredTestBudgetRequest[]`.
- VerifyPlan adds `readonly declaredBudget?: DeclaredBudgetEvidence`.
- Delete MAX_DECLARED_TRANSLATION_INPUTS and add `export function maxDeclaredTranslationInputs(effectiveLimit: number): number { return MAX_COMPACTED_RSTEST_PATHS * effectiveLimit }`.

createVerifyPlan:
- `const budget = resolveDeclaredBudget(options.testBudgets ?? [])` and `const translationLimit = maxDeclaredTranslationInputs(budget.effectiveLimit)`.
- Use translationLimit for the slice, the overflow check and the overflow count. The overflow label and key stay unchanged.
- Return `freezeVerifyPlan(boundedDeclaredCommands(detected.commands, declaredCommands, budget), detected.javascriptPackageManagers, options.testBudgets !== undefined ? budget : undefined)`.

boundedDeclaredCommands(automatic, declared, budget: DeclaredBudgetEvidence):
- The cap is `admitted >= budget.effectiveLimit`.
- The reason is `${omitted} unique PRD test requirement(s) were not admitted; the safe limit is ${budget.effectiveLimit} ` followed by `(default; no story negotiated testBudget)` when negotiatedBy is null, else `(negotiated by story ${budget.negotiatedBy} testBudget)`.
- The label and origin stay unchanged.

freezeVerifyPlan(commands, managers = [], declaredBudget?: DeclaredBudgetEvidence):
- Add `...(declaredBudget ? { declaredBudget: Object.freeze({ ...declaredBudget, decisions: Object.freeze(declaredBudget.decisions.map((d) => Object.freeze({ ...d }))) }) } : {})`.

mergeVerifyPlans:
- `const finalBudget = plans.at(-1)?.declaredBudget`.
- `const finalAddedLimit = MAX_FINAL_ADDED_VERIFY_COMMANDS + Math.max(0, (finalBudget?.effectiveLimit ?? MAX_DECLARED_VERIFY_COMMANDS) - MAX_DECLARED_VERIFY_COMMANDS)`.
- Replace the constant in the cap check and in the message `the adaptive verification limit is ${finalAddedLimit}`.
- Return `freezeVerifyPlan(commands, packageManagers, finalBudget)`.
**Consequences:** A plan built without testBudgets has no declaredBudget key, so existing deepEqual assertions still hold. Overflow stays a non-executable incompleteReason spec.
