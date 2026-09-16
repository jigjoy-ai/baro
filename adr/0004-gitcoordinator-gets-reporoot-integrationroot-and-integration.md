# ADR-0004: GitCoordinator gets repoRoot, integrationRoot and integrationWorktree options and prepares the run through the integration worktree

**Status:** Accepted
**Context:** prepareRun currently checks out the goal branch in the host checkout, and every HEAD, diff and push uses opts.cwd.
**Decision:** GitCoordinatorOptions: remove `cwd` and add `repoRoot: string`, `integrationRoot: string` and `integrationWorktree: IntegrationWorktree | null`. Keep the other fields.

prepareRun(runId):
1. `excludeBaroArtifacts(this.opts.repoRoot)`.
2. If integrationWorktree is set, `await integrationWorktree.prepare()` (the memoized promise). Otherwise, if prdPath is set, call the existing `createOrCheckoutBranch(this.opts.integrationRoot, …)`.
3. `getHeadSha(this.opts.integrationRoot)`, then cleanupStaleOnStart, then emit RunPrepared as today. Any rejection keeps emitting RunPreparationFailed as today.

Every other use of opts.cwd (getHeadSha before and after merge, mergeCommitShaField, getDiff, safePullRebase, both gitPushWithRetry calls) becomes `this.opts.integrationRoot`. Local variables named `cwd` in the class are renamed `integrationRoot`.

In legacy mode, orchestrate.ts onRunStart (1260-1273) follows the same rule:
- excludeBaroArtifacts(repoRoot)
- `integrationWorktree ? await integrationWorktree.prepare() : createOrCheckoutBranch(integrationRoot, …)`
- baseSha = getHeadSha(integrationRoot)

When integrationWorktree is non-null, WorktreeManager gets `allowSharedFallback: coordinationMode === "legacy" && integrationWorktree === null`, so a failed story worktree cannot fall back to committing in the user's checkout.
**Consequences:** The non-retryable handling of host_checkout_dirty (git-coordinator.ts:457-518) is unchanged: no prepareConflictRetry and no branch deletion. Event wire names and payloads are unchanged.
