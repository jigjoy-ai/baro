# ADR-0003: Fix the declared-verification test cases to the exact acceptance list, in the existing test file

**Status:** Accepted
**Context:** test/verification/declared-verification.test.ts uses node:test + node:assert/strict with `withTempDir`, `createVerifyPlan(dir, {declaredTests})` and `translateDeclaredTests(dir, requirements, ["npm"])`; the only exact node-label assertion today is :753. Agents could otherwise disagree on which entry point and which assertion style to use.
**Decision:** Append one new `it(...)` block per case to the existing `describe` in `packages/baro-orchestrator/test/verification/declared-verification.test.ts`, reusing `withTempDir` and `translateDeclaredTests` (same style as the case at :726-754). Required cases:
1. `node --import tsx --test <contained path>` → `tool === "node"`, `deepEqual(args, ["--import", "tsx", "--test", "<path>"])`, `equal(label, "node --import tsx --test <path>")`.
2. `node --import tsx --test <p1> <p2>` (two contained paths) → args `["--import","tsx","--test",p1,p2]`.
3. `node --import tsx --check <file>` → args `["--import","tsx","--check",file]`, label `node --import tsx --check <file>`.
4. `node --import other --test x` → incomplete; assert `incompleteReason` matches the existing mode-gate message (`assert.match(spec?.incompleteReason ?? "", /node declarations/u)` or the exact current wording from declared-verification.ts:729 — read it and match it, do not invent a new one).
5. `node --import ./evil.mjs --test x` → incomplete, same reason.
6. `node --import=tsx --test x` → incomplete, same reason.
7. Regression: plain `node --test <path>` and `node --check <file>` still produce args `["--test", path]` / `["--check", file]` and labels without any loader tokens.
8. Greenfield regression: with no package.json in the temp dir, bare `node test.js` still yields `args === ["test.js"]` (the existing case at :821-864 must still pass unmodified).
Do not modify or delete any existing test in this file.
**Consequences:** The acceptance criteria for gap (1) are checked exactly; label assertions lock in the preserved full command form. Case 8 guards the `rest.length === 1` rewrite of the greenfield condition.
