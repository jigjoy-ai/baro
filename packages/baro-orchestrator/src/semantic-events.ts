/**
 * SemanticEvent definitions for every baro orchestrator bus event.
 *
 * CONSTRAINT: each event's wire `type` string must stay identical to the
 * pre-migration BusEvent `toJSON().type` — audit-log readers (mozaik-replay
 * legacy adapter, baro's older replay tooling) match on those names.
 * Migration history and per-event wire-format deltas: docs/semantic-events.md.
 *
 * Type discriminators, not `instanceof`: class instances don't survive JSON
 * round-trips (audit log → reload, WebSocket → reload); a `type` check does.
 */

import { SemanticEvent } from "@mozaik-ai/core"

import type { WorkBidEstimate } from "./work-market.js"

import type { ModelInvocationMeasuredData } from "./model-telemetry.js"
import type {
    GoalAggregateReviewBasis,
    GoalAggregateReviewEvidence,
} from "./runtime/goal-aggregate-review.js"

import type { ConversationResponse } from "./session/conversation-contract.js"
import type { ConversationRequestIntent } from "./session/conversation-intake.js"
import type { RepositoryBriefV1 } from "./session/repository-brief.js"

/**
 * One event "kind": wire type string + typed `create()` factory + `is()`
 * type guard — class-event ergonomics without a JS class identity.
 */
export function defineSemanticEvent<TData>(type: string) {
    return {
        type,
        create: (data: TData): SemanticEvent<TData> => {
            // Mozaik delivers the same event object synchronously to every
            // subscriber, while several Baro participants defer decisions to
            // an async mailbox. Snapshot and freeze at the producer boundary
            // so an earlier subscriber cannot rewrite what a later authority
            // observes, and callers cannot mutate an event after publishing it.
            const snapshot = deepFreezeSemanticData(structuredClone(data))
            return Object.freeze(new SemanticEvent<TData>(type, snapshot))
        },
        is: (event: SemanticEvent<unknown>): event is SemanticEvent<TData> =>
            event.type === type,
    } as const
}

function deepFreezeSemanticData<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || typeof value !== "object") return value
    const object = value as object
    if (seen.has(object)) return value
    seen.add(object)

    // Semantic payloads are wire values (plain records/arrays plus primitive
    // leaves). Reflective traversal also safely freezes structured-cloned Date,
    // Map and Set wrappers should a diagnostic payload contain one.
    if (value instanceof Map) {
        for (const [key, item] of value) {
            deepFreezeSemanticData(key, seen)
            deepFreezeSemanticData(item, seen)
        }
    } else if (value instanceof Set) {
        for (const item of value) deepFreezeSemanticData(item, seen)
    }
    for (const key of Reflect.ownKeys(object)) {
        deepFreezeSemanticData(
            (object as Record<PropertyKey, unknown>)[key],
            seen,
        )
    }
    return Object.freeze(value)
}

// Bus routing

export interface KnowledgeData {
    /** Source agent that produced the underlying tool call. */
    sourceAgentId: string
    /** Free-form tags for relevance matching (e.g. file path, pattern). */
    tags: readonly string[]
    /** Short headline (e.g. "package.json read", "grep 'authToken'"). */
    summary: string
    /** Full content (file body, command output, etc). */
    content: string
    /** Tool that produced it ("Read" | "Grep" | "Bash" | "Glob" …). */
    tool: string
}
export const Knowledge = defineSemanticEvent<KnowledgeData>("knowledge")

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

// Progressive planning is an opt-in collective control-plane lane. Planner
// fragments are proposals until the Board validates and durably admits them;
// merely publishing one never grants execution authority.

export interface PlanningStreamOpenedData {
    runId: string
    planningId: string
}
export const PlanningStreamOpened =
    defineSemanticEvent<PlanningStreamOpenedData>("planning_stream_opened")

export interface PlanFragmentProposedData {
    runId: string
    planningId: string
    fragmentId: string
    /** One-based, gap-free position in the planner stream. */
    ordinal: number
    /** Add-only stories. Every dependency must already exist or be present
     * in this same fragment before the Board may admit it. */
    stories: readonly unknown[]
}
export const PlanFragmentProposed =
    defineSemanticEvent<PlanFragmentProposedData>("plan_fragment_proposed")

