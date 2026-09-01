# ADR-0005: Fix the write surface: which files may change, and which tests may be edited

**Status:** Accepted
**Context:** S1 (unique worktree run roots via the shared fixture) landed in a separate merge and is out of scope; the three failing tests encode the contract and must not be weakened; the repo has parallel agents that would otherwise each touch a different test to make things green.
**Decision:** Writable files (S2 surface only):
- packages/baro-orchestrator/src/harness/exec-file-cli.ts
- packages/baro-orchestrator/src/harness/process-cpu-activity.ts
- the CLI harness adapter file(s) under packages/baro-orchestrator/src/harness/** touched by ADR-002
- packages/baro-orchestrator/src/verification/verify.ts (only if a constant or comment must follow ADR-001/003; no message text lives here)
- tests: test/harness/exec-file-cli-cpu-watchdog.test.ts, test/harness/process-cpu-activity.test.ts, test/verification/verify.test.ts, test/verification/verify-run-level-retry.test.ts
Must NOT be modified, by anyone:
- test/harness/exec-file-cli.test.ts (holds two of the three protected failures)
- test/run-architect-outcome.test.ts (holds the third)
- test/integration/worktree-fixture.ts, test/integration/worktree.test.ts, test/integration/worktree-suspension-lineage.test.ts, test/integration/repository-command.test.ts, test/dependency-suspension-orchestrate.test.ts (S1)
- src/integration/worktree.ts, src/integration/repository-command.ts, src/harness/liveness.ts, src/harness/process-tree.ts
- anything under crates/, Cargo.toml, Cargo.lock
Allowed test edits are limited to: (a) exec-file-cli-cpu-watchdog.test.ts:196 — rewrite 'grants the first expiry an extension under the real default probe' into 'kills at the first expiry when the real default probe measures no CPU advance', asserting rejection matching /produced no output for 900ms — presumed hung/u, keeping ManualClock, IDLE_MS and the FIXTURE unchanged; (b) updating old-ceiling-wording assertions per ADR-001; (c) adding at most one case to process-cpu-activity.test.ts for the fraction branch. No test may be deleted, skipped, or have an assertion removed. No new npm dependency.
**Consequences:** Agents editing exec-file-cli.ts and the adapters have disjoint files; the only shared test file is exec-file-cli-cpu-watchdog.test.ts, which must be owned by the agent implementing ADR-003/004. Any remaining red test outside this list is a signal the design is wrong, not a licence to edit it.
