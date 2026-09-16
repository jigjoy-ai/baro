# ADR-0003: WorktreeManager takes integrationRoot as an explicit option and uses it for every run-branch operation

**Status:** Accepted
**Context:** Story worktrees must branch from the goal branch HEAD in the integration tree, and merge-back must happen there. Changing the positional constructor would break many tests for no benefit.
**Decision:** Signature: `constructor(private readonly repoRoot: string, private readonly gate: GitGate, private readonly runId: string, opts: WorktreeManagerOptions = {})`, with a new `integrationRoot?: string` in WorktreeManagerOptions stored as `private readonly integrationRoot: string` (default `repoRoot`). Production passes `{ integrationRoot, … }` explicitly.

Switch to integrationRoot:
- `rev-parse HEAD` in create() and resumeFromSuspension()
- `git merge --no-ff`, the `-X theirs` retry, `merge --abort`, and `diff --name-only --diff-filter=U` in mergeBack
- both commands in the host-dirty check
- any other HEAD or ancestor read that means the run branch

The `git worktree add -b <branch> <path> <baseSha>` in create() uses the resolved baseSha instead of the literal `HEAD`. It keeps cwd repoRoot, like worktree remove, prune, branch listing and deletion, recovery-ref creation, ensureDepDirsExcluded and depLocations/symlink sources.

Rename the private `hostCheckoutBlocks` to `integrationTreeBlocks`, with unchanged semantics, in integrationRoot. It still throws `WorktreeRefusalError("host_checkout_dirty", …)` and still calls markPreserved.

Story ids: create() and resumeFromSuspension() throw `Error("story id collides with the integration worktree directory")` when sanitize(storyId) === INTEGRATION_WORKTREE_DIRNAME.

cleanupAll: replace `rmSyncQuiet(this.baseDir)` with removing each story directory it created, then deleting baseDir only when it is empty. It must never touch baseDir/__run.
**Consequences:** The invariant name and IntegrationRefused payload are unchanged. With an isolated tree the check fires only if __run itself is dirty; in the fallback modes it still guards the real host checkout. Uncommitted edits in the user's checkout no longer block merges. The suspension-lineage base now comes from the integration tree.