export interface PlanFragmentAdmittedData {
    runId: string
    planningId: string
    fragmentId: string
    ordinal: number
    graphVersion: number
    storyIds: readonly string[]
    replay: boolean
}
export const PlanFragmentAdmitted =
    defineSemanticEvent<PlanFragmentAdmittedData>("plan_fragment_admitted")

export type PlanFragmentRejectionCode =
    | "invalid_fragment"
    | "unauthorized"
    | "planning_not_open"
    | "planning_id_mismatch"
    | "ordinal_gap"
    | "fragment_id_conflict"
    | "final_plan_mismatch"
    | "graph_rejected"

export interface PlanFragmentRejectedData {
    runId: string
    planningId: string
    fragmentId?: string
    ordinal?: number
    code: PlanFragmentRejectionCode
    reason: string
}
export const PlanFragmentRejected =
    defineSemanticEvent<PlanFragmentRejectedData>("plan_fragment_rejected")

export interface PlanningStreamCompletedData {
    runId: string
    planningId: string
    /** Kept provider-neutral at the bus boundary; the Board normalizes it
     * through the canonical PRD loader before reconciliation. */
    finalPrd: unknown
}
export const PlanningStreamCompleted =
    defineSemanticEvent<PlanningStreamCompletedData>("planning_stream_completed")

export interface PlanningStreamFailedData {
    runId: string
    planningId: string
    code: string
    reason: string
}
export const PlanningStreamFailed =
    defineSemanticEvent<PlanningStreamFailedData>("planning_stream_failed")

export interface PlanningStreamClosedData {
    runId: string
    planningId: string
    status: "completed" | "failed"
    graphVersion: number
    reason?: string
}
export const PlanningStreamClosed =
    defineSemanticEvent<PlanningStreamClosedData>("planning_stream_closed")

export interface CoordinationData {
    fromAgentId: string
    recipientId: string
    kind: "wait" | "merge" | "abort" | "notice"
    reason: string
    payload: Readonly<Record<string, unknown>>
}
export const Coordination = defineSemanticEvent<CoordinationData>("coordination")

export interface AgentTargetedMessageData {
    recipientId: string
    text: string
    metadata: Readonly<Record<string, unknown>>
    /** Present together only on a CollaborationBridge-authenticated
     * collective delivery. Uncorrelated events remain legacy-compatible
     * message intents and carry no execution authority. */
    runId?: string
    leaseId?: string
    generation?: number
}
export const AgentTargetedMessage =
    defineSemanticEvent<AgentTargetedMessageData>("agent_targeted_message")

// Optional conversation participant. It may observe and communicate, but
// these events deliberately carry no lease, integration, verification, or
// completion authority.

export interface ConversationRequestedData {
    runId: string
    messageId: string
    text: string
    source: "user" | "operator"
}
export const ConversationRequested =
    defineSemanticEvent<ConversationRequestedData>("conversation_requested")

export interface ConversationAction {
    kind: "message"
    recipientId: string
    text: string
}

/** Narrow implementation scope a conversational participant may propose.
 * Scheduling priority, retry policy and model/route selection are deliberately
 * absent: those remain Board and worker-market decisions. */
export interface ConversationDelegatedStory {
    id: string
    title: string
    description: string
    dependsOn: readonly string[]
    acceptance: readonly string[]
    tests: readonly string[]
    goalInvariantIds?: readonly string[]
}

/** Advisory, add-only work proposal from the exact bound DialogueAgent.
 * The Board remains the sole graph authority and must validate this against
 * the correlated graph version before it can become runnable work. */
export interface ConversationDelegationProposedData {
    runId: string
    messageId: string
    proposalId: string
    agentId: string
    baseGraphVersion: number
    reason: string
    addedStories: readonly ConversationDelegatedStory[]
}
export const ConversationDelegationProposed =
    defineSemanticEvent<ConversationDelegationProposedData>(
        "conversation_delegation_proposed",
    )

export interface ConversationRespondedData {
    runId: string
    messageId: string
    agentId: string
    text: string
    actions: readonly ConversationAction[]
}
export const ConversationResponded =
    defineSemanticEvent<ConversationRespondedData>("conversation_responded")

export interface ConversationFailedData {
    runId: string
    messageId: string
    agentId: string
    error: string
}
export const ConversationFailed =
    defineSemanticEvent<ConversationFailedData>("conversation_failed")

