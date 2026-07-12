/**
 * GitCoordinator — owns the per-story git side effects (worktree merge-back,
 * shared-tree reconcile, pushes, cleanup) and reports them on the bus as
 * StoryMerged / StoryMergeFailed.
 *
 * Legacy mode calls the same operations through hooks. Collective mode
 * performs the lifecycle entirely in response to semantic events.
 */

import {
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import {
    GitGate,
    createOrCheckoutBranch,
    excludeBaroArtifacts,
    getDiff,
    getHeadSha,
    gitPushWithRetry,
    safePullRebase,
} from "../git.js"
import { loadPrd } from "../prd.js"
import {
    RunPreparationFailed,
    RunPreparationRequested,
    RunPrepared,
    RunPushFailed,
    RunPushRequested,
    RunPushed,
    StoryIntegrationRequested,
    StoryMergeFailed,
    StoryMerged,
    WorkLeaseGranted,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupFailed,
    WorkspaceCleanupRequested,
} from "../semantic-events.js"
import { emit } from "../tui-protocol.js"
import type { WorktreeManager } from "../worktree.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface GitCoordinatorOptions {
    cwd: string
    gitGate: GitGate
    worktrees: WorktreeManager | null
    /** Mirror progress/diffs to the TUI protocol. Default: true. */
    emitTui?: boolean
    /** Subscribe to collective lifecycle events instead of direct hooks. */
    eventDriven?: boolean
    runId?: string
    prdPath?: string
    /** Push commits to the configured remote. Default true. */
    push?: boolean
}

interface LeaseCorrelation {
    runId: string
    leaseId: string
}

export class GitCoordinator extends SerializedObserver {
    /** Detached non-worktree pushes, drained by finish() off the critical path. */
    private readonly storyPushes: Promise<void>[] = []
    private worktreePushNeeded = false
    private pushError: string | null = null
    private readonly integrationLeases = new Set<string>()
    private readonly activeLeases = new Map<
        string,
        { leaseId: string; generation: number }
    >()
    private readonly completedCleanups = new Map<string, string | null>()
    private eventAuthority: Participant | null = null
    private leaseAuthority: Participant | null = null

    constructor(private readonly opts: GitCoordinatorOptions) {
        super()
    }

    setEventAuthority(authority: Participant): void {
        if (this.eventAuthority && this.eventAuthority !== authority) {
            throw new Error("git coordinator event authority is already bound")
        }
        this.eventAuthority = authority
    }

    setLeaseAuthority(authority: Participant): void {
        if (this.leaseAuthority && this.leaseAuthority !== authority) {
            throw new Error("git coordinator lease authority is already bound")
        }
        this.leaseAuthority = authority
    }

    protected override async handleEvent(
        context: SerializedEventContext,
    ): Promise<void> {
        if (!this.opts.eventDriven) return
        await this.handleDomainEvent(context)
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        process.stderr.write(`[git-coordinator] ${failure.error.stack ?? failure.error.message}\n`)
    }

