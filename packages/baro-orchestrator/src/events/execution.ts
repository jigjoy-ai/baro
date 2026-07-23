/** Story execution lifecycle: runs, levels, spawns, results, discovery, recovery. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"
import type { CoordinationMode } from "./market.js"
import type { RunVerificationEvidence, RunVerificationStatus } from "./verification.js"

// Orchestration control events

export interface RunStartRequestData {
    reason: string
}

export const RunStartRequest =
    defineSemanticEvent<RunStartRequestData>("run_start_request")

export interface StorySpawnFailedData {
    runId: string
    offerId?: string
    leaseId?: string
    storyId: string
    error: string
    failure?: StoryFailureData
}

export const StorySpawnFailed =
    defineSemanticEvent<StorySpawnFailedData>("story_spawn_failed")

export interface DiscoveredWork {
    id: string
    title: string
    description: string
    dependsOn: readonly string[]
    acceptance: readonly string[]
    tests: readonly string[]
    model?: string
    priority?: number
    retries?: number
    /** Goal-contract invariants for which the discovered work produces evidence. */
    goalInvariantIds?: readonly string[]
}

export interface WorkDiscoveredData {
    runId: string
    sourceAgentId: string
    /** Exact lease that produced the discovery. Retained bridge attribution
     * alone is insufficient because the same story may already be on a newer
     * generation when an authenticated request or durable compatibility
     * record is consumed. */
    leaseId: string
    generation: number
    reason: string
    story: DiscoveredWork
}

export const WorkDiscovered =
    defineSemanticEvent<WorkDiscoveredData>("work_discovered")

/**
 * A leased worker has discovered that its story cannot make honest progress
 * until already-planned prerequisite work integrates. This is a cooperative
 * suspension request, not a terminal execution failure. The Board validates
 * the dependency mutation and remains the only authority that may accept it.
 */
export interface WorkBlockedData {
    runId: string
    blockId: string
    storyId: string
    leaseId: string
    generation: number
    requiredStoryIds: readonly string[]
    reason: string
}

export const WorkBlocked =
    defineSemanticEvent<WorkBlockedData>("work_blocked")

export interface WorkBlockAcceptedData extends WorkBlockedData {
    /** Durable graph version that already contains the dependency rewire. */
    graphVersion: number
}

export const WorkBlockAccepted =
    defineSemanticEvent<WorkBlockAcceptedData>("work_block_accepted")

export type WorkBlockRejectionCode =
    | "invalid_request"
    | "run_not_active"
    | "stale_lease"
    | "already_settled"
    | "unknown_dependency"
    | "dependency_already_satisfied"
    | "dependency_cycle"

export interface WorkBlockRejectedData
    extends Omit<WorkBlockedData, "reason"> {
    /** Original worker rationale, kept separate from the policy rejection. */
    requestReason: string
    code: WorkBlockRejectionCode
    reason: string
}

export const WorkBlockRejected =
    defineSemanticEvent<WorkBlockRejectedData>("work_block_rejected")

/** Exact worker-side acknowledgement that retries stopped and the complete
 * process/tool tree is quiescent. Broker may release a dependency-blocked
 * lease only after this event matches the accepted block correlation. */
export interface WorkSuspendedData {
    runId: string
    blockId: string
    storyId: string
    leaseId: string
    generation: number
    attempts: number
    durationSecs: number
}

export const WorkSuspended =
    defineSemanticEvent<WorkSuspendedData>("work_suspended")

export interface RecoveryEvaluationStartedData {
    runId: string
    storyId: string
    source: string
}

export const RecoveryEvaluationStarted =
    defineSemanticEvent<RecoveryEvaluationStartedData>("recovery_evaluation_started")

export interface RecoveryDecisionData {
    runId: string
    storyId: string
    source: string
    action: "replan" | "abort"
    reason: string
}

export const RecoveryDecision =
    defineSemanticEvent<RecoveryDecisionData>("recovery_decision")

export interface RunStartedData {
    project: string
    storyCount: number
    /** Current durable runtime-DAG version. Optional for legacy/replay
     * compatibility; collective control participants should provide it. */
    graphVersion?: number
    /** Full logical run set; optional for replay compatibility. */
    storyIds?: readonly string[]
    /** Stories already passed before this resume/continue run began. */
    completedStoryIds?: readonly string[]
    /** Determines whether progress requires authoritative repository merge. */
    coordinationMode?: CoordinationMode
    /** Execution mode from the intake contract ("focused" | "sequential" | "parallel"), when one was decided. */
    mode?: string
}

export const RunStarted = defineSemanticEvent<RunStartedData>("run_started")

export interface LevelComputeRequestData {
    reason: string
}

export const LevelComputeRequest =
    defineSemanticEvent<LevelComputeRequestData>("level_compute_request")

export interface LevelStartedData {
    ordinal: number
    totalLevelsHint: number
    storyIds: readonly string[]
}

export const LevelStarted = defineSemanticEvent<LevelStartedData>("level_started")

export interface LevelCompletedData {
    ordinal: number
    passed: readonly string[]
    failed: readonly string[]
    /** Cooperative suspensions are neither passes nor execution failures. */
    blocked?: readonly string[]
}

export const LevelCompleted =
    defineSemanticEvent<LevelCompletedData>("level_completed")

/**
 * Conductor actually started a recovery level (visibility only; the
 * recovery flow itself stays hook-driven). `attempt` counts recovery
 * levels started in this run, 1-based.
 */