// Short-lived, pre-PRD conversation lane. These events intentionally carry no
// cwd, model, route, worker, DAG, lease, or execution authority. Exact source
// participant identity is enforced by the front-door participants.

export interface FrontDoorConversationRequestedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    intent: ConversationRequestIntent
    text: string
}
export const FrontDoorConversationRequested =
    defineSemanticEvent<FrontDoorConversationRequestedData>(
        "frontdoor_conversation_requested",
    )

export interface RepositoryContextRequestedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    intent: Exclude<ConversationRequestIntent, "chat">
    query: string
}
export const RepositoryContextRequested =
    defineSemanticEvent<RepositoryContextRequestedData>(
        "repository_context_requested",
    )

export interface RepositoryContextProvidedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    scoutId: string
    brief: RepositoryBriefV1
}
export const RepositoryContextProvided =
    defineSemanticEvent<RepositoryContextProvidedData>(
        "repository_context_provided",
    )

export type RepositoryContextFailureCode =
    | "timeout"
    | "scan_failed"
    | "invalid_brief"
    | "request_conflict"

export interface RepositoryContextFailedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    scoutId: string
    code: RepositoryContextFailureCode
    error: string
}
export const RepositoryContextFailed =
    defineSemanticEvent<RepositoryContextFailedData>(
        "repository_context_failed",
    )

export interface FrontDoorConversationCompletedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    response: ConversationResponse
}
export const FrontDoorConversationCompleted =
    defineSemanticEvent<FrontDoorConversationCompletedData>(
        "frontdoor_conversation_completed",
    )

export interface FrontDoorConversationFailedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    error: string
}
export const FrontDoorConversationFailed =
    defineSemanticEvent<FrontDoorConversationFailedData>(
        "frontdoor_conversation_failed",
    )

// Agent lifecycle

export type AgentPhase =
    | "idle"
    | "starting"
    | "running"
    | "waiting"
    | "done"
    | "failed"
    | "aborted"

export interface AgentStateData {
    agentId: string
    phase: AgentPhase
    detail?: string
}
export const AgentState = defineSemanticEvent<AgentStateData>("agent_state")

// Claude CLI passthrough types

export interface AgentUserMessageData {
    agentId: string
    text: string
}
export const AgentUserMessage =
    defineSemanticEvent<AgentUserMessageData>("agent_user_message")

export interface ClaudeSystemData {
    agentId: string
    subtype: string
    raw: Readonly<Record<string, unknown>>
}
export const ClaudeSystem = defineSemanticEvent<ClaudeSystemData>("claude_system")

/**
 * Claude `result` event (one per agent turn). Wire type stays
 * `claude_result` for audit-log compatibility; `raw` is deliberately
 * excluded (the old toJSON() already dropped it).
 */
export interface AgentResultData {
    agentId: string
    /** Producer-issued replay identity for this exact terminal turn. */
    terminalId?: string
    subtype: string
    sessionId: string | null
    isError: boolean
    resultText: string | null
    usage: Readonly<Record<string, unknown>> | null
    totalCostUsd: number | null
    numTurns: number | null
    durationMs: number | null
}
export const AgentResult = defineSemanticEvent<AgentResultData>("claude_result")

/** Terminal assistant text from a backend-neutral story turn. */
export interface AgentTurnCompletedData {
    agentId: string
    /** Producer-issued replay identity for this exact projected terminal turn. */
    terminalId?: string
    backend: string
    isError: boolean
    resultText: string | null
    /** False for one-shot CLIs that cannot consume Critic feedback in-process. */
    canContinue: boolean
}
export const AgentTurnCompleted =
    defineSemanticEvent<AgentTurnCompletedData>("agent_turn_completed")

/**
 * Authenticated boundary emitted by a one-shot story participant only after
 * its provider process has settled. The terminal projector uses it to keep
 * Critic evidence capture behind process-tree quiescence.
 */
export interface OneShotAttemptFinalizedData {
    runId: string
    storyId: string
    leaseId: string
    generation: number
    /** Monotonic invocation number within this lease generation. */
    attempt: number
    disposition: "publish" | "discard"
    ownedProcessGroup: boolean
    /** POSIX group + identity-table observation, not full OS containment. */
    quiescenceAssurance: "cooperative-observed" | "none"
}
export const OneShotAttemptFinalized =
    defineSemanticEvent<OneShotAttemptFinalizedData>(
        "one_shot_attempt_finalized",
    )