    private async handleDomainEvent(context: SerializedEventContext): Promise<void> {
        const { event, source } = context
        const runId = this.opts.runId
        if (!runId) return
        if (WorkLeaseGranted.is(event) && event.data.runId === runId) {
            if (this.leaseAuthority && source !== this.leaseAuthority) return
            this.activeLeases.set(event.data.request.storyId, {
                leaseId: event.data.leaseId,
                generation: event.data.generation,
            })
            return
        }
        if (this.eventAuthority && source !== this.eventAuthority) return
        if (
            RunPreparationRequested.is(event) &&
            event.data.runId === runId
        ) {
            await this.prepareRun(runId)
            return
        }
        if (
            StoryIntegrationRequested.is(event) &&
            event.data.runId === runId
        ) {
            if (this.integrationLeases.has(event.data.leaseId)) return
            this.integrationLeases.add(event.data.leaseId)
            try {
                await this.onStoryPassed(event.data.storyId, {
                    runId: event.data.runId,
                    leaseId: event.data.leaseId,
                })
            } catch (error) {
                this.emitBus(
                    StoryMergeFailed.create({
                        storyId: event.data.storyId,
                        error: (error as Error)?.message ?? String(error),
                        runId: event.data.runId,
                        leaseId: event.data.leaseId,
                    }),
                )
            }
            return
        }
        if (
            WorkspaceCleanupRequested.is(event) &&
            event.data.runId === runId
        ) {
            const active = this.activeLeases.get(event.data.storyId)
            const cleanupResult = {
                runId: event.data.runId,
                cleanupId: event.data.cleanupId,
                storyId: event.data.storyId,
                ...(event.data.leaseId !== undefined
                    ? { leaseId: event.data.leaseId }
                    : {}),
                ...(event.data.generation !== undefined
                    ? { generation: event.data.generation }
                    : {}),
            }
            const stale =
                event.data.leaseId !== undefined &&
                active !== undefined &&
                (active.leaseId !== event.data.leaseId ||
                    active.generation !== event.data.generation)
            if (stale) {
                this.emitBus(
                    WorkspaceCleanupCompleted.create({
                        ...cleanupResult,
                    }),
                )
                return
            }
            if (this.completedCleanups.has(event.data.cleanupId)) {
                const preservedBranch =
                    this.completedCleanups.get(event.data.cleanupId) ?? null
                this.emitBus(
                    WorkspaceCleanupCompleted.create({
                        ...cleanupResult,
                        ...(preservedBranch ? { preservedBranch } : {}),
                    }),
                )
                return
            }
            try {
                const preservedBranch = await this.cleanupFailedStory(
                    event.data.storyId,
                    event.data.preserveForRecovery === true,
                )
                this.completedCleanups.set(event.data.cleanupId, preservedBranch)
                this.emitBus(
                    WorkspaceCleanupCompleted.create({
                        ...cleanupResult,
                        ...(preservedBranch ? { preservedBranch } : {}),
                    }),
                )
            } catch (error) {
                this.emitBus(
                    WorkspaceCleanupFailed.create({
                        ...cleanupResult,
                        ...(this.opts.worktrees
                            ? {
                                  retainedBranch:
                                      this.opts.worktrees.branchName(event.data.storyId),
                              }
                            : {}),
                        error: (error as Error)?.message ?? String(error),
                    }),
                )
            }
            return
        }
        if (RunPushRequested.is(event) && event.data.runId === runId) {
            await this.finish()
            if (this.pushError) {
                this.emitBus(RunPushFailed.create({ runId, error: this.pushError }))
            } else {
                this.emitBus(
                    RunPushed.create({
                        runId,
                        pushed: this.opts.push ?? true,
                    }),
                )
            }
        }
    }

