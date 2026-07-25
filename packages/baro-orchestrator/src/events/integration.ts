/** Repository integration: prepare, merge, cleanup, push, PR. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

export interface RunPreparationRequestedData {
    runId: string
}

export const RunPreparationRequested =
    defineSemanticEvent<RunPreparationRequestedData>("run_preparation_requested")

export interface RunPreparedData {
    runId: string
    baseSha: string | null
}

export const RunPrepared = defineSemanticEvent<RunPreparedData>("run_prepared")

export interface RunPreparationFailedData {
    runId: string
    error: string
}

export const RunPreparationFailed =
    defineSemanticEvent<RunPreparationFailedData>("run_preparation_failed")

export interface StoryIntegrationRequestedData {
    runId: string
    leaseId: string
    storyId: string
    attempts: number
    durationSecs: number
    /** True only for a Critic-evaluated story candidate. Stories with no
     * acceptance criteria deliberately do not require a repository seal. */
    candidateFingerprintRequired?: boolean
    /** Changed-content fingerprint accepted by Critic for this exact lease. */
    candidateFingerprint?: string
}

export const StoryIntegrationRequested =
    defineSemanticEvent<StoryIntegrationRequestedData>("story_integration_requested")

export interface WorkspaceCleanupRequestedData {
    runId: string
    cleanupId: string
    storyId: string
    leaseId?: string
    generation?: number
    /** Preserve meaningful dirty or committed partial work before releasing
     * the failed story's worktree, for automatic or later manual recovery. */
    preserveForRecovery?: boolean
}

export const WorkspaceCleanupRequested =
    defineSemanticEvent<WorkspaceCleanupRequestedData>("workspace_cleanup_requested")

export interface WorkspaceCleanupCompletedData {
    runId: string
    cleanupId: string
    storyId: string
    leaseId?: string
    generation?: number
    /** Unique immutable ref containing the meaningful failed attempt. */
    preservedBranch?: string
}

export const WorkspaceCleanupCompleted =
    defineSemanticEvent<WorkspaceCleanupCompletedData>("workspace_cleanup_completed")

export interface WorkspaceCleanupFailedData {
    runId: string
    cleanupId: string
    storyId: string
    leaseId?: string
    generation?: number
    /** The logical branch/worktree was retained; it is not safe to start a
     * fresh execution for the same story until a human resolves this error. */
    retainedBranch?: string
    error: string
}

export const WorkspaceCleanupFailed =
    defineSemanticEvent<WorkspaceCleanupFailedData>("workspace_cleanup_failed")

export interface RunPushRequestedData {
    runId: string
}

export const RunPushRequested =
    defineSemanticEvent<RunPushRequestedData>("run_push_requested")

export interface RunPushedData {
    runId: string
    pushed: boolean
}

export const RunPushed = defineSemanticEvent<RunPushedData>("run_pushed")

export interface RunPushFailedData {
    runId: string
    error: string
}

export const RunPushFailed = defineSemanticEvent<RunPushFailedData>("run_push_failed")

export interface FinalizeStartedData {
    branch: string
}

export const FinalizeStarted =
    defineSemanticEvent<FinalizeStartedData>("finalize_started")

export interface PrCreatedData {
    url: string | null
    branch: string
    baseBranch: string
}

export const PrCreated = defineSemanticEvent<PrCreatedData>("pr_created")

/** A passed story's work landed on the run branch (worktree merge-back or shared-tree reconcile). */
export interface StoryMergedData {
    storyId: string
    mode: "worktree" | "shared-tree"
    runId?: string
    leaseId?: string
}

export const StoryMerged = defineSemanticEvent<StoryMergedData>("story_merged")

/** Merge-back failed; the story's work is preserved for inspection/recovery. */
export interface StoryMergeFailedData {
    storyId: string
    error: string
    /** The preserved branch holding the story's un-merged commits, so the
     *  finalizer can recover the work into a PR instead of stranding it. */
    branch?: string
    /** True only when repository preparation produced a safe immutable backup
     * and the same logical story may be re-offered from the latest run HEAD. */
    retryable?: boolean
    runId?: string
    leaseId?: string
}

export const StoryMergeFailed =
    defineSemanticEvent<StoryMergeFailedData>("story_merge_failed")