/** Backend-neutral, replay-safe usage/cost observation for one model call. */
export const ModelInvocationMeasured =
    defineSemanticEvent<ModelInvocationMeasuredData>("model_invocation_measured")

export interface ClaudeStreamChunkData {
    agentId: string
    raw: Readonly<Record<string, unknown>>
}
export const ClaudeStreamChunk =
    defineSemanticEvent<ClaudeStreamChunkData>("claude_stream_chunk")

export interface ClaudeRateLimitData {
    agentId: string
    raw: Readonly<Record<string, unknown>>
}
export const ClaudeRateLimit =
    defineSemanticEvent<ClaudeRateLimitData>("claude_rate_limit")

// Codex CLI passthrough types — see docs/stream-protocols.md ("Codex").

export interface CodexSystemData {
    agentId: string
    /** "thread.started" | "thread.completed" | "error" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}
export const CodexSystem = defineSemanticEvent<CodexSystemData>("codex_system")

export interface CodexTurnEventData {
    agentId: string
    /** "started" | "completed" | "failed" */
    phase: string
    raw: Readonly<Record<string, unknown>>
}
export const CodexTurnEvent =
    defineSemanticEvent<CodexTurnEventData>("codex_turn_event")

export interface CodexItemEventData {
    agentId: string
    /** e.g. "agent_message", "reasoning", "command_execution",
     *  "file_change", "mcp_tool_call", "web_search", "plan_update". */
    itemType: string
    raw: Readonly<Record<string, unknown>>
}
export const CodexItemEvent =
    defineSemanticEvent<CodexItemEventData>("codex_item_event")

export interface CodexUnknownEventData {
    agentId: string
    codexType: string
    raw: Readonly<Record<string, unknown>>
}
export const CodexUnknownEvent =
    defineSemanticEvent<CodexUnknownEventData>("codex_unknown_event")

/**
 * Verdict from the Critic. Historic wire JSON used snake_case keys to
 * match the Rust TUI; the interface is camelCase — no in-process consumer
 * reads snake_case, so any mapping happens at the audit-log boundary.
 */
export interface CritiqueData {
    agentId: string
    /** Exact producer-issued terminal turn this verdict evaluates. Optional
     * only for replay compatibility with audit logs written before the
     * continuation handshake existed. */
    terminalId?: string
    /** `inconclusive` means the evaluator/protocol failed; it is never
     * evidence that the candidate code is wrong. Missing means `evaluated`
     * for replay compatibility. */
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: readonly string[]
    turn: number
    modelUsed: string
    /** Exact changed-content fingerprint bracketed around the complete Critic
     * evidence capture. Present only when that live repository snapshot stayed
     * stable; collective integration rechecks it immediately before merge. */
    repositoryFingerprint?: string
}
export const Critique = defineSemanticEvent<CritiqueData>("critique")

export interface StoryQualityCritiqueSnapshot {
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: readonly string[]
    turn: number
    modelUsed: string
    /** Stable repository identity carried from the authoritative Critic. */
    repositoryFingerprint?: string
}

export interface StoryQualityCompletedData {
    runId: string
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    status: "passed" | "failed" | "inconclusive"
    /** Null only when no acceptance criteria exist or no terminal turn arrived. */
    targetTurn: number | null
    reason: string
    critique?: StoryQualityCritiqueSnapshot
}
export const StoryQualityCompleted =
    defineSemanticEvent<StoryQualityCompletedData>("story_quality_completed")

/**
 * AcceptanceGate asks the neutral terminal projector to present the exact
 * same candidate to Critic again after an operationally inconclusive verdict.
 * The lease/worktree remain active; this event never authorizes execution or
 * a new WorkOffer.
 */
export interface StoryQualityReverificationRequestedData {
    runId: string
    requestId: string
    /** Evaluation superseded by this bounded recheck. */
    previousEvaluationId: string
    /** Evaluation id that will settle from the replayed terminal turn. */
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    /** Critic/AcceptanceGate turn containing the original candidate. */
    targetTurn: number
    /** Stable producer identity when the original stream supplied one. */
    terminalId?: string
    /** One-based recheck count for this unchanged candidate. */
    attempt: number
    reason: string
}
export const StoryQualityReverificationRequested =
    defineSemanticEvent<StoryQualityReverificationRequestedData>(
        "story_quality_reverification_requested",
    )