    private async prepareRun(runId: string): Promise<void> {
        try {
            const baseSha = await getHeadSha(this.opts.cwd)
            await excludeBaroArtifacts(this.opts.cwd)
            if (this.opts.prdPath) {
                const prd = loadPrd(this.opts.prdPath)
                if (prd.branchName) {
                    await createOrCheckoutBranch(
                        this.opts.cwd,
                        prd.branchName,
                        (line) => this.log("_git", line),
                        this.opts.push ?? true,
                    )
                }
            }
            await this.opts.worktrees?.cleanupStaleOnStart()
            this.emitBus(RunPrepared.create({ runId, baseSha }))
        } catch (error) {
            this.emitBus(
                RunPreparationFailed.create({
                    runId,
                    error: (error as Error)?.message ?? String(error),
                }),
            )
        }
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

    async onStoryPassed(
        storyId: string,
        correlation?: LeaseCorrelation,
    ): Promise<void> {
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
                const error = (e as Error)?.message ?? String(e)
                let branch = worktrees.branchName(storyId)
                let retryable = false
                let preparationError: string | null = null
                try {
                    // Preserve the rejected attempt under a unique immutable
                    // ref, then release the logical story ref. The Board may
                    // now re-offer the story from the latest integrated HEAD.
                    branch = await worktrees.prepareConflictRetry(storyId)
                    retryable = true
                } catch (prepareError) {
                    preparationError =
                        (prepareError as Error)?.message ?? String(prepareError)
                }
                this.emitBus(
                    StoryMergeFailed.create({
                        storyId,
                        error: preparationError
                            ? `${error}; recovery preparation failed: ${preparationError}`
                            : error,
                        branch,
                        retryable,
                        ...correlation,
                    }),
                )
                log(
                    retryable
                        ? `[git] merge-back failed; attempt preserved at ${branch} and queued for recovery: ${error}`
                        : `[git] merge-back failed; worktree preserved for manual recovery: ${error}`,
                )
                if (emitTui) {
                    emit({ type: "push_status", id: storyId, success: false, error })
                }
                return
            }
            if (merged) {
                this.worktreePushNeeded = true
                // Diff for the TUI Changes view, captured before the worktree
                // is cleaned up.
                if (emitTui && beforeMerge) {
                    try {
                        const d = await getDiff(cwd, beforeMerge, "HEAD")
                        if (d.files.length) {
                            emit({
                                type: "story_diff",
                                id: storyId,
                                files: d.files,
                                diff: d.diff || undefined,
                            })
                        }
                    } catch (error) {
                        log(`[git] could not capture merged diff: ${(error as Error)?.message ?? String(error)}`)
                    }
                }
                try {
                    await worktrees.cleanup(storyId)
                } catch (error) {
                    log(`[git] merged worktree cleanup deferred: ${(error as Error)?.message ?? String(error)}`)
                }
                this.emitBus(
                    StoryMerged.create({ storyId, mode: "worktree", ...correlation }),
                )
                if (emitTui) {
                    emit({ type: "push_status", id: storyId, success: true, error: null })
                }
                return
            }
            if (this.opts.eventDriven) {
                this.emitBus(
                    StoryMergeFailed.create({
                        storyId,
                        error: `isolated worktree state missing for ${storyId}`,
                        ...correlation,
                    }),
                )
                return
            }
            // merged === false → shared-tree fallback; reconcile + push like
            // the non-worktree path below.
        }
        if (this.opts.push ?? true) {
            await safePullRebase(cwd, log, gitGate)
        }
        this.emitBus(
            StoryMerged.create({ storyId, mode: "shared-tree", ...correlation }),
        )
        if (!(this.opts.push ?? true)) return
        this.storyPushes.push(
            (async () => {
                try {
                    await gitPushWithRetry(gitGate, { cwd, onLog: log })
                    if (emitTui) {
                        emit({ type: "push_status", id: storyId, success: true, error: null })
                    }
                } catch (e) {
                    this.pushError = (e as Error)?.message ?? String(e)
                    if (emitTui) {
                        emit({ type: "push_status", id: storyId, success: false, error: (e as Error)?.message ?? String(e) })
                    }
                }
            })(),
        )
    }

    async onStoryFailed(storyId: string): Promise<void> {
        await this.opts.worktrees?.cleanup(storyId)
    }

    private async cleanupFailedStory(
        storyId: string,
        preserveForRecovery: boolean,
    ): Promise<string | null> {
        if (!this.opts.worktrees) return null
        if (preserveForRecovery) {
            return this.opts.worktrees.cleanupFailed(storyId, true)
        }
        await this.opts.worktrees.cleanup(storyId)
        return null
    }

    /**
     * Drain detached pushes and do the single post-run push for all worktree
     * merge-backs. Call after conductor.done, before the Finalizer needs the
     * remote branch complete.
     */
    async finish(): Promise<void> {
        await Promise.allSettled(this.storyPushes)
        if (!(this.opts.push ?? true)) return
        if (!this.worktreePushNeeded) return
        const emitTui = this.opts.emitTui ?? true
        const log = (line: string) => this.log("_git", line)
        try {
            await gitPushWithRetry(this.opts.gitGate, { cwd: this.opts.cwd, onLog: log })
            if (emitTui) emit({ type: "push_status", id: "_git", success: true, error: null })
        } catch (e) {
            this.pushError = (e as Error)?.message ?? String(e)
            if (emitTui) emit({ type: "push_status", id: "_git", success: false, error: (e as Error)?.message ?? String(e) })
        }
    }
}
