# ADR-0006: Update the existing TS integration tests to the pre-created-branch scenario

**Status:** Accepted
**Context:** Acceptance requires updating integration-worktree.test.ts and worktree.test.ts to the new flow, where the goal branch exists as a ref and the host stays on base.
**Decision:** In packages/baro-orchestrator/test/integration/integration-worktree.test.ts, add or adjust a case:
- Create a temp repo on main, run `git branch baro/goal-1 HEAD`, construct IntegrationWorktree, then prepare().
- Assert: __run is on baro/goal-1; the host's `git branch --show-current` is still main with an unchanged HEAD; baseSha equals main's SHA.
- Commit in __run, then call syncHostCheckout(). Expect fast_forwarded, with host HEAD equal to the goal SHA and the host still on main.
- Keep the existing cases for not_on_base_branch and host_checkout_dirty.

In worktree.test.ts, change any setup that runs `git checkout -b <goal>` on the host so it uses `git branch <goal> HEAD` and integrationRoot = the __run worktree.

Use worktree-fixture.ts helpers for runId and cleanup. Do not add new dependencies.
**Consequences:** The tests need a local git binary only; no network. Clean up with removeWorktreeRun in `after`/`finally`.