/** Gate-owned semantic timer tick for a missing terminal turn or critique. */
export interface StoryQualityTimedOutData {
    runId: string
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    targetTurn: number | null
    timeoutMs: number
}
export const StoryQualityTimedOut =
    defineSemanticEvent<StoryQualityTimedOutData>("story_quality_timed_out")

export interface ClaudeUnknownEventData {
    agentId: string
    claudeType: string
    raw: Readonly<Record<string, unknown>>
}
export const ClaudeUnknownEvent =
    defineSemanticEvent<ClaudeUnknownEventData>("claude_unknown_event")

// Orchestration control events

export interface RunStartRequestData {
    reason: string
}
export const RunStartRequest =
    defineSemanticEvent<RunStartRequestData>("run_start_request")

export type CoordinationMode = "legacy" | "collective"

export interface CoordinationModeSelectedData {
    runId: string
    mode: CoordinationMode
}
export const CoordinationModeSelected =
    defineSemanticEvent<CoordinationModeSelectedData>("coordination_mode_selected")

export interface WorkerCapabilities {
    backends: readonly string[]
    supportsAbort: boolean
    supportsLiveFeedback: boolean
    supportsPeerMessages: boolean
    /** Concrete credential-free routes this worker may bid. */
    routes?: readonly WorkRouteDescriptor[]
    /** Optional per-worker execution capacity advertised to the broker. */
    maxConcurrent?: number
}

export interface WorkerCapabilityAdvertisedData {
    runId: string
    workerId: string
    capabilities: WorkerCapabilities
}
export const WorkerCapabilityAdvertised =
    defineSemanticEvent<WorkerCapabilityAdvertisedData>("worker_capability_advertised")

export interface WorkOfferedData {
    runId: string
    offerId: string
    generation: number
    priority: number
    /** Credential-free routes that must not execute this attempt. The Board
     * only adds routes proven unavailable by an authoritative prior lease. */
    excludedRouteIds?: readonly string[]
    request: StorySpawnRequestData
}
export const WorkOffered = defineSemanticEvent<WorkOfferedData>("work_offered")

/** Board-to-Broker cancellation handshake for an offer that a runtime graph
 * mutation wants to retract. The Broker serializes this request against bid,
 * claim and lease decisions; the graph may change only after its resolution. */
export interface WorkOfferRetractionRequestedData {
    runId: string
    proposalId: string
    retractionId: string
    offerId: string
    storyId: string
    generation: number
    graphVersion: number
}
export const WorkOfferRetractionRequested =
    defineSemanticEvent<WorkOfferRetractionRequestedData>(
        "work_offer_retraction_requested",
    )

type WorkOfferRetractionResolutionCorrelation =
    WorkOfferRetractionRequestedData

export type WorkOfferRetractionResolvedData =
    | (WorkOfferRetractionResolutionCorrelation & {
          disposition: "retracted"
      })
    | (WorkOfferRetractionResolutionCorrelation & {
          disposition: "leased"
          leaseId: string
          workerId: string
      })
export const WorkOfferRetractionResolved =
    defineSemanticEvent<WorkOfferRetractionResolvedData>(
        "work_offer_retraction_resolved",
    )

/** Safe-to-audit route identity. Provider credentials never enter the bus. */
export interface WorkRouteDescriptor {
    routeId: string
    backend: string
    model: string
}

export interface WorkBidEstimateData extends WorkBidEstimate {
    estimateSource: "configured" | "historical"
}

export interface WorkBidData {
    runId: string
    offerId: string
    storyId: string
    generation: number
    bidId: string
    workerId: string
    route: WorkRouteDescriptor
    estimate: WorkBidEstimateData
    /** This concrete route/executor can stop retries and prove process/tool
     * quiescence before its worktree is snapshotted. */
    supportsCooperativeSuspend?: boolean
}
export const WorkBid = defineSemanticEvent<WorkBidData>("work_bid")

/** Event-sourced, credential-free route learning. It is advisory input to
 * later auctions, never execution or completion authority. */
export interface RouteEstimateUpdatedData {
    runId: string
    workerId: string
    route: WorkRouteDescriptor
    verifiedSuccesses: number
    workFailures: number
    observations: number
    estimate: WorkBidEstimateData
}
export const RouteEstimateUpdated =
    defineSemanticEvent<RouteEstimateUpdatedData>("route_estimate_updated")

