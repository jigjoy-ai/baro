# ADR-0007: Remove the integration worktree after the finalizer on success, and in the outer finally on failure and abort

**Status:** Accepted
**Context:** cleanupAll runs before finalizer.complete, and the finalizer needs __run. Failures and aborts go through the finally at orchestrate.ts:2058.
**Decision:** Success path: after syncHostCheckout(), `await integrationWorktree?.remove()`.

The outer `finally` (orchestrate.ts:2058) adds `await integrationWorktree?.remove()` after shutdownCollaborationBridge.shutdown() and before the dialogue and goal-review rmSync calls. It is idempotent, so the success path calling it twice is harmless.

The __run worktree is not removed while any story worktree is retained (the retainedLiveWorktrees set is non-empty, or cleanupAll kept a dirty recovery worktree). In that case remove() is skipped and a log line gives the path. To support this:
- WorktreeManager exposes `hasRetainedWorktrees(): boolean`, true when cleanupAll ran with keptDirtyRecovery or retained ids.
- orchestrate passes the result as `integrationWorktree.remove({ keepIfRetained: worktrees?.hasRetainedWorktrees() ?? false })`, which changes the signature to `remove(opts?: { keepIfRetained?: boolean })`.

If construction or prepare() throws before `worktrees` exists, the finally still calls remove().
**Consequences:** The acceptance tests that __run is gone after success and after failure hold. Retained story recovery keeps its base tree inspectable. The test fixture removeWorktreeRun already removes __run because it lists every registered worktree under the run root.
