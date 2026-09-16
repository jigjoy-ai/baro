# ADR-0001: Own the integration worktree in a new module src/integration/integration-worktree.ts

**Status:** Accepted
**Context:** The goal needs a per-run worktree at tmpdir/baro-worktrees/<runId>/__run, reuse on resume, idempotent removal, and a final host sync. Putting all of this in WorktreeManager would mix run-level and story-level lifecycles. worktree.ts is already about 1500 lines.
**Decision:** New file packages/baro-orchestrator/src/integration/integration-worktree.ts exports:
- `export const INTEGRATION_WORKTREE_DIRNAME = "__run"`
- `export function integrationWorktreePath(runId: string): string` returns join(tmpdir(), "baro-worktrees", runId, INTEGRATION_WORKTREE_DIRNAME). This is the only place the path is built.
- `export interface IntegrationWorktreeOptions { repoRoot: string; gitGate: GitGate; runId: string; goalBranch: string; push: boolean; onLog?: (line: string) => void }`
- `export interface IntegrationWorktreePrepared { integrationRoot: string; baseSha: string; reused: boolean; hostBranchAtStart: string | null; hostHeadAtStart: string }`
- `export class IntegrationWorktree`:
  - `constructor(opts: IntegrationWorktreeOptions)`
  - `readonly integrationRoot: string` (equals integrationWorktreePath(runId))
  - `prepare(): Promise<IntegrationWorktreePrepared>`. It is memoized, so every call returns the same promise.
  - `remove(): Promise<void>`. It is idempotent and never throws; errors are only logged.
  - `syncHostCheckout(): Promise<HostCheckoutSyncResult>` (see ADR-006).
- goalBranch is normalized with a new export `normalizeGoalBranchName(name: string): string` in src/integration/git.ts. It is extracted from the `baro/baro/` stripping at git.ts:144-146, and createOrCheckoutBranch must use it too.

prepare() does the following while holding gitGate:
1. `git worktree prune` in repoRoot.
2. Record hostBranchAtStart (`git branch --show-current`; empty means null) and hostHeadAtStart (`git rev-parse HEAD`), both in repoRoot.
3. If `git worktree list --porcelain` in repoRoot shows integrationRoot registered and `git branch --show-current` in integrationRoot equals goalBranch, reuse it (reused=true).
   Otherwise, if the path exists or is registered, run `git worktree remove --force <path>` and prune.
   Then, if refs/heads/<goalBranch> exists (`git show-ref --verify --quiet`), run `git worktree add <integrationRoot> <goalBranch>`. If it does not, run `git worktree add -b <goalBranch> <integrationRoot> <hostHeadAtStart>`. Both run in repoRoot.
4. When push is true, push the goal branch from integrationRoot the same way createOrCheckoutBranch pushes today (git.ts:161-163). If needed, extract that step into an exported helper in git.ts; do not duplicate it.
5. baseSha = `git rev-parse HEAD` in integrationRoot.

remove() runs `git worktree remove --force <integrationRoot>` then `git worktree prune`, both in repoRoot, and then deletes tmpdir/baro-worktrees/<runId> only when that directory is empty. It never deletes the goal branch.
**Consequences:** The goal branch ref keeps every merged commit, so force-removing __run cannot lose integrated work. prepare() never runs checkout in repoRoot. Tests import integrationWorktreePath rather than rebuilding the path.
