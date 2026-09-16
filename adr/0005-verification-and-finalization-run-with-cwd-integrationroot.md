# ADR-0005: Verification and finalization run with cwd = integrationRoot

**Status:** Accepted
**Context:** RunVerifier, the continuous gate plan and Finalizer are all built from config.cwd today. Their verify plans store absolute command cwds, so a plan built on repoRoot would run commands in the user's checkout.
**Decision:** Finalizer:
- FinalizerOptions renames `cwd` to `integrationRoot: string`. All uses of this.opts.cwd become this.opts.integrationRoot. That covers getHeadSha, log, diff, rev-list, merge --ff-only, `join(integrationRoot, "adr")`, add, commit, branch --show-current, gh repo view, symbolic-ref, push, gh pr create, and createVerifyPlan/verifyBuild.
- orchestrate.ts:1207 passes `integrationRoot`.

RunVerifier and ContinuousGateRunner keep their option names (`cwd`, `resolveTarget`):
- orchestrate.ts:1321 builds `createVerifyPlan(integrationRoot)`.
- 1324 passes `cwd: integrationRoot`.
- The createFinalPlan callback keeps its parameter.
- The continuous gate keeps `plan: verifyPlan` (now rooted at integrationRoot) and resolveCriticRepositoryTarget.

verify.ts and declared-verification.ts need no code change beyond what call sites pass.

Other git reads in orchestrate.ts that inspect the run branch use integrationRoot. That includes the post-run totalCommits, filesCreated and filesModified computation after line 2003, and any getHeadSha or getDiff on the goal branch. hasRemoteOrigin and isInsideGitRepo keep using repoRoot.
**Consequences:** The PR, push and adr commit happen from __run. Existing finalizer tests must switch `cwd:` to `integrationRoot:`. The absolute-cwd behavior of the continuous gate inside story worktrees is unchanged and out of scope.
