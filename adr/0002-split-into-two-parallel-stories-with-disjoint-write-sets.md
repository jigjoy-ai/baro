# ADR-0002: Split into two parallel stories with disjoint write sets

**Status:** Accepted
**Context:** S3 (contract and gates) and S4 (admission and evidence) share no source file. S4 treats testBudget as `unknown` through DeclaredTestBudgetRequest, so it does not depend on the S3 types.
**Decision:** S3 writes:
- src/prd.ts
- src/events/runtime-graph.ts
- src/planning/domain/planner-validation.ts
- src/planning/domain/planner-prompts.ts
- src/planning/domain/progressive-plan.ts
- src/planning/adapters/planner-openai-progressive.ts
- src/runtime/runtime-replan.ts
- src/runtime-graph/legacy-replan.ts
- test/prd.test.ts
- test/planner-validation.test.ts

S4 writes:
- src/verification/prd-declared-tests.ts
- src/verification/verify.ts
- src/orchestrate.ts
- src/integration/finalizer.ts
- test/verification/declared-verification.test.ts
- test/verification/verify.test.ts

A final shipping step runs after both and handles verification and the PR. All paths are relative to packages/baro-orchestrator.
**Consequences:** S3 must add 'testBudget' to PLANNER_AUTHORED_STORY_FIELDS and to all five TS gate files in the same story, or the conformance test fails. executor.rs already contains testBudget. Neither story touches main.ts.
