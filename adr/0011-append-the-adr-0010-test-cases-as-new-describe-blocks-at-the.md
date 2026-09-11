# ADR-0011: Append the ADR-0010 test cases as new describe blocks at the end of each file

**Status:** Accepted
**Context:** Tests must be purely additive, in the existing node:test + node:assert/strict house style. Existing assertions and the conformance test stay untouched.
**Decision:** Add new top-level describe blocks at the end of each file. Reuse each file's existing imports and temp-dir/package.json fixture helpers, adding only new named imports.

test/verification/declared-verification.test.ts, `describe("negotiated declared test admission")`:
- (a) No testBudgets and 9 unique `npm test -- focusN` requirements, in a temp dir whose package.json has a test script. Expect 8 admitted declared executables, and an overflow reason matching /safe limit is 8 \(default; no story negotiated testBudget\)/. A plan built without the option has no declaredBudget key.
- (b) testBudgets [{storyId:'S1', testBudget:{commands:12, reason:'x'}}] with 12 requirements. Expect 12 admitted, no incompleteReason spec, effectiveLimit 12, negotiatedBy 'S1'.
- (c) The same budget with 13 requirements. Expect 12 admitted, and the reason is exactly '1 unique PRD test requirement(s) were not admitted; the safe limit is 12 (negotiated by story S1 testBudget)'.
- (d) Blank reason, commands 12.5 and commands 25, each with 9 requirements. Expect 8 admitted, negotiatedBy null, and a decision {storyId:'S1', status:'rejected'} whose detail is 'testBudget.reason must be a non-empty string', 'testBudget.commands must be an integer' and 'testBudget.commands must be at most 24' respectively.
- (e) readAuthoritativeVerifyPlanOptions on a temp prd.json with a valid budget on S1, `testBudget: null` on S2, and more than 64 test requirements. Expect testBudgets to deepEqual both raw requests. A missing path gives testBudgets [], and readAuthoritativeDeclaredTests still returns an array.
- (f) mergeVerifyPlans(baseline without declared commands, plan from (b)). Expect all 12 declared commands kept, no 'final verification additions beyond bounded budget' spec, and merged.declaredBudget.negotiatedBy 'S1'.
- (g) recommendedMergedVerifyTimeoutMs(baseline, 100) === recommendedMergedVerifyTimeoutMs(baseline, 24).

test/verification/verify.test.ts, `describe("negotiated declared budget timeouts")`:
- recommendedVerifyTimeoutMs(negotiated 12-command plan) - recommendedVerifyTimeoutMs(default plan with the same 12 requirements) === 4 * 608_000.
- recommendedMergedVerifyTimeoutMs(baseline, 12) - recommendedMergedVerifyTimeoutMs(baseline) === 4 * 2 * 608_000.

test/prd.test.ts, `describe("story testBudget contract")`:
- An object testBudget (including an invalid {commands:12.5, reason:''}) survives loadPrd/savePrd verbatim, and a non-object testBudget is omitted.
- applyReplan / applyReplanWithEffectiveDelta with an added story carrying testBudget produce PrdStory.testBudget and applied.addedStories[0].testBudget, each deepEqual to the source but notStrictEqual. Mutating the source afterwards leaves both unchanged.

test/planner-validation.test.ts, `describe("final PRD story testBudget")`:
- A blank reason, 12.5 and 25 each throw exactly `final PRD story S1 <leaf rejection>`.
- {commands:12, reason:'x'} passes.
**Consequences:** Diffs to these four files contain only added lines. prd-story-boundary-conformance.test.ts is not edited.
