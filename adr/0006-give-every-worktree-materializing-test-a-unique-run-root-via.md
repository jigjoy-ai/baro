# ADR-0006: Give every worktree-materializing test a unique run root via one shared fixture helper

**Status:** Accepted
**Context:** `WorktreeManager` derives its base directory from the run id (worktree.ts:147), so a fixed run id is a fixed path. worktree.test.ts:766 (`"run-nolink"`) and repository-command.test.ts:249 (`"run-timeout"`) use fixed ids, and the counter-based ids in worktree.test.ts:52 / worktree-suspension-lineage.test.ts:73 collide across concurrent node processes and lanes. Production `WorktreeManager` is not modified — the fix belongs in the fixtures.
**Decision:** Create `packages/baro-orchestrator/test/integration/worktree-fixture.ts` (not a `*.test.ts`, so the suite glob ignores it) as the SINGLE owner of worktree fixture paths. Exports:
- `export function uniqueRunId(prefix: string): string` ⇒ `` `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}` `` using `node:crypto`.
- `export function worktreeRunRoot(runId: string): string` ⇒ `join(tmpdir(), "baro-worktrees", runId)`.
- `export async function removeWorktreeRun(repoDir: string | null, runId: string): Promise<void>` ⇒ best-effort, never throws: `git worktree remove --force` per entry when `repoDir` is given, then `rmSync(worktreeRunRoot(runId), { recursive: true, force: true })`, then `git worktree prune` and `git branch -D baro-wt/<runId>/*` swallowing errors.

Migrations (no other behaviour changes):
- `test/integration/worktree.test.ts`: replace the `run-test-${seq++}` id (:52) with `uniqueRunId("run-test")`; replace the literal `"run-nolink"` (:766) with `uniqueRunId("run-nolink")` and wrap the `create`/assert/`cleanupAll` block (:770-772) in `try { … } finally { await noLink.cleanupAll(); await removeWorktreeRun(repo, noLinkRunId); }`.
- `test/integration/worktree-suspension-lineage.test.ts`: replace `run-resume-test-${seq++}` (:73) with `uniqueRunId("run-resume-test")`; keep the existing `afterEach`.
- `test/integration/repository-command.test.ts`: replace the literal `"run-timeout"` (:249) with `uniqueRunId("run-timeout")` and add `await removeWorktreeRun(repo, runId)` to the existing `finally` (:315-324).
- `test/dependency-suspension-orchestrate.test.ts`: build its ids (:131, :219) with `uniqueRunId("dependency-timeout")` / `uniqueRunId("terminal-uncertified")` imported from `./integration/worktree-fixture.js`; keep its existing try/finally cleanup but let the final `rmSync` call `removeWorktreeRun`.
- No new test may hardcode a run id or join `tmpdir()/baro-worktrees/...` itself; string-only fixtures that never touch disk (git-coordinator.test.ts, merge-awareness-runner.test.ts, story-factory-resume.test.ts, staged-dependency-link.test.ts, finalizer.test.ts) are out of scope and stay as they are.
**Consequences:** No test can inherit another's filesystem state, and a failing assertion cannot leave a fixed-path directory or `baro-wt/<fixed-id>/*` branch behind. Cleanup is idempotent and swallows errors so it can safely run in `finally` after a partial create (including `rollbackPartialCreate` paths). `WorktreeManager`'s constructor and `baseDir` derivation stay untouched.
