# ADR-0010: Pass testBudgets and log budget evidence at both final-plan call sites

**Status:** Accepted
**Context:** ADRs 0006 and 0009. The repo's logging conventions are process.stderr.write('[orchestrate] ...') and this.log('[finalizer] ...').
**Decision:** orchestrate.ts:
- Replace the readAuthoritativeDeclaredTests import with readAuthoritativeVerifyPlanOptions.
- createFinalPlan becomes: `loadPrd(config.prdPath); const plan = createVerifyPlan(cwd, readAuthoritativeVerifyPlanOptions(config.prdPath)); if (plan.declaredBudget) { for (const line of formatDeclaredBudgetEvidence(plan.declaredBudget)) process.stderr.write(`[orchestrate] ${line}\n`) } return plan`.

finalizer.ts:
- Replace the import in the same way.
- `const options = readAuthoritativeVerifyPlanOptions(this.opts.prdPath)`.
- When !prd, push the existing 'final PRD' / 'full schema validation' issue onto options.declaredTests.
- `const finalVerifyPlan: VerifyPlan = createVerifyPlan(this.opts.cwd, { declaredTests: options.declaredTests, testBudgets: options.testBudgets })`.
- Then `if (finalVerifyPlan.declaredBudget) for (const line of formatDeclaredBudgetEvidence(finalVerifyPlan.declaredBudget)) this.log(`[finalizer] ${line}`)`, before the verifyBuild call.

Do not change verifyBuild, RunVerifier or VerifyResult.
**Consequences:** Each accepted or rejected request prints one line per final verification. A PRD with no requests prints nothing.
