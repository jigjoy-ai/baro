# ADR-0009: Log budget decisions at both verify-plan call sites

**Status:** Accepted
**Context:** A plan field alone is not visible to users. The repo reports through `process.stderr.write('[orchestrate] ...')` in orchestrate.ts and `this.log('[finalizer] ...')` in finalizer.ts.
**Decision:** orchestrate.ts `createFinalPlan`: `for (const line of formatDeclaredBudgetEvidence(plan.declaredBudget)) process.stderr.write(`[orchestrate] ${line}\n`)`, run only when `plan.declaredBudget` exists.

finalizer.ts: `this.log(`[finalizer] ${line}`)` for each line, before `verifyBuild`.

Do not change verifyBuild, RunVerifier or VerifyResult.
**Consequences:** Every accepted and rejected request shows the story id and reason on each final verification. Evidence is also available programmatically at `plan.declaredBudget.decisions`.
