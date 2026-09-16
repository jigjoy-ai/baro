# ADR-0006: Fast-forward the host checkout only at the end, only when it is safe, and never fail the run

**Status:** Accepted
**Context:** The user's checkout may only be touched at the very end: fast-forward it when it is clean and on the base branch, otherwise leave it alone. host_checkout_dirty stays as the safety fuse on this path. Event wire names are frozen and no diagnostic event exists, so a new semantic event would widen the contract for no gain.
**Decision:** In integration-worktree.ts:

`export type HostCheckoutSyncResult = { kind: "fast_forwarded"; from: string; to: string } | { kind: "untouched"; reason: "not_on_base_branch" | "host_checkout_dirty" | "not_fast_forward" | "up_to_date" | "not_prepared" | "error"; detail: string }`

`IntegrationWorktree.syncHostCheckout()` holds gitGate and runs in repoRoot:
1. If prepare() never resolved, return not_prepared.
2. If hostBranchAtStart is null or `git branch --show-current` !== hostBranchAtStart, return not_on_base_branch.
3. If `git status --porcelain --untracked-files=no` is non-empty, return host_checkout_dirty. The detail lists the paths and the fuse is non-retryable, so no retry and no branch deletion.
4. goalSha = `git rev-parse refs/heads/<goalBranch>`. If HEAD === goalSha, return up_to_date.
5. If `git merge-base --is-ancestor HEAD <goalSha>` fails, return not_fast_forward.
6. Run `git merge --ff-only <goalSha>` and return fast_forwarded.

Any thrown error, timeouts included, is caught and returned as `error`. The method never throws.

It emits exactly one log line through onLog, prefixed `[integration] host checkout `, for example `[integration] host checkout fast-forwarded <branch> <from>..<to>` or `[integration] host checkout left untouched (<reason>): <detail>`. orchestrate wires onLog to `emitTui && emit({ type: "story_log", id: "_git", line })` plus process.stderr. No new semantic event is added.

In orchestrate.ts, call `await integrationWorktree?.syncHostCheckout()` right after `if (finalizer) await finalizer.complete()` (around line 2001) on the normal completion path, whatever summary.success is. It is not called on thrown or aborted paths.
**Consequences:** The host fast-forward is best-effort: a dirty checkout, one on another branch, or one that has diverged is left alone. The goal branch and PR are the source of truth. In fallback mode (integrationWorktree null) nothing is synced, because the host is already on the goal branch.
