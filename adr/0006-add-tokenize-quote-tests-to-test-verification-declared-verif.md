# ADR-0006: Add tokenize quote tests to test/verification/declared-verification.test.ts

**Status:** Accepted
**Context:** The declared-verification defect needs regression tests for both the newly accepted and the still-rejected forms, and `tokenize` is not exported, so it must be exercised through `translateDeclaredTests`/`createVerifyPlan`.
**Decision:** Put the new cases in `packages/baro-orchestrator/test/verification/declared-verification.test.ts` (extend it if it exists; create it with the node:test + node:assert/strict style and `.js` import specifiers if it does not). Exercise `tokenize` indirectly through the exported `translateDeclaredTests`. Required cases:
(a) three declared commands, each translating to a runnable spec with no `incompleteReason` and with quote-free `args`: `node --import tsx --test "test/acceptance/turn-review.test.ts"`, `node --import tsx --test 'test/verification/declared-verification.test.ts'`, and a single command carrying two quoted paths `node --import tsx --test "test/acceptance/turn-review.test.ts" "test/verification/declared-verification.test.ts"`;
(b) `echo "a; rm -rf /"` yields `incompleteReason === "declared test contains unsupported quoting, shell, or glob syntax"`;
(c) a mid-token quote (`node --test foo"bar`) yields that same string;
(d) an unpaired quote (`node --test "test/acceptance/turn-review.test.ts`) yields that same string.
Assert the exact message strings as literals, not regexes.
**Consequences:** This file is owned exclusively by the declared-verification story; it must not touch test/acceptance/*. If the file already exists, the story must append `it(...)` cases inside the existing `describe` rather than restructuring it.
