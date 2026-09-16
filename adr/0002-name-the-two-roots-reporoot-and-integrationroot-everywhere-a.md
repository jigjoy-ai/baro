# ADR-0002: Name the two roots repoRoot and integrationRoot everywhere, and use integrationRoot only when worktrees are enabled and the host is not on the goal branch

**Status:** Accepted
**Context:** Today every consumer takes an ambiguous `cwd` equal to config.cwd. Git refuses to check out the same branch in two worktrees, so the integration worktree cannot be used in continue mode or when the host is already on the goal branch. Shared-tree mode (worktrees disabled) runs story agents directly in the checkout.
**Decision:** In orchestrate.ts, after useGit, worktreesEnabled and the continue-mode block:
- `const repoRoot = config.cwd`
- `const goalBranch = normalizeGoalBranchName(loadPrd(config.prdPath).branchName)` (only when useGit)
- `const hostBranch = useGit ? await getCurrentBranch(repoRoot) : null`
- `const integrationWorktree = useGit && worktreesEnabled && hostBranch !== goalBranch ? new IntegrationWorktree({ repoRoot, gitGate, runId, goalBranch, push: pushRemote, onLog }) : null`
- `const integrationRoot = integrationWorktree?.integrationRoot ?? repoRoot`

If integrationWorktree is non-null, orchestrate awaits `integrationWorktree.prepare()` immediately after construction and before building WorktreeManager, GitCoordinator, verify plans, RunVerifier or Finalizer. A rejection propagates, so the run fails in setup and the finally block runs.

Fallback: when integrationWorktree is null (worktrees disabled, continue mode, or host already on the goal branch), integrationRoot === repoRoot and today's createOrCheckoutBranch behavior is unchanged. It is called with `integrationRoot` as the argument.

Naming rule: variables, parameters and option fields that mean the repository identity (worktree add/remove/prune, branch -D, recovery refs, info/exclude, dep-dir scan and symlink source, remote detection) are named `repoRoot`. Those that mean the tree where the goal branch is checked out (HEAD, merge, diff, log, commit, push, pull, verify, PR, adr writes) are named `integrationRoot`. Do not introduce new fields named `cwd` in these modules. Generic helpers in git.ts and verify.ts keep their positional `cwd` parameter, but call sites pass a variable named repoRoot or integrationRoot.
**Consequences:** Continue mode and shared-tree mode touch the host checkout exactly as they do today, so host_checkout_dirty stays reachable there. Only one condition decides whether a run uses an isolated integration tree. Verify plans are built after the worktree exists, so their absolute workspace cwds point under integrationRoot.