/** Broker-owned semantic timer tick that closes one bounded bid window. */
export interface WorkBidWindowClosedData {
    runId: string
    offerId: string
    storyId: string
    generation: number
}
export const WorkBidWindowClosed =
    defineSemanticEvent<WorkBidWindowClosedData>("work_bid_window_closed")

export interface WorkClaimedData {
    runId: string
    offerId: string
    storyId: string
    workerId: string
    backend: string
    model: string
    bidId?: string
    route?: WorkRouteDescriptor
    supportsCooperativeSuspend?: boolean
}
export const WorkClaimed = defineSemanticEvent<WorkClaimedData>("work_claimed")

export interface WorkLeaseGrantedData {
    runId: string
    offerId: string
    leaseId: string
    workerId: string
    generation: number
    request: StorySpawnRequestData
    bidId?: string
    route?: WorkRouteDescriptor
    supportsCooperativeSuspend?: boolean
}
export const WorkLeaseGranted =
    defineSemanticEvent<WorkLeaseGrantedData>("work_lease_granted")

export interface WorkLeaseReleasedData {
    runId: string
    offerId: string
    leaseId: string
    storyId: string
    workerId: string
    reason: "integrated" | "execution_failed" | "operational_failed" | "quality_failed" | "quality_inconclusive" | "integration_failed" | "spawn_failed" | "dependency_blocked" | "aborted" | "expired"
    /** Present for a cooperative dependency suspension so retry/cost metrics
     * remain lossless even though no terminal execution result is settled. */
    attempts?: number
    durationSecs?: number
}
export const WorkLeaseReleased =
    defineSemanticEvent<WorkLeaseReleasedData>("work_lease_released")

export interface WorkLeaseExpiredData {
    runId: string
    offerId: string
    leaseId: string
    storyId: string
    workerId: string
    reason: string
}
export const WorkLeaseExpired =
    defineSemanticEvent<WorkLeaseExpiredData>("work_lease_expired")

export interface WorkOfferExpiredData {
    runId: string
    offerId: string
    storyId: string
    reason: string
}
export const WorkOfferExpired =
    defineSemanticEvent<WorkOfferExpiredData>("work_offer_expired")

export interface WorkContextRequestedData {
    runId: string
    requestId: string
    storyId: string
    hints: readonly string[]
}
export const WorkContextRequested =
    defineSemanticEvent<WorkContextRequestedData>("work_context_requested")

export interface WorkContextProvidedData {
    runId: string
    requestId: string
    storyId: string
    context: string | null
}
export const WorkContextProvided =
    defineSemanticEvent<WorkContextProvidedData>("work_context_provided")

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

export interface PeerHelpRequestedData {
    runId: string
    sourceAgentId: string
    text: string
}
export const PeerHelpRequested =
    defineSemanticEvent<PeerHelpRequestedData>("peer_help_requested")

export interface CollaborationNoteData {
    runId: string
    sourceAgentId: string
    text: string
}
export const CollaborationNote =
    defineSemanticEvent<CollaborationNoteData>("collaboration_note")

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

export type RunVerificationStatus = "passed" | "failed" | "skipped"
export type VerificationCommandStatus = "passed" | "failed" | "skipped"

export interface VerificationCommandEvidence {
    command: string
    status: VerificationCommandStatus
    durationMs: number
    /** Tail of stderr/stdout for failed commands, or a skip explanation. */
    tail?: string
}

/** The coordinator has integrated all candidate work and requests an objective gate. */
export interface RunVerificationRequestedData {
    runId: string
    verificationId: string
}
export const RunVerificationRequested =
    defineSemanticEvent<RunVerificationRequestedData>("run_verification_requested")

/** The coordinator's verification deadline elapsed; active work must cancel. */
export interface RunVerificationTimedOutData {
    runId: string
    verificationId: string
    timeoutMs: number
}
export const RunVerificationTimedOut =
    defineSemanticEvent<RunVerificationTimedOutData>("run_verification_timed_out")

export interface RunVerificationEvidence {
    verificationId: string
    status: RunVerificationStatus
    commands: readonly VerificationCommandEvidence[]
    durationMs: number
}

/** Objective build/test evidence for the fully integrated run branch. */
export interface RunVerificationCompletedData extends RunVerificationEvidence {
    runId: string
}
export const RunVerificationCompleted =
    defineSemanticEvent<RunVerificationCompletedData>("run_verification_completed")

