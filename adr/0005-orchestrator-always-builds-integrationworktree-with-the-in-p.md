# ADR-0005: Orchestrator always builds IntegrationWorktree, with the in-place escape only for continue runs

**Status:** Accepted
**Context:** The gate at orchestrate.ts:825 is `useGit && worktreesEnabled && goalBranch && hostBranch !== goalBranch`. Also, orchestrate.ts:717-726 overwrites prd.branchName with the host branch in continue mode, which would make it 'main' when a follow-up starts from base.
**Decision:** In packages/baro-orchestrator/src/orchestrate.ts:

1. Continue block at 717-726: overwrite prd.branchName only when the current branch is non-null, starts with "baro/", and differs from normalizeGoalBranchName(prd.branchName). Otherwise keep prd.branchName.

2. Replace the gate with:
```ts
const hostOnGoalBranch = hostBranch !== null && normalizeGoalBranchName(hostBranch) === goalBranch
const integrateInPlace = Boolean(config.continueRun) && hostOnGoalBranch
if (useGit && worktreesEnabled && goalBranch && !integrateInPlace) {
  if (hostOnGoalBranch) throw new Error(`goal branch ${goalBranch} is checked out in ${repoRoot}; switch the checkout back to its base branch or run with --continue`)
  // existing construction + await prepare()
}
```
Use the effective continue flag the file already computes (config.continueRun or BARO_CONTINUE=1, :808). Update the comment at 814-815 to one line.

Nothing else in the non-worktree path changes.
**Consequences:** On a plain run, IntegrationWorktree.prepare() records hostBranchAtStart as the base branch and checks out the goal branch that Rust created (the 'branch exists' case) in tmpdir/baro-worktrees/<runId>/__run. Stories merge there, verification, the finalizer and the push run there, and syncHostCheckout fast-forwards the host at the end only if it is clean and on its start branch. integration-worktree.ts needs no logic changes.
