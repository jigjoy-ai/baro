# ADR-0008: Resume and suspension reuse the existing __run worktree

**Status:** Accepted
**Context:** Within-run suspension recreates story worktrees from the run branch HEAD. A resumed process with the same runId must not recreate or switch __run.
**Decision:** Within a run, resumeFromSuspension reads its base from integrationRoot (ADR-003); nothing else changes.

Across processes, with the same config.runId, IntegrationWorktree.prepare() reuses the registered __run when it is on goalBranch (ADR-001 step 3). Otherwise it recreates __run from the existing goal branch ref without resetting it.

cleanupStaleOnStart is unchanged, only deleting baro-wt/<runId>/* branches, and must not remove __run. Its `worktree prune` in repoRoot only prunes entries whose directories are gone.
**Consequences:** Goal branch history is never rewritten on resume. RunPrepared.baseSha on a reused tree is the current goal HEAD.
