/**
 * GitCoordinator — owns the per-story git side effects (worktree merge-back,
 * shared-tree reconcile, pushes, cleanup) and reports them on the bus as
 * StoryMerged / StoryMergeFailed.
 *
 * The Conductor still AWAITS onStoryPassed on its critical path — the next
 * DAG level must see this story's commits before dependents spawn — so the
 * work itself stays hook-driven; the bus gets the record of what happened.
 */

import { BaseObserver, type SemanticEvent } from "@mozaik-ai/core"

import {
    GitGate,
    getDiff,
    getHeadSha,
    gitPushWithRetry,
    safePullRebase,
} from "../git.js"
import { StoryMergeFailed, StoryMerged } from "../semantic-events.js"
import { emit } from "../tui-protocol.js"
import type { WorktreeManager } from "../worktree.js"

export interface GitCoordinatorOptions {
    cwd: string
    gitGate: GitGate
    worktrees: WorktreeManager | null
    /** Mirror progress/diffs to the TUI protocol. Default: true. */
    emitTui?: boolean
}

export class GitCoordinator extends BaseObserver {
    /** Detached non-worktree pushes, drained by finish() off the critical path. */
    private readonly storyPushes: Promise<void>[] = []
    private worktreePushNeeded = false

    constructor(private readonly opts: GitCoordinatorOptions) {
        super()
    }

    private emitBus(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }

    private log(storyId: string, line: string): void {
        if (this.opts.emitTui ?? true) {
            emit({ type: "story_log", id: storyId, line })
        }
    }

    async onStoryPassed(storyId: string): Promise<void> {
        const emitTui = this.opts.emitTui ?? true
        const { cwd, worktrees, gitGate } = this.opts
        const log = (line: string) => this.log(storyId, line)
        // Run-branch HEAD before this story merges, so we can diff exactly
        // what the story added once merge-back lands.
        const beforeMerge = emitTui ? await getHeadSha(cwd) : null
        // Merge-back happens on the critical path (fast, local) so the next
        // DAG level sees it. mergeBack returns false when the story had no
        // worktree — that story still needs the shared-tree reconciliation
        // below.
        if (worktrees) {
            let merged = false
            try {
                merged = await worktrees.mergeBack(storyId)
            } catch (e) {
                // Unresolvable merge: keep the worktree + branch so the
                // passed work can be recovered, don't push/clean.
                const error = (e as Error)?.message ?? String(e)
                this.emitBus(StoryMergeFailed.create({ storyId, error }))
                log(`[git] merge-back failed; worktree preserved for recovery: ${error}`)
                if (emitTui) {
                    emit({ type: "push_status", id: storyId, success: false, error })
                }
                return
            }
            if (merged) {
                this.emitBus(StoryMerged.create({ storyId, mode: "worktree" }))
                // Diff for the TUI Changes view, captured before the worktree
                // is cleaned up.
                if (emitTui && beforeMerge) {
                    const d = await getDiff(cwd, beforeMerge, "HEAD")
                    if (d.files.length) {
                        emit({
                            type: "story_diff",
                            id: storyId,
                            files: d.files,
                            diff: d.diff || undefined,
                        })
                    }
                }
                // Push happens once in finish() so this critical-path hook
                // never waits on the network.
                await worktrees.cleanup(storyId)
                this.worktreePushNeeded = true
                if (emitTui) {
                    emit({ type: "push_status", id: storyId, success: true, error: null })
                }
                return
            }
            // merged === false → shared-tree fallback; reconcile + push like
            // the non-worktree path below.
        }
        await safePullRebase(cwd, log, gitGate)
        this.emitBus(StoryMerged.create({ storyId, mode: "shared-tree" }))
        this.storyPushes.push(
            (async () => {
                try {
                    await gitPushWithRetry(gitGate, { cwd, onLog: log })
                    if (emitTui) {
                        emit({ type: "push_status", id: storyId, success: true, error: null })
                    }
                } catch (e) {
                    if (emitTui) {
                        emit({ type: "push_status", id: storyId, success: false, error: (e as Error)?.message ?? String(e) })
                    }
                }
            })(),
        )
    }

    onStoryFailed(storyId: string): void {
        void this.opts.worktrees?.cleanup(storyId)
    }

    /**
     * Drain detached pushes and do the single post-run push for all worktree
     * merge-backs. Call after conductor.done, before the Finalizer needs the
     * remote branch complete.
     */
    async finish(): Promise<void> {
        await Promise.allSettled(this.storyPushes)
        if (!this.worktreePushNeeded) return
        const emitTui = this.opts.emitTui ?? true
        const log = (line: string) => this.log("_git", line)
        try {
            await gitPushWithRetry(this.opts.gitGate, { cwd: this.opts.cwd, onLog: log })
            if (emitTui) emit({ type: "push_status", id: "_git", success: true, error: null })
        } catch (e) {
            if (emitTui) emit({ type: "push_status", id: "_git", success: false, error: (e as Error)?.message ?? String(e) })
        }
    }
}
