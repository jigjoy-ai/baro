/** Runtime DAG mutations: legacy Replan and transactional runtime replans. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

export interface ReplanStoryAdd {
    id: string
    priority: number
    title: string
    description: string
    dependsOn: readonly string[]
    retries?: number
    acceptance?: readonly string[]
    tests?: readonly string[]
    model?: string
    /** Goal-contract invariants for which this story must produce evidence. */
    goalInvariantIds?: readonly string[]
}

export interface ReplanData {
    source: string
    reason: string
    addedStories: readonly ReplanStoryAdd[]
    removedStoryIds: readonly string[]
    /** `Record<storyId, dependsOn>` — flat object, not `Map`, for JSON. */
    modifiedDeps: Readonly<Record<string, readonly string[]>>
    /** Present for a Surgeon replan so a Board can reject stale/aborted
     * recovery output without guessing from the proposed graph mutation. */
    recovery?: {
        runId?: string
        storyId: string
        leaseId?: string
        generation?: number
    }
}

export const Replan = defineSemanticEvent<ReplanData>("replan")

/**
 * Legacy Conductor acknowledgement emitted only after a buffered Replan has
 * passed policy checks and been persisted. Raw Replan remains a proposal;
 * observers that project operator-visible state must consume this event.
 */
export const ReplanApplied =
    defineSemanticEvent<ReplanData>("replan_applied")

/**
 * A leased story's structured proposal to mutate the not-yet-started portion
 * of the collective DAG. This is deliberately separate from `Replan`: that
 * older event is the Surgeon/Conductor recovery contract, while runtime
 * proposals require optimistic graph-version and lease correlation.
 */
export interface RuntimeReplanMutation {
    addedStories: readonly ReplanStoryAdd[]
    removedStoryIds: readonly string[]
    /** `Record<storyId, dependsOn>` — flat and replay-safe on the event bus. */
    modifiedDeps: Readonly<Record<string, readonly string[]>>
}

export interface RuntimeReplanCorrelationData {
    runId: string
    proposalId: string
    sourceStoryId: string
    leaseId: string
    generation: number
    /** Optimistic-concurrency version observed when the agent proposed. */
    baseGraphVersion: number
}

export interface RuntimeReplanProposedData
    extends RuntimeReplanCorrelationData {
    reason: string
    mutation: RuntimeReplanMutation
}

export const RuntimeReplanProposed =
    defineSemanticEvent<RuntimeReplanProposedData>("runtime_replan_proposed")

export interface RuntimeReplanAppliedData
    extends RuntimeReplanCorrelationData {
    previousGraphVersion: number
    /** Decision version at which this mutation committed. */
    graphVersion: number
    /** Latest known version when this decision is delivered/replayed. */
    currentGraphVersion?: number
    reason: string
    mutation: RuntimeReplanMutation
}

export const RuntimeReplanApplied =
    defineSemanticEvent<RuntimeReplanAppliedData>("runtime_replan_applied")

/** Stable machine-readable rejection reasons; human detail stays in `reason`. */
export type RuntimeReplanRejectionCode =
    | "invalid_proposal"
    | "unauthorized"
    | "inactive_source"
    | "stale_graph_version"
    | "proposal_id_conflict"
    | "no_op"
    | "dynamic_story_limit"
    | "adaptation_budget_exhausted"
    | "offer_retraction_failed"
    | "immutable_story"
    | "unknown_story"
    | "duplicate_story"
    | "unknown_dependency"
    | "duplicate_dependency"
    | "self_dependency"
    | "dependency_cycle"
    | "destructive_removal"
    | "persistence_failed"
    | "prompt_projection_overflow"
    | "run_not_active"

export interface RuntimeReplanRejectedData
    extends RuntimeReplanCorrelationData {
    currentGraphVersion: number
    code: RuntimeReplanRejectionCode
    reason: string
}

export const RuntimeReplanRejected =
    defineSemanticEvent<RuntimeReplanRejectedData>("runtime_replan_rejected")
