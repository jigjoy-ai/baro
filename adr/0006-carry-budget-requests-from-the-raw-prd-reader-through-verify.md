# ADR-0006: Carry budget requests from the raw PRD reader through VerifyPlanOptions

**Status:** Accepted
**Context:** Admission needs the raw per-story testBudget values, including invalid ones. The existing reader returns a flat requirement list and stops early when requirements overflow.
**Decision:** verify.ts `VerifyPlanOptions`: add `readonly testBudgets?: readonly DeclaredTestBudgetRequest[]`.

prd-declared-tests.ts: add `export function readAuthoritativeVerifyPlanOptions(prdPath: string): { declaredTests: DeclaredTestRequirement[]; testBudgets: DeclaredTestBudgetRequest[] }`.
- Budgets are collected in a separate pass over the first `MAX_STORIES_INSPECTED` stories, before the requirement loop, so requirement overflow cannot hide them.
- For each plain-object story that has an own key 'testBudget', push `{ storyId, testBudget: value.testBudget }`. Use the same storyId derivation as the existing code (`safeEvidenceText(id, 100)`, falling back to `userStories[i]`).
- If the file is unreadable or malformed, return `testBudgets: []` along with the existing issue list.
- `readAuthoritativeDeclaredTests(prdPath)` stays, as a wrapper returning `.declaredTests`.

Callers:
- orchestrate.ts:1328-1330: `const options = readAuthoritativeVerifyPlanOptions(config.prdPath); const plan = createVerifyPlan(cwd, options)`, then log the evidence (see the logging ADR) and return the plan.
- finalizer.ts:486-497: build `options` the same way, push the 'final PRD' issue onto `options.declaredTests` when `!prd`, and call `createVerifyPlan(this.opts.cwd, { declaredTests: options.declaredTests, testBudgets: options.testBudgets })`.
**Consequences:** Existing callers and tests of `readAuthoritativeDeclaredTests` are unchanged. `testBudget: null` in the PRD produces a request, which the judge rejects visibly.