export interface RecoveryStartedData {
    attempt: number
    storyIds: readonly string[]
}

export const RecoveryStarted =
    defineSemanticEvent<RecoveryStartedData>("recovery_started")

/**
 * Unlike the old toJSON() (which logged only `promptLen`), the wire format
 * carries the full prompt — StoryFactory needs it, and audit-log
 * round-tripping is worth the size for replay/debug.
 */
export interface StorySpawnRequestData {
    storyId: string
    prompt: string
    model: string
    retries: number
    timeoutSecs: number
    /** A bounded retry launched after a previous execution or repository
     * integration failure. Recovery starts from the latest run branch and can
     * inspect an immutable backup whenever the failed attempt changed files. */
    recovery?: {
        kind:
            | "execution"
            | "integration"
            | "transport"
            | "infrastructure"
            | "verification"
            | "dependency"
        reason: string
        branch?: string
    }
    offerId?: string
    runId?: string
    leaseId?: string
    generation?: number
    /** DAG version from which this concrete story launch was scheduled. */
    graphVersion?: number
    /** Keep a continuation-capable worker alive until the authoritative
     * Critic has reviewed its exact terminal turn. */
    requiresQualityReview?: boolean
    workerId?: string
}

export const StorySpawnRequest =
    defineSemanticEvent<StorySpawnRequestData>("story_spawn_request")

export interface StorySpawnedData {
    storyId: string
}

export const StorySpawned = defineSemanticEvent<StorySpawnedData>("story_spawned")

/**
 * Which backend + model a story was routed to (machine-readable twin of
 * StoryFactory's `[story-factory] S1 → backend:model` stderr line).
 */
export interface StoryRoutedData {
    storyId: string
    backend: string
    model: string
    /** Collective-only authority correlation; legacy routing omits it. */
    runId?: string
    leaseId?: string
    generation?: number
}

export const StoryRouted = defineSemanticEvent<StoryRoutedData>("story_routed")

export interface RunCompletedData {
    success: boolean
    completedStories: readonly string[]
    failedStories: readonly string[]
    totalDurationSecs: number
    totalAttempts: number
    abortReason: string | null
    /** Collective runs set this after their objective pre-completion gate. */
    verificationStatus?: RunVerificationStatus
    /** Correlated evidence used to decide the collective run outcome. */
    verification?: RunVerificationEvidence
    runId?: string
}

export const RunCompleted = defineSemanticEvent<RunCompletedData>("run_completed")

export interface ConductorStateData {
    phase: "loading" | "running_level" | "level_complete" | "done" | "failed"
    detail?: string
    currentLevel?: number
    totalLevels?: number
    storyIds?: readonly string[]
}

export const ConductorState =
    defineSemanticEvent<ConductorStateData>("conductor_state")

/** Terminal lane, not recovery policy. Producers classify what happened;
 * Board/Broker policy decides whether to retry, reroute, reverify, or ask a
 * coding agent to repair work. */
export type StoryFailureKind =
    | "execution"
    | "provider_capacity"
    | "transport"
    | "infrastructure"
    | "verification"

export type ProviderCapacityCode =
    | "session_limit"
    | "quota_exhausted"
    | "rate_limited"
    | "overloaded"
    | "capacity_unavailable"

export type TransportFailureCode =
    | "request_timeout"
    | "connection_failed"
    | "connection_reset"
    | "dns_failed"
    | "tls_failed"
    | "network_unavailable"

export type InfrastructureFailureCode =
    | "review_timeout"
    | "review_uncorrelated"
    | "sandbox_denied"
    | "tool_unavailable"
    | "command_timeout"
    | "process_spawn_failed"
    | "process_quiescence_uncertified"
    | "worktree_unavailable"
    | "decision_unknown"
    | "authentication_failed"

export type ExecutionFailureCode =
    | "model_error"
    | "quality_rejected"
    | "turn_limit"
    | "no_work_product"

export type VerificationFailureCode =
    | "acceptance_not_met"
    | "canonical_check_failed"
    | "evidence_missing"
    | "evidence_stale"
    | "evaluator_unavailable"

export type StoryFailureCode =
    | ProviderCapacityCode
    | TransportFailureCode
    | InfrastructureFailureCode
    | ExecutionFailureCode
    | VerificationFailureCode

/** Backend-neutral terminal failure classification. Human diagnostics remain
 * in `error`; this bounded structure is what deterministic recovery policy
 * consumes. Old audit logs omit it and retain the historical execution path. */
export interface StoryFailureData {
    kind: StoryFailureKind
    code?: StoryFailureCode
    retryAfterMs?: number
}

export interface StoryResultData {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    error: string | null
    failure?: StoryFailureData
    runId?: string
    leaseId?: string
    generation?: number
    /** Neutral terminal result produced while quiescing an accepted
     * dependency suspension. It must not be interpreted as work failure. */
    suspension?: {
        kind: "dependency"
        blockId: string
    }
}

export const StoryResult = defineSemanticEvent<StoryResultData>("story_result")

/**
 * A participant (Supervisor today) requests intervention on a RUNNING story.
 * StoryFactory consumes "abort": the story settles as a failed StoryResult,
 * which the Surgeon can then split/escalate.
 */
export interface StoryInterventionData {
    storyId: string
    source: string
    action: "abort"
    reason: string
    /** Collective-only active execution capability. The display-only
     * `source` string is never authority. */
    runId?: string
    leaseId?: string
    generation?: number
}

export const StoryIntervention =
    defineSemanticEvent<StoryInterventionData>("story_intervention")
