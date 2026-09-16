# ADR-0007: Add a regression test for a real orchestrate() run that leaves the host checkout untouched

**Status:** Accepted
**Context:** Acceptance requires a real temp repo with a full orchestrate run: afterwards the checkout must still be on base at the base commit, and the goal branch must contain the merged stories.
**Decision:** New file: packages/baro-orchestrator/test/integration/host-checkout-untouched-orchestrate.test.ts.

Copy the fake-agent and config setup from test/dependency-suspension-orchestrate.test.ts or test/execution/operator-hooks-orchestrate.test.ts; whichever uses a real git repo with stub story agents.

Steps:
1. Temp repo on main with one commit and no origin (so publishRemote/finalizer are skipped).
2. Run `git branch baro/regression-1 HEAD`.
3. Write prd.json with branchName "baro/regression-1" and 2 stories whose stub agents each commit one file.
4. Call orchestrate({... cwd/repo, prdPath, continueRun: false, worktrees enabled}).
5. While the run is in progress (in a story stub hook, where the harness allows it) and after it finishes, assert the host's `git branch --show-current` === "main".
6. After the run, assert that `git ls-tree -r baro/regression-1` contains both story files.
7. Assert host HEAD is either the base SHA or, if the fast-forward ran, the goal SHA with the branch still main. Assert explicitly that the host checkout never switched branches.
8. Also run a case with a dirty host (a tracked file modified before the run). Host HEAD must equal the base SHA at the end.

Also add a Rust test, git.rs fresh_branch_leaves_head_on_base, if ADR-001's tests do not already cover it.
**Consequences:** If fast-forward is expected to land, set the assertion on the base commit before the run and use the dirty-host case to pin 'unchanged'. Keep the timeout within the existing test concurrency=2 lane.
