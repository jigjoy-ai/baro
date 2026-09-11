# ADR-0007: Add readAuthoritativeVerifyPlanOptions with a separate budget pass

**Status:** Accepted
**Context:** ADR 0006. The existing reader returns early when requirements overflow and turns every failure into a DeclaredTestRequirement.
**Decision:** In src/verification/prd-declared-tests.ts, rename the current body into `export function readAuthoritativeVerifyPlanOptions(prdPath: string): { declaredTests: DeclaredTestRequirement[]; testBudgets: DeclaredTestBudgetRequest[] }`. Import the type DeclaredTestBudgetRequest from "./declared-test-budget.js".

- Unreadable or unparseable file: return { declaredTests: [the existing '<unreadable>' issue], testBudgets: [] }.
- userStories not an array: return the existing issue with testBudgets [].
- Otherwise, before the requirement loop, run a separate budget pass. For i from 0 to min(userStories.length, MAX_STORIES_INSPECTED): if the story is a non-null, non-array object and `Object.hasOwn(story, "testBudget")`, push `{ storyId, testBudget: story.testBudget }`.
  - storyId uses the existing derivation: safeEvidenceText(id, 100) for a string id, else `userStories[${i}]`.
  - The raw value is preserved, including null and invalid values.
- Every early return inside the requirement loop, including overflow, returns { declaredTests, testBudgets }.
- Keep `export function readAuthoritativeDeclaredTests(prdPath: string): DeclaredTestRequirement[] { return readAuthoritativeVerifyPlanOptions(prdPath).declaredTests }`.
**Consequences:** The existing reader tests stay unchanged. Requirement overflow can no longer hide budget requests.