// Goal-contract governance

/**
 * The coordinator's accepted story-to-goal coverage declaration.  This is a
 * projection input, not proof that the story has been integrated or reviewed.
 */
export interface GoalStoryInvariantMappedData {
    runId: string
    mappingId: string
    storyId: string
    invariantIds: readonly string[]
}
export const GoalStoryInvariantMapped =
    defineSemanticEvent<GoalStoryInvariantMappedData>(
        "goal_story_invariant_mapped",
    )

/** Any joined collective participant may fail closed by challenging a goal invariant. */
export interface GoalInvariantChallengeRaisedData {
    runId: string
    challengeId: string
    invariantId: string
    raisedBy: string
    reason: string
    storyId?: string
}
export const GoalInvariantChallengeRaised =
    defineSemanticEvent<GoalInvariantChallengeRaisedData>(
        "goal_invariant_challenge_raised",
    )

/** Only the bound goal-governance authority may settle a challenge. */
export interface GoalInvariantChallengeResolvedData {
    runId: string
    challengeId: string
    /** `resolved` clears the challenge; `rejected` records an upheld failure. */
    resolution: "resolved" | "rejected"
    reason: string
}
export const GoalInvariantChallengeResolved =
    defineSemanticEvent<GoalInvariantChallengeResolvedData>(
        "goal_invariant_challenge_resolved",
    )

/** Guardian-authored add-only work proposal for an unresolved invariant. */
export interface GoalInvariantRemediationProposedData {
    runId: string
    contractId: string
    /** Canonical first target retained for legacy consumers. */
    challengeId: string
    /** Complete root-cause group. Missing means the legacy singleton above. */
    challengeIds?: readonly string[]
    /** Canonical first target retained for legacy consumers. */
    invariantId: string
    /** Complete invariant target set. Missing means the legacy singleton above. */
    invariantIds?: readonly string[]
    /** Reviewer-derived root-cause identity, when aggregate review grouped it. */
    remediationGroupId?: string
    proposalId: string
    reason: string
    story: ReplanStoryAdd
}
export const GoalInvariantRemediationProposed =
    defineSemanticEvent<GoalInvariantRemediationProposedData>(
        "goal_invariant_remediation_proposed",
    )

/** Board's durable graph admission receipt for Guardian remediation work. */
export interface GoalInvariantRemediationAdmittedData {
    runId: string
    contractId: string
    /** Canonical first target retained for legacy consumers. */
    challengeId: string
    /** Atomically admitted challenge set; missing means legacy singleton. */
    challengeIds?: readonly string[]
    /** Canonical first target retained for legacy consumers. */
    invariantId: string
    /** Exact story target set; missing means legacy singleton. */
    invariantIds?: readonly string[]
    remediationGroupId?: string
    proposalId: string
    storyId: string
    graphVersion: number
    disposition: "applied" | "existing"
}
export const GoalInvariantRemediationAdmitted =
    defineSemanticEvent<GoalInvariantRemediationAdmittedData>(
        "goal_invariant_remediation_admitted",
    )

/**
 * Guardian-owned complete ledger snapshot.  The coordinator may persist this
 * projection, but cannot manufacture or edit its semantic contents.
 */
export interface GoalLedgerProjectionUpdatedData {
    runId: string
    contractId: string
    revision: number
    projection: import("./runtime/goal-contract.js").GoalLedgerProjection
}
export const GoalLedgerProjectionUpdated =
    defineSemanticEvent<GoalLedgerProjectionUpdatedData>(
        "goal_ledger_projection_updated",
    )

/**
 * Board-authored receipt emitted only after the exact Guardian projection has
 * crossed the atomic PRD persistence boundary. Consumers may use this to
 * retire durable transport records; ProjectionUpdated alone is not an ack.
 */
export interface GoalLedgerProjectionPersistedData
    extends GoalLedgerProjectionUpdatedData {}
export const GoalLedgerProjectionPersisted =
    defineSemanticEvent<GoalLedgerProjectionPersistedData>(
        "goal_ledger_projection_persisted",
    )

/**
 * Authority-bound request to attest the event-projected goal ledger.  The
 * caller supplies the exact integrated story set so removed/stale work cannot
 * satisfy a later DAG projection.
 */
