# ADR-0003: Import judgeTestBudget directly from the leaf with these exact specifiers

**Status:** Accepted
**Context:** The leaf has no imports, so importing it cannot create a cycle. verify.ts re-exports only the constants and types, not the functions.
**Decision:** Add `import { judgeTestBudget } from "<spec>"` with these specifiers:
- src/prd.ts: "./verification/declared-test-budget.js"
- planning/domain/planner-validation.ts and progressive-plan.ts: "../../verification/declared-test-budget.js"
- runtime/runtime-replan.ts and runtime-graph/legacy-replan.ts: "../verification/declared-test-budget.js"

planner-openai-progressive.ts needs no judge. Import `type PrdTestBudget` from its existing prd.js import if a cast needs it.

verify.ts extends its existing leaf import to `{ MAX_DECLARED_VERIFY_COMMANDS, MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS, resolveDeclaredBudget, type DeclaredBudgetEvidence, type DeclaredTestBudgetRequest }`. Keep the existing re-exports unchanged.

orchestrate.ts and finalizer.ts import formatDeclaredBudgetEvidence from the leaf ("./verification/declared-test-budget.js" and "../verification/declared-test-budget.js"). orchestrate.ts adds MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS to its existing ./verification/verify.js import.
**Consequences:** No new dependencies, and no child_process or shell usage.
