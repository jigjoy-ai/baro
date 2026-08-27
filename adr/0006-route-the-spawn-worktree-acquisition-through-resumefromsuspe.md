# ADR-0006: Route the spawn worktree acquisition through resumeFromSuspension when a resume directive is present

**Status:** Accepted
**Context:** story-factory.ts:957-958 unconditionally calls `create()`, which reads a fresh base and leaves the preserved work unreplayed; S1's `resumeFromSuspension` is the host-owned step that moves the creation SHA under the gate (worktree.ts:441). It returns `ResumeBaseUpdate`, not a path, and always throws on failure (no null, no shared-tree fallback).
**Decision:** In packages/baro-orchestrator/src/market/story-factory.ts replace the single acquisition at ~:957-958 with:
```ts
const wt = this.opts.worktrees
let createdWorktree: string | null = null
if (wt) {
    if (req.resume) {
        try {
            await wt.resumeFromSuspension(
                req.storyId,
                req.resume.preservedBranch ? { restoreFrom: req.resume.preservedBranch } : {},
            )
            createdWorktree = wt.activePath(req.storyId)
        } catch (e) {
            // Host-owned resume is fail-closed: leave createdWorktree null and
            // let the existing requireWorktree guard refuse the spawn.
            createdWorktree = null
        }
    } else {
        createdWorktree = await wt.create(req.storyId)
    }
}
```
The existing lines ~:964-967 (`requireWorktree` → throw `isolated worktree unavailable`; else `storyCwd = createdWorktree ?? this.opts.cwd`) stay exactly as they are. Use the public accessor `wt.activePath(req.storyId)` for the path — do NOT add a method to worktree.ts and do NOT call `create()` after a resume. Log the caught resume error through whatever logger the surrounding code already uses; do not introduce a new one.
**Consequences:** After a legitimate re-base the creation SHA recorded in `baseShas` moves with the resume, so the sealed-merge lineage gate compares against the new base. Fail-closed semantics are preserved: a resume failure yields no worktree, and with `requireWorktree` the spawn refuses exactly as an unavailable `create()` does today. Non-host history changes remain S1's concern and are untouched.