export interface GoalCompletionCheckRequestedData {
    runId: string
    checkId: string
    contractId: string | null
    storyIds: readonly string[]
    verificationId: string
}
export const GoalCompletionCheckRequested =
    defineSemanticEvent<GoalCompletionCheckRequestedData>(
        "goal_completion_check_requested",
    )

/** Guardian-authored request for one semantic review of the exact run basis. */
export interface GoalAggregateReviewRequestedData {
    runId: string
    reviewId: string
    checkId: string
    goalRevision: number
    basis: GoalAggregateReviewBasis
}
export const GoalAggregateReviewRequested =
    defineSemanticEvent<GoalAggregateReviewRequestedData>(
        "goal_aggregate_review_requested",
    )

/** Read-only review evidence correlated to the immutable requested basis. */
export interface GoalAggregateReviewCompletedData
    extends GoalAggregateReviewEvidence {
    runId: string
    checkId: string
    contractId: string
    goalRevision: number
}
export const GoalAggregateReviewCompleted =
    defineSemanticEvent<GoalAggregateReviewCompletedData>(
        "goal_aggregate_review_completed",
    )

export type GoalInvariantAttestationStatus =
    | "satisfied"
    | "open"
    | "rejected"

export interface GoalInvariantAttestationEvidence {
    invariantId: string
    status: GoalInvariantAttestationStatus
    mappedStoryIds: readonly string[]
    integratedStoryIds: readonly string[]
    independentlyReviewedStoryIds: readonly string[]
    aggregateReviewId?: string
    aggregateReviewStatus?: import("./runtime/goal-aggregate-review.js").GoalAggregateReviewStatus
    reason: string
}

/** GoalGuardian's correlated, replay-safe completion decision. */
export interface GoalCompletionAttestedData {
    runId: string
    checkId: string
    contractId: string | null
    /** Exact Guardian projection revision from which this decision was derived. */
    goalRevision: number | null
    verificationId: string
    status: "satisfied" | "incomplete" | "disabled"
    satisfiedInvariantIds: readonly string[]
    openInvariantIds: readonly string[]
    rejectedInvariantIds: readonly string[]
    invariants: readonly GoalInvariantAttestationEvidence[]
    reason: string
}
export const GoalCompletionAttested =
    defineSemanticEvent<GoalCompletionAttestedData>(
        "goal_completion_attested",
    )

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

// OpenCode CLI passthrough types — see docs/stream-protocols.md ("OpenCode").

export interface OpenCodeSystemData {
    agentId: string
    /** "step_start" | "step_finish" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}
export const OpenCodeSystem = defineSemanticEvent<OpenCodeSystemData>("opencode_system")

export interface OpenCodeStepEventData {
    agentId: string
    /** "text" | "tool_call" | "tool_result" */
    stepType: string
    raw: Readonly<Record<string, unknown>>
}
export const OpenCodeStepEvent =
    defineSemanticEvent<OpenCodeStepEventData>("opencode_step_event")

export interface OpenCodeUnknownEventData {
    agentId: string
    openCodeType: string
    raw: Readonly<Record<string, unknown>>
}
export const OpenCodeUnknownEvent =
    defineSemanticEvent<OpenCodeUnknownEventData>("opencode_unknown_event")

// Pi CLI passthrough types — see docs/stream-protocols.md ("Pi").

export interface PiSystemData {
    agentId: string
    /** "session" | "agent_start" | "turn_start" | "agent_end" */
    subtype: string
    raw: Readonly<Record<string, unknown>>
}
export const PiSystem = defineSemanticEvent<PiSystemData>("pi_system")

export interface PiTurnEventData {
    agentId: string
    /** "message_start" | "message_end" | "turn_end" */
    turnType: string
    raw: Readonly<Record<string, unknown>>
}
export const PiTurnEvent = defineSemanticEvent<PiTurnEventData>("pi_turn_event")

export interface PiItemEventData {
    agentId: string
    /** "text" | "thinking" | "tool_call" | "tool_start" | "tool_update" | "tool_result" */
    itemType: string
    raw: Readonly<Record<string, unknown>>
}
export const PiItemEvent = defineSemanticEvent<PiItemEventData>("pi_item_event")

export interface PiUnknownEventData {
    agentId: string
    piType: string
    raw: Readonly<Record<string, unknown>>
}
export const PiUnknownEvent =
    defineSemanticEvent<PiUnknownEventData>("pi_unknown_event")
