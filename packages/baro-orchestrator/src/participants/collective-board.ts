import type { Participant, SemanticEvent } from "@mozaik-ai/core"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { buildDag } from "../dag.js"
import {
    deriveGoalContract,
    normalizeGoalLedgerProjection,
    renderGoalContractPrompt,
} from "../runtime/goal-contract.js"
import {
    buildDefaultStoryPrompt,
    loadPrd,
    markStoryPassed,
    savePrdAtomic,
    type PrdCollectiveProtocolState,
    type PrdFile,
    type PrdStory,
} from "../prd.js"
import {
    defineSemanticEvent,
    ConductorState,
    ConversationDelegationProposed,
    CoordinationModeSelected,
    GoalCompletionAttested,
    GoalCompletionCheckRequested,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    GoalLedgerProjectionPersisted,
    GoalLedgerProjectionUpdated,
    GoalStoryInvariantMapped,
    LevelCompleted,
    LevelStarted,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    RecoveryStarted,
    Replan,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    RunCompleted,
    RunPreparationFailed,
    RunPreparationRequested,
    RunPrepared,
    RunPushFailed,
    RunPushRequested,
    RunPushed,
    RunStartRequest,
    RunStarted,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntegrationRequested,
    StoryMergeFailed,
    StoryMerged,
    StoryQualityCompleted,
    StoryResult,
    StorySpawnFailed,
    WorkBlockAccepted,
    WorkBlocked,
    WorkBlockRejected,
    WorkLeaseGranted,
    WorkLeaseExpired,
    WorkLeaseReleased,
    WorkDiscovered,
    WorkContextProvided,
    WorkContextRequested,
    WorkOfferExpired,
    WorkOfferRetractionRequested,
    WorkOfferRetractionResolved,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupFailed,
    WorkspaceCleanupRequested,
    type ReplanData,
    type GoalCompletionAttestedData,
    type GoalInvariantRemediationProposedData,
    type GoalLedgerProjectionUpdatedData,
    type RuntimeReplanRejectionCode,
    type RuntimeReplanMutation,
    type RuntimeReplanProposedData,
    type RunVerificationCompletedData,
    type RunVerificationEvidence,
    type StoryFailureData,
    type StoryQualityCompletedData,
    type StoryResultData,
    type WorkDiscoveredData,
    type WorkBlockedData,
    type WorkBlockRejectionCode,
    type WorkLeaseGrantedData,
    type WorkOfferedData,
    type WorkOfferRetractionRequestedData,
    type WorkOfferRetractionResolvedData,
} from "../semantic-events.js"
import type { ConductorRunSummary } from "./conductor.js"
import {
    toRuntimeReplanProposal,
    validateConversationDelegationProposal,
} from "./conversation-delegation.js"
import {
    RuntimeReplanCoordinator,
    type RuntimeReplanDecisionOutcome,
} from "./runtime-replan-coordinator.js"
import { ProgressivePlanningCoordinator } from "./progressive-planning-coordinator.js"
import { OperationalRecoveryPolicy } from "./operational-recovery.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import { isProviderCapacityFailure } from "../provider-failure.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"
import { runtimeProposalFingerprint } from "../runtime/runtime-replan-fingerprint.js"
import { reservePolicyReplanBatchIds } from "../runtime/policy-replan-reservation.js"
import {
    validateRuntimeReplanMutation,
    type RuntimeReplanValidationResult,
} from "../runtime-replan.js"

export interface CollectiveBoardOptions {
    runId: string
    prdPath: string
    cwd: string
    timeoutSecs: number
    overrideModel?: string
    defaultModel?: string
    expectRecoveryDecisions?: boolean
    maxRecoveryAttemptsPerStory?: number
    /** Retries for transport/tool/evaluator incidents. These never consume
     * semantic healing or runtime-adaptation budget. Default: 2. */
    maxOperationalRetriesPerStory?: number
    /** Credential-free routes registered in the deterministic worker market. */
    marketRouteIds?: readonly string[]
    maxDynamicStories?: number
    replanProgressBudget?: number
    /** Independent budget for worker/discovery DAG mutations without an
     * integrated story. It is not consumed by Surgeon recovery. Default: 6. */
    runtimeAdaptationBudget?: number
    /** Persistence seam for graph-transaction tests and alternative durable
     * stores. Production defaults to the PRD atomic writer. */
    runtimeReplanPersist?: (path: string, prd: PrdFile) => void
    softDeadlineSecs?: number
    /** Gate a clean completion on objective build/test verification. */
    verifyBeforePush?: boolean
    /** Fail closed if the verifier never answers. Default: 21 minutes. */
    verificationTimeoutMs?: number
    /** Fail closed if the GoalGuardian never answers a correlated completion
     * check. Values are clamped to at least 1 ms. Default: 30 seconds. */
    goalCompletionTimeoutMs?: number
    /** Require a correlated Critic decision before integrating a successful story. */
    expectQualityDecisions?: boolean
    /** Object-identity Broker authority allowed to publish lease lifecycle events. */
    leaseAuthority?: Participant
    /** Object-identity Operator authority allowed to start this run. */
    startAuthority?: Participant
    /** Object-identity authority allowed to publish quality decisions. */
    qualityAuthority?: Participant
    /** Object-identity repository authority allowed to publish merge outcomes. */
    integrationAuthority?: Participant
    /** Object-identity RunVerifier authority allowed to publish objective evidence. */
    verifierAuthority?: Participant
    /** Independent GoalGuardian allowed to attest the global goal ledger. */
    goalCompletionAuthority?: Participant
    /** Object-identity Surgeon authority allowed to publish recovery policy. */
    recoveryAuthority?: Participant
    /** Object-identity CollaborationBridge authority allowed to discover work. */
    discoveryAuthority?: Participant
    /** Object-identity CollaborationBridge authority allowed to request a
     * cooperative dependency suspension for its current lease. */
    dependencyAuthority?: Participant
    /** Explicit feature gate for worker-requested dependency suspension.
     * Disabled by default so custom collective compositions cannot opt in by
     * merely wiring a bridge without also auditing executor quiescence. */
    dependencySuspensionEnabled?: boolean
    /** Object-identity bridge authority allowed to relay CLI runtime replans.
     * Native story participants are authorized through `outcomeAuthority`. */
    runtimeReplanAuthority?: Participant
    /** Opt-in host-owned planner stream. Absence preserves the full-plan path. */
    progressivePlanningId?: string
    /** Exact private PlanningFeed object allowed to publish planner events. */
    planningAuthority?: Participant
    /** Explicitly unsafe unit-test seam. Never enable in a real run. */
    unsafeAllowUnboundPlanningAuthority?: boolean
    /** Explicitly unsafe unit-test seam. Never enable in a real run. */
    unsafeAllowUnboundRuntimeReplanAuthority?: boolean
    /** Bound for the Broker to serialize offer retraction against a claim or
     * lease. The graph stays unchanged when this expires. Default: 5 seconds. */
    offerRetractionTimeoutMs?: number
    /** Explicitly unsafe unit-test seam. Never enable in a real run. */
    unsafeAllowUnboundDependencyAuthority?: boolean
    /** Object-identity WorkContextProvider allowed to answer context requests. */
    contextAuthority?: Participant
    /** Dynamic execution capabilities for terminal result/spawn-failure sources. */
    outcomeAuthority?: StoryOutcomeAuthority
}

interface WaveState {
    ordinal: number
    storyIds: string[]
    pending: Set<string>
    passed: string[]
    failed: string[]
    blocked: string[]
    recovery: boolean
}

interface PendingDependencyBlock {
    request: WorkBlockedData
    nextDependsOn: string[]
}

type WorkBlockDecisionEvent =
    | ReturnType<typeof WorkBlockAccepted.create>
    | ReturnType<typeof WorkBlockRejected.create>

interface RememberedWorkBlockDecision {
    fingerprint: string
    event: WorkBlockDecisionEvent
}

interface ActiveWorkOffer {
    data: WorkOfferedData
}

interface QueuedRuntimeReplan {
    proposal: RuntimeReplanProposedData
    fingerprint: string
    requireActiveLease: boolean
}

interface StagedRuntimeReplan extends QueuedRuntimeReplan {
    stageId: string
    retractions: Map<
        string,
        {
            request: WorkOfferRetractionRequestedData
            resolution?: WorkOfferRetractionResolvedData
        }
    >
}

interface RuntimeReplanRetractionTimedOutData {
    runId: string
    stageId: string
    proposalId: string
}

const RuntimeReplanRetractionTimedOut =
    defineSemanticEvent<RuntimeReplanRetractionTimedOutData>(
        "runtime_replan_retraction_timed_out",
    )

interface SoftDeadlineReachedData {
    runId: string
    startedAt: number
}

const SoftDeadlineReached = defineSemanticEvent<SoftDeadlineReachedData>(
    "collective_soft_deadline_reached",
)

interface GoalCompletionCheckTimedOutData {
    runId: string
    checkId: string
    contractId: string | null
    verificationId: string
    timeoutMs: number
}

const GoalCompletionCheckTimedOut =
    defineSemanticEvent<GoalCompletionCheckTimedOutData>(
        "goal_completion_check_timed_out",
    )

type BoardPhase = "idle" | "preparing" | "running" | "verifying" | "pushing" | "done"

const MAX_GOAL_REMEDIATION_ADMISSION_ATTEMPTS = 3

export class CollectiveBoard extends SerializedObserver {
    private phase: BoardPhase = "idle"
    private prd: PrdFile | null = null
    private startedAt = 0
    private wave: WaveState | null = null
    private waveOrdinal = 0
    private offerSequence = 0
    private runtimeReplanStageSequence = 0
    private contextSequence = 0
    private cleanupSequence = 0
    private verificationSequence = 0
    /**
     * A Board can be reconstructed with the same run id while persisted goal
     * evidence survives. Sequence numbers restart at one, so they cannot by
     * themselves distinguish a fresh verifier invocation from one issued by
     * the previous coordinator instance. Keep a cryptographically fresh
     * instance epoch in every verification identity so an old aggregate PASS
     * can never match the new completion basis.
     */
    private readonly verificationEpoch = randomUUID()
    private goalCheckSequence = 0
    private discoverySequence = 0
    private totalAttempts = 0
    private readonly completed: string[] = []
    private readonly failed = new Set<string>()
    private readonly dropped = new Set<string>()
    private readonly pendingDependencyBlocks = new Map<
        string,
        PendingDependencyBlock
    >()
    /** Run-local decision ledger. RuntimeReplanCoordinator durably protects
     * the graph mutation; this ledger makes duplicate bridge delivery replay
     * the exact user-facing block decision instead of changing its truth after
     * the lease settles. */
    private readonly dependencyBlockDecisions = new Map<
        string,
        RememberedWorkBlockDecision
    >()
    private readonly leases = new Map<
        string,
        {
            leaseId: string
            generation: number
            workerId: string
            route?: { routeId: string; backend: string; model: string }
            supportsCooperativeSuspend: boolean
        }
    >()
    /** Board-side lifecycle projection for work which has been published but
     * has not crossed the Broker's lease boundary. Planned/context-pending
     * stories deliberately do not appear here. */
    private readonly activeOffers = new Map<string, ActiveWorkOffer>()
    private readonly runtimeReplanQueue: QueuedRuntimeReplan[] = []
    private stagedRuntimeReplan: StagedRuntimeReplan | null = null
    /** A timed-out request can still resolve later. Retain its exact
     * correlation so a late retraction restores that story without touching a
     * newer offer. */
    private readonly abandonedOfferRetractions = new Map<
        string,
        WorkOfferRetractionRequestedData
    >()
    private readonly settledLeaseResults = new Set<string>()
    private readonly pendingQuality = new Map<string, StoryResultData>()
    private readonly durations = new Map<string, number>()
    private readonly dependencySuspensionDurationSecs = new Map<
        string,
        number
    >()
    private readonly recoveryAttempts = new Map<string, number>()
    private readonly capacityRerouteAttempts = new Map<string, number>()
    private readonly recoveryContext = new Map<
        string,
        {
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
    >()
    private readonly recoveryAborted = new Set<string>()
    /** Capacity recovery is deterministic routing, not a Surgeon decision. */
    private readonly capacityRecoveryPending = new Set<string>()
    /** Non-work incidents are retried/rescheduled independently of Surgeon
     * and the runtime DAG adaptation budget. */
    private readonly operationalRecovery: OperationalRecoveryPolicy
    private readonly marketRouteIds: ReadonlySet<string>
    private readonly unavailableMarketRouteIds = new Set<string>()
    private readonly unclaimable = new Set<string>()
    private readonly unmergeable = new Set<string>()
    private readonly pendingReplans: ReplanData[] = []
    /** Contract-required work deferred only until the next integrated-story
     * progress checkpoint. The proposal is replay-safe and revalidated before
     * admission; it never mutates the graph from this queue directly. */
    private readonly pendingGoalRemediations = new Map<
        string,
        GoalInvariantRemediationProposedData
    >()
    private readonly pendingGoalRemediationFailures = new Map<
        string,
        { reason: string; retryable: boolean; attempts: number }
    >()
    private readonly runtimeReplans: RuntimeReplanCoordinator
    private readonly progressivePlanning: ProgressivePlanningCoordinator
    /** Exact DialogueAgent object allowed to propose add-only work. It is
     * late-bound because Dialogue itself needs this Board as control authority. */
    private conversationAuthority: Participant | null = null
    private readonly pendingRecovery = new Set<string>()
    private readonly recoveryDecided = new Set<string>()
    private readonly pendingCleanup = new Map<
        string,
        {
            storyId: string
            leaseId?: string
            generation?: number
        }
    >()
    private readonly contextRequests = new Map<string, PrdStory>()
    private readonly replanProgressBudget: number
    private readonly runtimeAdaptationBudget: number
    private readonly softDeadlineSecs: number
    private healingActionsSinceProgress = 0
    private runtimeAdaptationsSinceProgress = 0
    private stopReason: string | null = null
    private pendingVerificationId: string | null = null
    private pendingGoalCheck: {
        checkId: string
        contractId: string | null
        verificationId: string
    } | null = null
    private verificationStatus: "passed" | "failed" | "skipped" | undefined
    private verification: RunVerificationEvidence | undefined
    private verificationTimer: ReturnType<typeof setTimeout> | null = null
    private softDeadlineTimer: ReturnType<typeof setTimeout> | null = null
    private goalCompletionTimer: ReturnType<typeof setTimeout> | null = null
    private operationalRetryTimer: ReturnType<typeof setTimeout> | null = null
    private operationalRetryDueAt: number | null = null
    private goalRemediationRetryTimer: ReturnType<typeof setTimeout> | null = null
    private offerRetractionTimer: ReturnType<typeof setTimeout> | null = null
    readonly done: Promise<ConductorRunSummary>
    private resolveDone!: (summary: ConductorRunSummary) => void

    constructor(private readonly opts: CollectiveBoardOptions) {
        super()
        this.marketRouteIds = new Set(opts.marketRouteIds ?? [])
        this.operationalRecovery = new OperationalRecoveryPolicy({
            maxRetriesPerStory: opts.maxOperationalRetriesPerStory ?? 2,
            marketRouteIds: this.marketRouteIds,
            isRouteUnavailable: (routeId) =>
                this.unavailableMarketRouteIds.has(routeId),
        })
        this.replanProgressBudget =
            opts.replanProgressBudget ??
            envNonNegativeInt("BARO_REPLAN_PROGRESS_BUDGET", 3)
        this.runtimeAdaptationBudget =
            opts.runtimeAdaptationBudget ??
            envNonNegativeInt("BARO_RUNTIME_ADAPTATION_BUDGET", 6)
        this.softDeadlineSecs =
            opts.softDeadlineSecs ??
            envNonNegativeInt("BARO_RUN_SOFT_DEADLINE_SECS", 0)
        this.runtimeReplans = new RuntimeReplanCoordinator({
            runId: opts.runId,
            prdPath: opts.prdPath,
            maxDynamicStories: opts.maxDynamicStories ?? 3,
            adaptationBudget: this.runtimeAdaptationBudget,
            ...(opts.runtimeReplanPersist
                ? { persist: opts.runtimeReplanPersist }
                : {}),
        })
        this.progressivePlanning = new ProgressivePlanningCoordinator({
            runId: opts.runId,
            planningId: opts.progressivePlanningId,
            host: {
                snapshot: () => ({
                    phase: this.phase,
                    prd: this.prd,
                    graphVersion: this.runtimeReplans.graphVersion,
                    wave: this.wave
                        ? {
                              ordinal: this.wave.ordinal,
                              storyIds: [...this.wave.storyIds],
                          }
                        : null,
                }),
                commitPrd: (prd) => {
                    savePrdAtomic(this.opts.prdPath, prd)
                    this.prd = prd
                },
                admitGraph: ({ proposal, planningState, maxAddedStories }) => {
                    const outcome = this.runtimeReplans.decide(proposal, {
                        active:
                            this.phase === "preparing" ||
                            this.phase === "running",
                        prd: this.prd,
                        immutableStoryIds: this.runtimeImmutableStoryIds(),
                        activeLease: undefined,
                        adaptationsSinceProgress:
                            this.runtimeAdaptationsSinceProgress,
                        requireActiveLease: false,
                        storyAccounting: "planner",
                        maxAddedStories,
                        planningState,
                    })
                    if (outcome.applied && RuntimeReplanApplied.is(outcome.event)) {
                        this.prd = outcome.applied.prd
                    }
                    return outcome
                },
                emit: (event) => this.emitGraphDecision(event),
                afterAdmission: () => {
                    if (this.phase !== "running") return
                    if (this.wave) this.reconcileReadyStories()
                    else this.scheduleNextWave()
                },
                afterClose: () => {
                    if (this.phase === "running" && !this.wave) {
                        this.scheduleNextWave()
                    }
                },
                terminate: (reason) => this.terminate(false, reason),
            },
        })
        this.done = new Promise((resolve) => {
            this.resolveDone = resolve
        })
    }

    setConversationAuthority(authority: Participant): void {
        if (
            this.conversationAuthority !== null &&
            this.conversationAuthority !== authority
        ) {
            throw new Error("collective conversation authority is already bound")
        }
        this.conversationAuthority = authority
    }

    protected override async handleEvent(
        context: SerializedEventContext,
    ): Promise<void> {
        const { event } = context
        if (
            SoftDeadlineReached.is(event) &&
            context.internal &&
            event.data.runId === this.opts.runId
        ) {
            this.onSoftDeadlineReached(event.data)
            return
        }
        if (
            GoalCompletionCheckTimedOut.is(event) &&
            context.internal &&
            event.data.runId === this.opts.runId
        ) {
            this.onGoalCompletionCheckTimedOut(event.data)
            return
        }
        if (
            RuntimeReplanRetractionTimedOut.is(event) &&
            context.internal &&
            event.data.runId === this.opts.runId
        ) {
            this.onRuntimeReplanRetractionTimedOut(event.data)
            return
        }
        if (
            RunStartRequest.is(event) &&
            (!this.opts.startAuthority || context.source === this.opts.startAuthority)
        ) {
            this.start()
            return
        }
        if (
            RunPrepared.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            this.onPrepared()
            return
        }
        if (
            RunPreparationFailed.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            this.terminate(false, `run preparation failed: ${event.data.error}`)
            return
        }
        if (
            WorkLeaseGranted.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.leaseAuthority || context.source === this.opts.leaseAuthority)
        ) {
            this.onWorkLeaseGranted(event.data)
            return
        }
        if (
            WorkOfferRetractionResolved.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.leaseAuthority || context.source === this.opts.leaseAuthority)
        ) {
            this.onWorkOfferRetractionResolved(event.data)
            return
        }
        if (WorkBlocked.is(event) && event.data.runId === this.opts.runId) {
            if (
                context.source !== this.opts.dependencyAuthority &&
                this.opts.unsafeAllowUnboundDependencyAuthority !== true
            ) return
            this.onWorkBlocked(event.data)
            return
        }
        if (
            WorkLeaseReleased.is(event) &&
            event.data.runId === this.opts.runId &&
            event.data.reason === "dependency_blocked" &&
            (!this.opts.leaseAuthority ||
                context.source === this.opts.leaseAuthority)
        ) {
            this.onDependencyLeaseReleased(event.data)
            return
        }
        if (
            WorkContextProvided.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.contextAuthority ||
                context.source === this.opts.contextAuthority)
        ) {
            const story = this.contextRequests.get(event.data.requestId)
            if (!story || story.id !== event.data.storyId) return
            this.contextRequests.delete(event.data.requestId)
            if (
                this.wave?.pending.has(story.id) &&
                !this.runtimeReplanTargetsStory(story.id)
            ) {
                this.offerStory(story, event.data.context)
            }
            return
        }
        if (StoryResult.is(event)) {
            if (
                this.opts.outcomeAuthority &&
                !this.opts.outcomeAuthority.matchesResult(
                    context.source,
                    event.data,
                )
            ) return
            if (!this.matchesResultLease(event.data)) return
            if (
                !event.data.leaseId ||
                this.settledLeaseResults.has(event.data.leaseId)
            ) return
            this.settledLeaseResults.add(event.data.leaseId)
            this.onStoryResult(event.data)
            return
        }
        if (
            StoryQualityCompleted.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.qualityAuthority || context.source === this.opts.qualityAuthority)
        ) {
            this.onStoryQuality(event.data)
            return
        }
        if (StorySpawnFailed.is(event) && event.data.runId === this.opts.runId) {
            if (
                this.opts.outcomeAuthority &&
                !this.opts.outcomeAuthority.matchesSpawnFailure(
                    context.source,
                    event.data,
                )
            ) return
            if (!this.matchesLease(event.data.storyId, event.data.leaseId)) return
            if (isOperationalFailure(event.data.failure)) {
                this.prepareOperationalRecovery(
                    event.data.storyId,
                    event.data.failure,
                )
            }
            this.failStory(
                event.data.storyId,
                `spawn failed: ${event.data.error}`,
                true,
                isOperationalFailure(event.data.failure)
                    ? event.data.failure.kind
                    : "execution",
            )
            return
        }
        if (StoryMerged.is(event)) {
            if (
                event.data.runId !== this.opts.runId ||
                (this.opts.integrationAuthority &&
                    context.source !== this.opts.integrationAuthority) ||
                !this.matchesLease(event.data.storyId, event.data.leaseId)
            ) return
            this.onStoryMerged(event.data.storyId)
            return
        }
        if (StoryMergeFailed.is(event)) {
            if (
                event.data.runId !== this.opts.runId ||
                (this.opts.integrationAuthority &&
                    context.source !== this.opts.integrationAuthority) ||
                !this.matchesLease(event.data.storyId, event.data.leaseId)
            ) return
            if (event.data.retryable && event.data.branch) {
                // Repository preparation saved the rejected attempt under an
                // immutable backup ref and released the logical story's old
                // worktree. Re-offer it from the latest integrated HEAD.
                this.recoveryContext.set(event.data.storyId, {
                    kind: "integration",
                    reason: event.data.error,
                    branch: event.data.branch,
                })
                this.failStory(
                    event.data.storyId,
                    event.data.error,
                    false,
                )
            } else {
                // Missing isolated state cannot be reconciled safely.
                this.unmergeable.add(event.data.storyId)
                this.failStory(event.data.storyId, event.data.error, false)
            }
            return
        }
        if (
            WorkOfferExpired.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.leaseAuthority || context.source === this.opts.leaseAuthority)
        ) {
            const offer = this.activeOffers.get(event.data.storyId)
            if (!offer || offer.data.offerId !== event.data.offerId) return
            const stagedRetraction = this.isOfferAwaitingRetraction(
                event.data.offerId,
            )
            const abandonedRetraction =
                this.consumeAbandonedOfferRetractions(event.data.offerId)
            this.activeOffers.delete(event.data.storyId)
            if (stagedRetraction) return
            if (abandonedRetraction) {
                // The graph transaction already failed closed at its
                // retraction watchdog. Expiry now proves the unchanged old
                // offer is closed, so return the story to scheduling instead
                // of converting a delayed Broker ACK into an execution
                // failure. Any eventual ACK is obsolete after this tombstone.
                this.restoreRetractedStories([event.data.storyId])
                return
            }
            this.unclaimable.add(event.data.storyId)
            this.failStory(event.data.storyId, event.data.reason, false)
            return
        }
        if (
            WorkLeaseExpired.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.leaseAuthority || context.source === this.opts.leaseAuthority) &&
            this.matchesLease(event.data.storyId, event.data.leaseId)
        ) {
            const pendingBlock = this.pendingDependencyBlocks.get(
                event.data.storyId,
            )
            if (pendingBlock?.request.leaseId === event.data.leaseId) {
                // A suspension timeout is not an execution failure: there is
                // no proof that the worker/process tree is quiescent, so the
                // ordinary cleanup/recovery path could race live writes or
                // start a second generation beside the first. Stop this run
                // fail-closed and leave the isolated worktree untouched.
                this.terminate(
                    false,
                    `dependency suspension for ${event.data.storyId} expired ` +
                        `before worker quiescence; stopped without workspace cleanup`,
                )
                return
            }
            const failure: StoryFailureData = {
                kind: "infrastructure",
                code: "command_timeout",
            }
            this.prepareOperationalRecovery(event.data.storyId, failure)
            this.failStory(
                event.data.storyId,
                event.data.reason,
                true,
                "infrastructure",
            )
            return
        }
        if (
            WorkspaceCleanupCompleted.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            const pending = this.pendingCleanup.get(event.data.cleanupId)
            if (
                !pending ||
                pending.storyId !== event.data.storyId ||
                pending.leaseId !== event.data.leaseId ||
                pending.generation !== event.data.generation
            ) return
            if (event.data.preservedBranch) {
                const recovery = this.recoveryContext.get(event.data.storyId)
                if (recovery && recovery.kind !== "integration") {
                    this.recoveryContext.set(event.data.storyId, {
                        ...recovery,
                        branch: event.data.preservedBranch,
                    })
                }
            }
            this.pendingCleanup.delete(event.data.cleanupId)
            this.maybeCompleteWave()
            return
        }
        if (
            WorkspaceCleanupFailed.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            const pending = this.pendingCleanup.get(event.data.cleanupId)
            if (
                !pending ||
                pending.storyId !== event.data.storyId ||
                pending.leaseId !== event.data.leaseId ||
                pending.generation !== event.data.generation
            ) return
            this.pendingCleanup.delete(event.data.cleanupId)
            const dependencyResume =
                this.recoveryContext.get(event.data.storyId)?.kind ===
                "dependency"
            if (dependencyResume) {
                this.failed.add(event.data.storyId)
                if (this.wave) {
                    this.wave.blocked = this.wave.blocked.filter(
                        (storyId) => storyId !== event.data.storyId,
                    )
                    addUnique(this.wave.failed, event.data.storyId)
                }
            }
            this.unmergeable.add(event.data.storyId)
            this.recoveryAborted.add(event.data.storyId)
            this.capacityRecoveryPending.delete(event.data.storyId)
            this.operationalRecovery.abort(event.data.storyId)
            this.pendingRecovery.delete(event.data.storyId)
            this.recoveryDecided.add(event.data.storyId)
            for (let i = this.pendingReplans.length - 1; i >= 0; i -= 1) {
                const replan = this.pendingReplans[i]
                if (replan?.recovery?.storyId === event.data.storyId) {
                    this.pendingReplans.splice(i, 1)
                }
            }
            this.recoveryContext.set(event.data.storyId, {
                kind: "execution",
                reason:
                    `failed worktree was retained after cleanup failed: ` +
                    event.data.error,
                ...(event.data.retainedBranch
                    ? { branch: event.data.retainedBranch }
                    : {}),
            })
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `${event.data.storyId} cleanup failed; retained worktree: ` +
                        event.data.error,
                    currentLevel: this.wave?.ordinal,
                    storyIds: this.wave?.storyIds,
                }),
            )
            this.maybeCompleteWave()
            return
        }
        if (
            RecoveryEvaluationStarted.is(event) &&
            event.data.runId === this.opts.runId &&
            this.opts.expectRecoveryDecisions === true &&
            (!this.opts.recoveryAuthority ||
                context.source === this.opts.recoveryAuthority)
        ) {
            if (
                !this.capacityRecoveryPending.has(event.data.storyId) &&
                !this.operationalRecovery.isPending(event.data.storyId) &&
                !this.recoveryAborted.has(event.data.storyId) &&
                !this.recoveryDecided.has(event.data.storyId)
            ) {
                this.pendingRecovery.add(event.data.storyId)
            }
            return
        }
        if (
            RecoveryDecision.is(event) &&
            event.data.runId === this.opts.runId &&
            this.opts.expectRecoveryDecisions === true &&
            (!this.opts.recoveryAuthority ||
                context.source === this.opts.recoveryAuthority)
        ) {
            if (
                this.capacityRecoveryPending.has(event.data.storyId) ||
                this.operationalRecovery.isPending(event.data.storyId) ||
                this.recoveryAborted.has(event.data.storyId)
            ) return
            this.recoveryDecided.add(event.data.storyId)
            this.pendingRecovery.delete(event.data.storyId)
            if (event.data.action === "abort") {
                this.recoveryAborted.add(event.data.storyId)
            }
            this.maybeCompleteWave()
            return
        }
        if (
            this.isPlanningAuthority(context.source) &&
            this.progressivePlanning.handleEvent(event)
        ) {
            return
        }
        if (
            GoalInvariantRemediationProposed.is(event) &&
            event.data.runId === this.opts.runId &&
            this.opts.goalCompletionAuthority !== undefined &&
            context.source === this.opts.goalCompletionAuthority
        ) {
            this.onGoalInvariantRemediationProposed(event.data)
            return
        }
        if (
            RuntimeReplanProposed.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onRuntimeReplanProposed(context.source, event.data)
            return
        }
        if (
            ConversationDelegationProposed.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (context.source !== this.conversationAuthority) return
            this.onConversationDelegationProposed(event.data)
            return
        }
        if (
            Replan.is(event) &&
            (context.internal ||
                (this.opts.expectRecoveryDecisions === true &&
                    (!this.opts.recoveryAuthority ||
                        context.source === this.opts.recoveryAuthority)))
        ) {
            if (this.progressivePlanning.isFailed()) return
            if (!context.internal) {
                const recovery = event.data.recovery
                // Autonomous recovery mutations must identify the exact failed
                // story. Graph-shape inference is unsafe for rewire-only plans.
                if (!recovery) return
                if (recovery.runId && recovery.runId !== this.opts.runId) return
                if (this.recoveryAborted.has(recovery.storyId)) return
                if (
                    !this.pendingRecovery.has(recovery.storyId) &&
                    !this.failed.has(recovery.storyId)
                ) return
            }
            this.pendingReplans.push(event.data)
            return
        }
        if (
            WorkDiscovered.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.discoveryAuthority ||
                context.source === this.opts.discoveryAuthority)
        ) {
            this.onWorkDiscovered(event.data)
            return
        }
        if (
            RunVerificationCompleted.is(event) &&
            event.data.runId === this.opts.runId &&
            event.data.verificationId === this.pendingVerificationId &&
            this.phase === "verifying" &&
            (!this.opts.verifierAuthority ||
                context.source === this.opts.verifierAuthority)
        ) {
            this.onVerificationCompleted(event.data)
            return
        }
        if (
            RunVerificationTimedOut.is(event) &&
            event.data.runId === this.opts.runId &&
            event.data.verificationId === this.pendingVerificationId &&
            this.phase === "verifying" &&
            context.internal
        ) {
            this.onVerificationTimedOut(event.data.verificationId, event.data.timeoutMs)
            return
        }
        if (
            GoalLedgerProjectionUpdated.is(event) &&
            event.data.runId === this.opts.runId &&
            this.opts.goalCompletionAuthority !== undefined &&
            context.source === this.opts.goalCompletionAuthority
        ) {
            this.onGoalLedgerProjectionUpdated(event.data)
            return
        }
        if (
            GoalCompletionAttested.is(event) &&
            event.data.runId === this.opts.runId &&
            this.phase === "verifying" &&
            this.opts.goalCompletionAuthority !== undefined &&
            context.source === this.opts.goalCompletionAuthority
        ) {
            this.onGoalCompletionAttested(event.data)
            return
        }
        if (
            RunPushed.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            this.finishAfterPush()
            return
        }
        if (
            RunPushFailed.is(event) &&
            event.data.runId === this.opts.runId &&
            (!this.opts.integrationAuthority ||
                context.source === this.opts.integrationAuthority)
        ) {
            this.terminate(false, `run push failed: ${event.data.error}`)
        }
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        this.terminate(false, `collective board failed: ${failure.error.message}`)
    }

    private start(): void {
        if (this.phase !== "idle") return
        this.phase = "preparing"
        this.startedAt = Date.now()
        this.prd = this.progressivePlanning.initialize(loadPrd(this.opts.prdPath))
        this.armSoftDeadlineTimer()
        // A run starts a fresh optimistic-concurrency domain. PRD contents are
        // durable; outstanding proposals never survive across run identities.
        this.runtimeReplans.start(this.prd)
        this.emit(
            CoordinationModeSelected.create({
                runId: this.opts.runId,
                mode: "collective",
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "loading",
                detail: `collective board loaded ${this.prd.userStories.length} stories`,
            }),
        )
        this.emit(RunPreparationRequested.create({ runId: this.opts.runId }))
    }

    private onPrepared(): void {
        if (this.phase !== "preparing" || !this.prd) return
        this.phase = "running"
        this.emit(
            RunStarted.create({
                project: this.prd.project,
                storyCount: this.prd.userStories.length,
                graphVersion: this.runtimeReplans.graphVersion,
                storyIds: this.prd.userStories.map((story) => story.id),
                completedStoryIds: this.prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                coordinationMode: "collective",
                ...(this.prd.executionMode ? { mode: this.prd.executionMode.mode } : {}),
            }),
        )
        this.scheduleNextWave()
    }

    private isPlanningAuthority(source: Participant): boolean {
        return (
            (this.opts.planningAuthority !== undefined &&
                source === this.opts.planningAuthority) ||
            this.opts.unsafeAllowUnboundPlanningAuthority === true
        )
    }

    private onWorkBlocked(request: WorkBlockedData): void {
        if (this.replayWorkBlockDecision(request)) return
        if (this.opts.dependencySuspensionEnabled !== true) {
            this.rejectWorkBlock(
                request,
                "invalid_request",
                "dependency suspension is disabled for this collective run",
            )
            return
        }
        if (this.phase !== "running" || !this.prd || !this.wave) {
            this.rejectWorkBlock(
                request,
                "run_not_active",
                "dependency suspension is available only during an active wave",
            )
            return
        }
        const lease = this.leases.get(request.storyId)
        if (
            !lease ||
            lease.leaseId !== request.leaseId ||
            lease.generation !== request.generation
        ) {
            this.rejectWorkBlock(
                request,
                "stale_lease",
                "dependency suspension requires the story's current lease",
            )
            return
        }
        if (!lease.supportsCooperativeSuspend) {
            this.rejectWorkBlock(
                request,
                "invalid_request",
                `worker ${lease.workerId} cannot prove cooperative suspension quiescence`,
            )
            return
        }
        if (
            this.settledLeaseResults.has(request.leaseId) ||
            !this.wave.pending.has(request.storyId) ||
            this.pendingDependencyBlocks.has(request.storyId)
        ) {
            this.rejectWorkBlock(
                request,
                "already_settled",
                "the story lease is already settling",
            )
            return
        }
        if (!validDependencyBlock(request)) {
            this.rejectWorkBlock(
                request,
                "invalid_request",
                "dependency suspension requires a reason and unique story ids",
            )
            return
        }

        const story = this.prd.userStories.find(
            (candidate) => candidate.id === request.storyId,
        )
        if (!story) {
            this.rejectWorkBlock(
                request,
                "stale_lease",
                "the leased story no longer exists in the runtime graph",
            )
            return
        }
        const storyById = new Map(
            this.prd.userStories.map((candidate) => [candidate.id, candidate]),
        )
        const unknown = request.requiredStoryIds.find(
            (storyId) => !storyById.has(storyId),
        )
        if (unknown) {
            this.rejectWorkBlock(
                request,
                "unknown_dependency",
                `required story ${unknown} does not exist in the runtime graph`,
            )
            return
        }
        if (
            request.requiredStoryIds.includes(request.storyId) ||
            request.requiredStoryIds.some(
                (storyId) => storyById.get(storyId)?.passes,
            )
        ) {
            this.rejectWorkBlock(
                request,
                request.requiredStoryIds.includes(request.storyId)
                    ? "dependency_cycle"
                    : "dependency_already_satisfied",
                request.requiredStoryIds.includes(request.storyId)
                    ? "a story cannot block on itself"
                    : "a requested prerequisite is already integrated",
            )
            return
        }

        const nextDependsOn = [
            ...story.dependsOn,
            ...request.requiredStoryIds.filter(
                (storyId) => !story.dependsOn.includes(storyId),
            ),
        ]
        if (nextDependsOn.length === story.dependsOn.length) {
            this.rejectWorkBlock(
                request,
                "dependency_already_satisfied",
                "the story already declares every requested prerequisite",
            )
            return
        }

        const immutable = this.runtimeImmutableStoryIds()
        // Cooperative suspension is the one transition allowed to rewrite
        // its own active node. Every other leased/started node stays immutable.
        immutable.delete(request.storyId)
        const proposal: RuntimeReplanProposedData = {
            runId: this.opts.runId,
            proposalId: `${this.opts.runId}:dependency-block:${request.blockId}`,
            sourceStoryId: request.storyId,
            leaseId: request.leaseId,
            generation: request.generation,
            baseGraphVersion: this.runtimeReplans.graphVersion,
            reason: request.reason,
            mutation: {
                addedStories: [],
                removedStoryIds: [],
                modifiedDeps: { [request.storyId]: nextDependsOn },
            },
        }
        const outcome = this.runtimeReplans.decide(proposal, {
            active: true,
            prd: this.prd,
            immutableStoryIds: immutable,
            activeLease: {
                leaseId: request.leaseId,
                generation: request.generation,
            },
            adaptationsSinceProgress: this.runtimeAdaptationsSinceProgress,
            storyAccounting: "policy",
            maxAddedStories: 0,
        })
        if (!outcome.applied || !RuntimeReplanApplied.is(outcome.event)) {
            this.emitGraphDecision(outcome.event)
            const code = RuntimeReplanRejected.is(outcome.event)
                ? blockRejectionCode(outcome.event.data.code)
                : "invalid_request"
            const reason = RuntimeReplanRejected.is(outcome.event)
                ? outcome.event.data.reason
                : "dependency graph mutation was not applied"
            this.rejectWorkBlock(request, code, reason)
            return
        }

        this.prd = outcome.applied.prd
        this.settledLeaseResults.add(request.leaseId)
        this.pendingDependencyBlocks.set(request.storyId, {
            request: {
                ...request,
                requiredStoryIds: [...request.requiredStoryIds],
            },
            nextDependsOn,
        })
        this.emitGraphDecision(outcome.event)
        const accepted = WorkBlockAccepted.create({
            ...request,
            requiredStoryIds: [...request.requiredStoryIds],
            graphVersion: outcome.event.data.graphVersion,
        })
        this.rememberWorkBlockDecision(request, accepted)
        this.emit(accepted)
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `${request.storyId} suspended on ` +
                    request.requiredStoryIds.join(", "),
                currentLevel: this.wave.ordinal,
                storyIds: this.wave.storyIds,
            }),
        )
    }

    private onDependencyLeaseReleased(release: {
        storyId: string
        leaseId: string
        attempts?: unknown
        durationSecs?: unknown
    }): void {
        const { storyId, leaseId } = release
        const block = this.pendingDependencyBlocks.get(storyId)
        const lease = this.leases.get(storyId)
        if (
            !block ||
            !lease ||
            block.request.leaseId !== leaseId ||
            lease.leaseId !== leaseId ||
            !this.wave?.pending.has(storyId)
        ) return

        const attempts = nonNegativeSafeInteger(release.attempts)
        if (attempts !== null) this.totalAttempts += attempts
        const durationSecs = nonNegativeFinite(release.durationSecs)
        if (durationSecs !== null) {
            this.dependencySuspensionDurationSecs.set(
                storyId,
                (this.dependencySuspensionDurationSecs.get(storyId) ?? 0) +
                    durationSecs,
            )
        }

        this.pendingDependencyBlocks.delete(storyId)
        this.wave.pending.delete(storyId)
        addUnique(this.wave.blocked, storyId)
        this.leases.delete(storyId)
        this.pendingQuality.delete(storyId)
        this.pendingRecovery.delete(storyId)
        this.recoveryDecided.delete(storyId)
        this.recoveryContext.set(storyId, {
            kind: "dependency",
            reason:
                `blocked on ${block.request.requiredStoryIds.join(", ")}: ` +
                block.request.reason,
        })

        const cleanupId =
            `${this.opts.runId}:cleanup:${++this.cleanupSequence}:${storyId}`
        this.pendingCleanup.set(cleanupId, {
            storyId,
            leaseId,
            generation: block.request.generation,
        })
        this.emit(
            WorkspaceCleanupRequested.create({
                runId: this.opts.runId,
                cleanupId,
                storyId,
                leaseId,
                generation: block.request.generation,
                preserveForRecovery: true,
            }),
        )
        this.maybeCompleteWave()
    }

    private rejectWorkBlock(
        request: WorkBlockedData,
        code: WorkBlockRejectionCode,
        reason: string,
        remember = true,
    ): void {
        const rejected = WorkBlockRejected.create({
            runId: request.runId,
            blockId: request.blockId,
            storyId: request.storyId,
            leaseId: request.leaseId,
            generation: request.generation,
            requiredStoryIds: [...request.requiredStoryIds],
            requestReason: request.reason,
            code,
            reason,
        })
        if (remember) this.rememberWorkBlockDecision(request, rejected)
        this.emit(rejected)
    }

    private replayWorkBlockDecision(request: WorkBlockedData): boolean {
        const remembered = this.dependencyBlockDecisions.get(request.blockId)
        if (!remembered) return false
        if (remembered.fingerprint === workBlockFingerprint(request)) {
            this.emit(remembered.event)
            return true
        }
        this.rejectWorkBlock(
            request,
            "invalid_request",
            `block id ${request.blockId || "(missing)"} was already used with different content`,
            false,
        )
        return true
    }

    private rememberWorkBlockDecision(
        request: WorkBlockedData,
        event: WorkBlockDecisionEvent,
    ): void {
        if (!request.blockId || this.dependencyBlockDecisions.has(request.blockId)) {
            return
        }
        this.dependencyBlockDecisions.set(request.blockId, {
            fingerprint: workBlockFingerprint(request),
            event,
        })
    }

    private onStoryResult(result: StoryResultData): void {
        if (this.phase !== "running" || !this.wave?.pending.has(result.storyId)) return
        this.totalAttempts += result.attempts
        this.durations.set(
            result.storyId,
            (this.dependencySuspensionDurationSecs.get(result.storyId) ?? 0) +
                result.durationSecs,
        )

        if (
            result.failure?.kind === "infrastructure" &&
            result.failure.code === "process_quiescence_uncertified"
        ) {
            // The worker could not prove that every process which owned this
            // isolated worktree is gone. Any ordinary cleanup, retry, or
            // structural recovery could therefore race a surviving writer.
            this.terminate(
                false,
                `${result.storyId} process-tree quiescence was not certified; ` +
                    `stopped without workspace cleanup`,
            )
            return
        }

        if (result.success) {
            if (this.opts.expectQualityDecisions) {
                this.pendingQuality.set(result.storyId, { ...result })
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail: `${result.storyId} execution finished; awaiting acceptance verdict`,
                        currentLevel: this.wave.ordinal,
                        storyIds: this.wave.storyIds,
                    }),
                )
                return
            }
            this.requestIntegration(result)
            return
        }

        if (isProviderCapacityFailure(result)) {
            if (isPermanentCapacityFailure(result.failure?.code)) {
                this.prepareCapacityRecovery(result.storyId)
            } else {
                this.prepareOperationalRecovery(
                    result.storyId,
                    { kind: "provider_capacity", ...result.failure },
                )
            }
        } else if (isOperationalFailure(result.failure)) {
            this.prepareOperationalRecovery(
                result.storyId,
                result.failure!,
            )
        } else if (
            this.opts.expectRecoveryDecisions &&
            !this.recoveryDecided.has(result.storyId)
        ) {
            this.pendingRecovery.add(result.storyId)
        }
        this.failStory(
            result.storyId,
            result.error ?? "story execution failed",
            true,
            isOperationalFailure(result.failure)
                ? result.failure.kind
                : isProviderCapacityFailure(result) &&
                    !isPermanentCapacityFailure(result.failure?.code)
                  ? "transport"
                  : "execution",
        )
    }

    private requestIntegration(
        result: StoryResultData,
        quality?: StoryQualityCompletedData,
    ): void {
        const lease = this.leases.get(result.storyId)
        if (!lease) {
            this.failStory(
                result.storyId,
                "successful execution had no active lease",
                true,
                "execution",
            )
            return
        }
        const candidateFingerprintRequired =
            quality !== undefined && quality.targetTurn !== null
        const candidateFingerprint = quality?.critique?.repositoryFingerprint
        this.emit(
            StoryIntegrationRequested.create({
                runId: this.opts.runId,
                leaseId: lease.leaseId,
                storyId: result.storyId,
                attempts: result.attempts,
                durationSecs: result.durationSecs,
                candidateFingerprintRequired,
                ...(candidateFingerprint ? { candidateFingerprint } : {}),
            }),
        )
    }

    private onStoryQuality(data: StoryQualityCompletedData): void {
        if (this.phase !== "running" || !this.wave?.pending.has(data.storyId)) return
        const result = this.pendingQuality.get(data.storyId)
        if (
            !result ||
            result.leaseId !== data.leaseId ||
            result.generation !== data.generation ||
            !this.matchesLease(data.storyId, data.leaseId)
        ) return
        this.pendingQuality.delete(data.storyId)
        if (data.status === "passed") {
            this.requestIntegration(result, data)
            return
        }
        if (data.status === "inconclusive") {
            // AcceptanceGate has already exhausted its bounded rechecks of
            // this exact lease/worktree. Preserve the candidate for diagnosis,
            // but never turn missing evaluator evidence into a new coding
            // generation (or a Surgeon quality-repair decision).
            this.pendingRecovery.delete(data.storyId)
            this.recoveryDecided.add(data.storyId)
            this.operationalRecovery.abort(data.storyId)
            this.recoveryAborted.add(data.storyId)
            this.failStory(
                data.storyId,
                `acceptance gate was inconclusive: ${data.reason}`,
                true,
                "verification",
            )
            return
        }
        if (
            this.opts.expectRecoveryDecisions &&
            !this.recoveryDecided.has(data.storyId)
        ) {
            this.pendingRecovery.add(data.storyId)
        }
        this.failStory(
            data.storyId,
            `acceptance gate failed: ${data.reason}`,
            true,
            "execution",
        )
    }

    private onStoryMerged(storyId: string): void {
        if (this.phase !== "running" || !this.wave?.pending.has(storyId) || !this.prd) {
            return
        }
        const duration = this.durations.get(storyId) ?? 0
        this.prd = markStoryPassed(this.prd, storyId, duration)
        savePrdAtomic(this.opts.prdPath, this.prd)
        this.dependencySuspensionDurationSecs.delete(storyId)
        this.wave.pending.delete(storyId)
        addUnique(this.wave.passed, storyId)
        addUnique(this.completed, storyId)
        this.failed.delete(storyId)
        this.recoveryContext.delete(storyId)
        this.recoveryAborted.delete(storyId)
        this.capacityRecoveryPending.delete(storyId)
        this.capacityRerouteAttempts.delete(storyId)
        this.operationalRecovery.forget(storyId)
        this.recoveryDecided.delete(storyId)
        this.leases.delete(storyId)
        this.pendingQuality.delete(storyId)
        this.healingActionsSinceProgress = 0
        this.runtimeAdaptationsSinceProgress = 0
        this.retryPendingGoalRemediations(true)
        this.reconcileReadyStories()
        this.maybeCompleteWave()
    }

    private matchesResultLease(result: StoryResultData): boolean {
        const lease = this.leases.get(result.storyId)
        if (!lease) return false
        return (
            result.runId === this.opts.runId &&
            result.leaseId === lease.leaseId &&
            result.generation === lease.generation
        )
    }

    private matchesLease(storyId: string, leaseId: string | undefined): boolean {
        return leaseId !== undefined && this.leases.get(storyId)?.leaseId === leaseId
    }

    private failStory(
        storyId: string,
        error: string,
        cleanup: boolean,
        recoveryKind?:
            | "execution"
            | "integration"
            | "transport"
            | "infrastructure"
            | "verification",
    ): void {
        if (this.phase !== "running" || !this.wave?.pending.has(storyId)) return
        const lease = this.leases.get(storyId)
        if (recoveryKind) {
            const previousBranch = this.recoveryContext.get(storyId)?.branch
            this.recoveryContext.set(storyId, {
                kind: recoveryKind,
                reason: error,
                ...(previousBranch ? { branch: previousBranch } : {}),
            })
        }
        this.wave.pending.delete(storyId)
        addUnique(this.wave.failed, storyId)
        this.failed.add(storyId)
        this.leases.delete(storyId)
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: `${storyId} failed: ${error}`,
                currentLevel: this.wave.ordinal,
                storyIds: this.wave.storyIds,
            }),
        )
        if (cleanup) {
            const cleanupId =
                `${this.opts.runId}:cleanup:${++this.cleanupSequence}:${storyId}`
            // Durability is independent of automatic retry policy. Even the
            // final failed attempt may contain valuable partial work that a
            // human needs after the bounded recovery budget is exhausted.
            const preserveForRecovery =
                recoveryKind !== undefined && recoveryKind !== "integration"
            this.pendingCleanup.set(cleanupId, {
                storyId,
                ...(lease ? lease : {}),
            })
            this.emit(
                WorkspaceCleanupRequested.create({
                    runId: this.opts.runId,
                    cleanupId,
                    storyId,
                    ...(lease ? lease : {}),
                    ...(preserveForRecovery ? { preserveForRecovery: true } : {}),
                }),
            )
        }
        this.maybeCompleteWave()
    }

    private maybeCompleteWave(): void {
        if (!this.wave || this.wave.pending.size > 0) return
        if (this.pendingCleanup.size > 0 || this.pendingRecovery.size > 0) return
        this.completeWave()
    }

    private prepareCapacityRecovery(storyId: string): void {
        const routeId = this.leases.get(storyId)?.route?.routeId
        this.pendingRecovery.delete(storyId)
        this.recoveryDecided.add(storyId)

        if (!routeId || !this.marketRouteIds.has(routeId)) {
            // First-claim/single-provider execution has no trusted alternate
            // market route. Preserve its checkpoint, then fail closed.
            this.capacityRecoveryPending.delete(storyId)
            this.recoveryAborted.add(storyId)
            return
        }

        const routeSetGrew = !this.unavailableMarketRouteIds.has(routeId)
        this.unavailableMarketRouteIds.add(routeId)
        if (!routeSetGrew) {
            // A Broker must never grant an excluded route. Fail closed rather
            // than allowing a malformed/replayed lease to create an infinite
            // capacity-recovery loop.
            this.capacityRecoveryPending.delete(storyId)
            this.recoveryAborted.add(storyId)
            return
        }
        const hasAlternate = [...this.marketRouteIds].some(
            (candidate) => !this.unavailableMarketRouteIds.has(candidate),
        )
        if (hasAlternate) {
            this.capacityRecoveryPending.add(storyId)
            this.recoveryAborted.delete(storyId)
        } else {
            // Another story in the same wave may have reserved the last
            // remaining route before its own capacity failure arrived. Any
            // earlier pending reroutes are now stale too: close all of them
            // rather than publishing offers that no configured route can win.
            for (const pendingStoryId of this.capacityRecoveryPending) {
                this.recoveryAborted.add(pendingStoryId)
            }
            this.capacityRecoveryPending.clear()
            this.recoveryAborted.add(storyId)
        }
    }

    private prepareOperationalRecovery(
        storyId: string,
        failure: StoryFailureData,
    ): void {
        this.pendingRecovery.delete(storyId)
        this.recoveryDecided.add(storyId)
        const routeId = this.leases.get(storyId)?.route?.routeId
        if (!this.operationalRecovery.prepare(storyId, {
            ...(routeId ? { failedRouteId: routeId } : {}),
            excludeFailedRoute: failureImplicatesWorkerRoute(failure),
            ...(failure.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: failure.retryAfterMs }),
        })) {
            this.recoveryAborted.add(storyId)
            return
        }
        this.recoveryAborted.delete(storyId)
    }

    private completeWave(): void {
        const wave = this.wave
        if (!wave || !this.prd) return
        this.emit(
            LevelCompleted.create({
                ordinal: wave.ordinal,
                passed: wave.passed,
                failed: wave.failed,
                ...(wave.blocked.length > 0
                    ? { blocked: wave.blocked }
                    : {}),
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: `collective integrated ${wave.passed.length}/${wave.storyIds.length}`,
                currentLevel: wave.ordinal,
                storyIds: wave.storyIds,
            }),
        )

        const healingHalt = this.applyPendingReplans(wave.ordinal)
        this.wave = null
        if (healingHalt) {
            this.requestPush(healingHalt)
            return
        }
        this.scheduleNextWave()
    }

    private applyPendingReplans(currentLevel: number): string | null {
        if (!this.prd) return null
        if (this.progressivePlanning.isFailed()) {
            this.pendingReplans.length = 0
            return null
        }

        // Every sibling proposal was authored against this common boundary.
        // Validate that raw intent before any sibling can make an unknown id
        // accidentally valid, then reserve aliases only for valid mutations.
        const boundaryPrd = this.prd
        const immutableStoryIds = boundaryPrd.userStories
            .filter((story) => story.passes)
            .map((story) => story.id)
        const pending = this.pendingReplans.splice(0)
        const prepared = pending.map((replan) => {
            const mutation = policyReplanMutation(replan)
            return {
                replan,
                mutation,
                validation: validateRuntimeReplanMutation(
                    boundaryPrd,
                    mutation,
                    {
                        immutableStoryIds,
                        maxAddedStories: Number.MAX_SAFE_INTEGER,
                    },
                ),
            }
        })
        const invalid = prepared.filter((entry) => !entry.validation.ok)
        for (const entry of invalid) {
            const proposal = this.policyReplanProposal(
                entry.replan,
                entry.mutation,
                currentLevel,
            )
            const outcome = this.runtimeReplans.decide(proposal, {
                active: this.phase === "running",
                prd: boundaryPrd,
                immutableStoryIds,
                activeLease: undefined,
                adaptationsSinceProgress: this.runtimeAdaptationsSinceProgress,
                requireActiveLease: false,
                storyAccounting: "policy",
                maxAddedStories: Number.MAX_SAFE_INTEGER,
            })
            this.emitRejectedPolicyReplan(entry.replan, outcome, currentLevel)
        }

        const valid = prepared.filter(
            (entry): entry is typeof entry & {
                validation: Extract<RuntimeReplanValidationResult, { ok: true }>
            } => entry.validation.ok,
        )
        const siblingWriteConflicts = policySiblingWriteConflicts(
            valid.map((entry) => entry.mutation),
        )
        const compatible = valid.filter((entry, index) => {
            const targets = siblingWriteConflicts.get(index)
            if (!targets) return true

            const proposal = this.policyReplanProposal(
                entry.replan,
                entry.mutation,
                currentLevel,
            )
            const reason =
                `policy replan has an order-dependent sibling conflict on ` +
                `existing story id(s): ${JSON.stringify(targets)}`
            this.emitRejectedPolicyReplan(
                entry.replan,
                {
                    event: RuntimeReplanRejected.create({
                        runId: proposal.runId,
                        proposalId: proposal.proposalId,
                        sourceStoryId: proposal.sourceStoryId,
                        leaseId: proposal.leaseId,
                        generation: proposal.generation,
                        baseGraphVersion: proposal.baseGraphVersion,
                        currentGraphVersion: this.runtimeReplans.graphVersion,
                        code: "invalid_proposal",
                        reason,
                    }),
                },
                currentLevel,
            )
            return false
        })
        const reservedCandidates = reservePolicyReplanBatchIds(
            boundaryPrd.userStories.map((story) => story.id),
            compatible.map((entry) => entry.replan),
        ).map((reserved, index) => ({
            reserved,
            original: compatible[index]!.replan,
        }))
        const siblingCycleConflicts = policySiblingDependencyCycleConflicts(
            boundaryPrd,
            reservedCandidates.map(({ reserved }) =>
                policyReplanMutation(reserved.replan),
            ),
        )
        const cycleCompatible = reservedCandidates.filter(
            ({ reserved }, index) => {
                const targets = siblingCycleConflicts.get(index)
                if (!targets) return true

                const proposal = this.policyReplanProposal(
                    reserved.replan,
                    policyReplanMutation(reserved.replan),
                    currentLevel,
                )
                const reason =
                    `policy replan has an order-dependent sibling ` +
                    `dependency cycle involving story id(s): ` +
                    `${JSON.stringify(targets)}`
                this.emitRejectedPolicyReplan(
                    reserved.replan,
                    {
                        event: RuntimeReplanRejected.create({
                            runId: proposal.runId,
                            proposalId: proposal.proposalId,
                            sourceStoryId: proposal.sourceStoryId,
                            leaseId: proposal.leaseId,
                            generation: proposal.generation,
                            baseGraphVersion: proposal.baseGraphVersion,
                            currentGraphVersion:
                                this.runtimeReplans.graphVersion,
                            code: "invalid_proposal",
                            reason,
                        }),
                    },
                    currentLevel,
                )
                return false
            },
        )
        if (cycleCompatible.length > 0) {
            // A safe wave boundary is one logical healing cycle. Invalid
            // proposals above never consume or exhaust semantic healing.
            const halt = this.healingHaltReason()
            if (halt) {
                this.pendingReplans.unshift(
                    ...cycleCompatible.map(({ original }) => original),
                )
                return halt
            }
        }

        let appliedReplans = 0
        for (const { reserved } of cycleCompatible) {
            const replan = reserved.replan
            const proposal = this.policyReplanProposal(
                replan,
                policyReplanMutation(replan),
                currentLevel,
            )
            const outcome = this.runtimeReplans.decide(proposal, {
                active: this.phase === "running",
                prd: this.prd,
                immutableStoryIds: this.prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                activeLease: undefined,
                adaptationsSinceProgress: this.runtimeAdaptationsSinceProgress,
                requireActiveLease: false,
                storyAccounting: "policy",
                maxAddedStories: Number.MAX_SAFE_INTEGER,
            })
            if (!outcome.applied || !RuntimeReplanApplied.is(outcome.event)) {
                this.emitRejectedPolicyReplan(
                    replan,
                    outcome,
                    currentLevel,
                )
                continue
            }
            this.prd = outcome.applied.prd
            // Raw Surgeon Replan is a proposal in collective mode. Stateful
            // observers consume only this authoritative, persisted decision.
            this.emitGraphDecision(outcome.event)
            appliedReplans += 1
            if (replan.addedStories.length > 0) {
                for (const id of replan.removedStoryIds) {
                    this.failed.delete(id)
                    this.recoveryAborted.delete(id)
                }
            } else {
                for (const id of replan.removedStoryIds) this.dropped.add(id)
            }
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `collective applied replan from ${replan.source} at ` +
                        `graph v${outcome.event.data.graphVersion}: ${replan.reason}`,
                    currentLevel,
                }),
            )
        }
        if (appliedReplans > 0) {
            // Count the boundary, not each sibling symptom. Deliberately do
            // not halt after this increment: scheduleNextWave must first give
            // a newly unlocked prerequisite a chance to integrate and reset
            // the no-progress counter.
            this.noteHealingAction(currentLevel)
        }
        return null
    }

    private policyReplanProposal(
        replan: ReplanData,
        mutation: RuntimeReplanMutation,
        currentLevel: number,
    ): RuntimeReplanProposedData {
        const recovery = policyRecovery(replan)
        return {
            runId: this.opts.runId,
            proposalId:
                `${this.opts.runId}:policy-replan:` +
                randomUUID(),
            sourceStoryId:
                recovery.storyId ??
                firstPolicyTarget(mutation) ??
                `policy:${policyReplanSource(replan)}`,
            leaseId: recovery.leaseId ?? `${this.opts.runId}:policy`,
            generation: recovery.generation ?? currentLevel,
            // Policy replans are serialized at the safe wave boundary and
            // intentionally revalidate against the latest durable graph.
            baseGraphVersion: this.runtimeReplans.graphVersion,
            reason: policyReplanReason(replan),
            mutation,
        }
    }

    private emitRejectedPolicyReplan(
        replan: ReplanData,
        outcome: RuntimeReplanDecisionOutcome,
        currentLevel: number,
    ): void {
        // A policy proposal is still only a proposal. Publish its
        // authoritative rejection just like every other graph lane so replay,
        // telemetry, and operators see the same decision.
        this.emitGraphDecision(outcome.event)
        const detail = RuntimeReplanRejected.is(outcome.event)
            ? outcome.event.data.reason
            : "policy mutation was not applied"
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `collective rejected replan from ` +
                    `${policyReplanSource(replan)}: ${detail}`,
                currentLevel,
            }),
        )
    }

    private onRuntimeReplanProposed(
        source: Participant,
        proposal: RuntimeReplanProposedData,
    ): void {
        const nativeAuthorized = this.opts.outcomeAuthority?.matchesResultAuthority(
            source,
            {
                runId: proposal.runId,
                storyId: proposal.sourceStoryId,
                leaseId: proposal.leaseId,
                generation: proposal.generation,
            },
        ) ?? false
        const bridgeAuthorized =
            this.opts.runtimeReplanAuthority !== undefined &&
            source === this.opts.runtimeReplanAuthority
        // Most participant unit tests intentionally omit production
        // authorities. Production collective orchestration always supplies an
        // outcome registry and the collaboration bridge explicitly.
        const unboundTestMode =
            this.opts.unsafeAllowUnboundRuntimeReplanAuthority === true
        if (!nativeAuthorized && !bridgeAuthorized && !unboundTestMode) return
        this.decideRuntimeReplan(proposal)
    }

    private onConversationDelegationProposed(
        proposal: Parameters<typeof toRuntimeReplanProposal>[0],
    ): void {
        const validation = validateConversationDelegationProposal(proposal)
        if (!validation.ok) {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `collective rejected malformed conversation proposal ` +
                        `${proposal.proposalId || "(missing)"}: ${validation.reason}`,
                    currentLevel: this.wave?.ordinal,
                    storyIds: this.wave?.storyIds,
                }),
            )
            return
        }
        let runtimeProposal: RuntimeReplanProposedData
        try {
            runtimeProposal = toRuntimeReplanProposal(validation.proposal)
        } catch (error) {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `collective rejected malformed conversation proposal ` +
                        `${proposal.proposalId || "(missing)"}: ${messageOf(error)}`,
                    currentLevel: this.wave?.ordinal,
                    storyIds: this.wave?.storyIds,
                }),
            )
            return
        }
        this.decideRuntimeReplan(runtimeProposal, {
            requireActiveLease: false,
        })
    }

    private onGoalInvariantRemediationProposed(
        remediation: GoalInvariantRemediationProposedData,
        scheduleAfterAdmission = true,
    ): void {
        if (
            !this.prd ||
            (this.phase !== "preparing" &&
                this.phase !== "running" &&
                this.phase !== "verifying")
        ) return
        const contract = deriveGoalContract(this.prd.goalEnvelope)
        const invariant = contract?.invariants.find(
            ({ id }) => id === remediation.invariantId,
        )
        if (
            !contract ||
            remediation.contractId !== contract.contractId ||
            !invariant ||
            remediation.story.goalInvariantIds?.length !== 1 ||
            remediation.story.goalInvariantIds[0] !== invariant.id
        ) return

        const existing = this.prd.userStories.find(
            ({ id }) => id === remediation.story.id,
        )
        if (existing) {
            if (!sameRemediationStory(existing, remediation.story)) {
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail:
                            `collective rejected goal remediation ` +
                            `${remediation.challengeId}: story id collision`,
                        currentLevel: this.wave?.ordinal,
                    }),
                )
                return
            }
            this.pendingGoalRemediations.delete(remediation.proposalId)
            this.pendingGoalRemediationFailures.delete(remediation.proposalId)
            if (this.pendingGoalRemediations.size === 0) {
                this.clearGoalRemediationRetryTimer()
            }
            this.emitGoalRemediationAdmitted(
                remediation,
                this.runtimeReplans.graphVersion,
                "existing",
            )
            return
        }

        // GoalGuardian can react to RunStarted/PlanningStreamClosed in the
        // same Mozaik fan-out in which an empty settled graph asks for final
        // verification. A valid new contract obligation supersedes that
        // verification snapshot; stale verifier/attestation replies are
        // source-correlated and ignored after these ids are cleared.
        this.resumeRunningForGoalRemediation(remediation)

        const halt = this.healingHaltReason()
        if (halt) {
            if (this.softDeadlineReason() === null) {
                this.queueGoalRemediation(remediation, halt, false)
            }
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail: this.softDeadlineReason()
                        ? `collective could not admit goal remediation ` +
                          `${remediation.challengeId}: ${halt}`
                        : `collective deferred goal remediation ` +
                          `${remediation.challengeId} until the next ` +
                          `integrated-story progress checkpoint: ${halt}`,
                    currentLevel: this.wave?.ordinal,
                }),
            )
            if (!this.wave) {
                if (this.softDeadlineReason() !== null) this.requestPush(halt)
                else this.scheduleNextWave()
            }
            return
        }
        const proposal: RuntimeReplanProposedData = {
            runId: this.opts.runId,
            proposalId: remediation.proposalId,
            sourceStoryId: `goal:${remediation.challengeId}`,
            leaseId: `${this.opts.runId}:goal-guardian`,
            generation: 0,
            baseGraphVersion: this.runtimeReplans.graphVersion,
            reason:
                `autonomous remediation for ${remediation.invariantId}: ` +
                remediation.reason,
            mutation: {
                addedStories: [remediation.story],
                removedStoryIds: [],
                modifiedDeps: {},
            },
        }
        const outcome = this.runtimeReplans.decide(proposal, {
            active: true,
            prd: this.prd,
            immutableStoryIds: this.runtimeImmutableStoryIds(),
            activeLease: undefined,
            adaptationsSinceProgress: this.runtimeAdaptationsSinceProgress,
            requireActiveLease: false,
            storyAccounting: "policy",
            maxAddedStories: 1,
        })
        if (!outcome.applied || !RuntimeReplanApplied.is(outcome.event)) {
            if (
                RuntimeReplanRejected.is(outcome.event) &&
                (outcome.event.data.code === "stale_graph_version" ||
                    outcome.event.data.code === "persistence_failed" ||
                    outcome.event.data.code === "adaptation_budget_exhausted")
            ) {
                const retryable =
                    outcome.event.data.code === "stale_graph_version" ||
                    outcome.event.data.code === "persistence_failed"
                this.queueGoalRemediation(
                    remediation,
                    outcome.event.data.reason,
                    retryable,
                )
            }
            this.emitGraphDecision(outcome.event)
            if (!this.wave && this.phase === "running") {
                if (
                    this.pendingGoalRemediationFailures.get(
                        remediation.proposalId,
                    )?.retryable
                ) {
                    this.scheduleGoalRemediationRetry()
                } else {
                    this.scheduleNextWave()
                }
            }
            return
        }
        this.pendingGoalRemediations.delete(remediation.proposalId)
        this.pendingGoalRemediationFailures.delete(remediation.proposalId)
        if (this.pendingGoalRemediations.size === 0) {
            this.clearGoalRemediationRetryTimer()
        }
        this.prd = outcome.applied.prd
        this.emitGraphDecision(outcome.event)
        this.noteHealingAction(this.wave?.ordinal ?? this.waveOrdinal)
        this.emitGoalRemediationAdmitted(
            remediation,
            outcome.event.data.graphVersion,
            "applied",
        )
        if (scheduleAfterAdmission && this.phase === "running") {
            if (this.wave) this.reconcileReadyStories()
            else this.scheduleNextWave()
        }
    }

    private emitGoalRemediationAdmitted(
        remediation: GoalInvariantRemediationProposedData,
        graphVersion: number,
        disposition: "applied" | "existing",
    ): void {
        this.emit(
            GoalInvariantRemediationAdmitted.create({
                runId: this.opts.runId,
                contractId: remediation.contractId,
                challengeId: remediation.challengeId,
                invariantId: remediation.invariantId,
                proposalId: remediation.proposalId,
                storyId: remediation.story.id,
                graphVersion,
                disposition,
            }),
        )
    }

    private retryPendingGoalRemediations(afterIntegratedProgress = false): void {
        if (this.pendingGoalRemediations.size === 0) return
        const pending = [...this.pendingGoalRemediations.values()].filter(
            ({ proposalId }) => {
                const failure = this.pendingGoalRemediationFailures.get(proposalId)
                return afterIntegratedProgress ||
                    (failure?.retryable === true &&
                        failure.attempts <
                            MAX_GOAL_REMEDIATION_ADMISSION_ATTEMPTS)
            },
        )
        for (const remediation of pending) {
            this.pendingGoalRemediations.delete(remediation.proposalId)
            this.onGoalInvariantRemediationProposed(remediation, false)
        }
    }

    private queueGoalRemediation(
        remediation: GoalInvariantRemediationProposedData,
        reason: string,
        retryable: boolean,
    ): void {
        const prior = this.pendingGoalRemediationFailures.get(
            remediation.proposalId,
        )
        this.pendingGoalRemediations.set(
            remediation.proposalId,
            structuredClone(remediation),
        )
        this.pendingGoalRemediationFailures.set(remediation.proposalId, {
            reason,
            retryable,
            attempts: retryable
                ? (prior?.attempts ?? 0) + 1
                : (prior?.attempts ?? 0),
        })
    }

    private resumeRunningForGoalRemediation(
        remediation: GoalInvariantRemediationProposedData,
    ): void {
        if (this.phase !== "verifying") return
        this.clearVerificationTimer()
        this.clearGoalCompletionTimer()
        this.pendingVerificationId = null
        this.pendingGoalCheck = null
        this.verificationStatus = undefined
        this.verification = undefined
        this.phase = "running"
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `goal remediation ${remediation.challengeId} invalidated ` +
                    "the older verification snapshot",
                currentLevel: this.waveOrdinal,
            }),
        )
    }

    private scheduleGoalRemediationRetry(): void {
        if (this.goalRemediationRetryTimer || this.phase !== "running") return
        const hasRetryable = [...this.pendingGoalRemediations.keys()].some(
            (proposalId) => {
                const failure = this.pendingGoalRemediationFailures.get(proposalId)
                return failure?.retryable === true &&
                    failure.attempts <
                        MAX_GOAL_REMEDIATION_ADMISSION_ATTEMPTS
            },
        )
        if (!hasRetryable) return
        this.goalRemediationRetryTimer = setTimeout(() => {
            this.goalRemediationRetryTimer = null
            this.retryPendingGoalRemediations(false)
            if (this.phase === "running" && !this.wave) {
                this.scheduleNextWave()
            }
        }, 0)
    }

    private clearGoalRemediationRetryTimer(): void {
        if (this.goalRemediationRetryTimer) {
            clearTimeout(this.goalRemediationRetryTimer)
        }
        this.goalRemediationRetryTimer = null
    }

    private decideRuntimeReplan(
        proposal: RuntimeReplanProposedData,
        options: { requireActiveLease?: boolean } = {},
    ): void {
        if (this.progressivePlanning.isFailed()) return
        const queued: QueuedRuntimeReplan = {
            proposal: structuredClone(proposal),
            fingerprint: runtimeProposalFingerprint(proposal),
            requireActiveLease: options.requireActiveLease !== false,
        }
        const duplicate = [
            ...(this.stagedRuntimeReplan ? [this.stagedRuntimeReplan] : []),
            ...this.runtimeReplanQueue,
        ].some(
            (candidate) =>
                candidate.proposal.proposalId === proposal.proposalId &&
                candidate.fingerprint === queued.fingerprint,
        )
        if (duplicate) return
        this.runtimeReplanQueue.push(queued)
        this.drainRuntimeReplanQueue()
    }

    private drainRuntimeReplanQueue(): void {
        if (this.stagedRuntimeReplan || this.progressivePlanning.isFailed()) return
        for (;;) {
            const queued = this.runtimeReplanQueue.shift()
            if (!queued) return
            const targetIds = runtimeReplanTargetIds(queued.proposal)
            const offers = [...targetIds]
                .map((storyId) => this.activeOffers.get(storyId))
                .filter((offer): offer is ActiveWorkOffer => offer !== undefined)
            if (offers.length === 0) {
                this.executeRuntimeReplan(queued)
                continue
            }

            const stageId =
                `${this.opts.runId}:runtime-replan-stage:` +
                `${++this.runtimeReplanStageSequence}`
            const staged: StagedRuntimeReplan = {
                ...queued,
                stageId,
                retractions: new Map(),
            }
            for (const offer of offers) {
                const data = offer.data
                const request: WorkOfferRetractionRequestedData = {
                    runId: this.opts.runId,
                    proposalId: queued.proposal.proposalId,
                    retractionId: `${stageId}:${data.offerId}`,
                    offerId: data.offerId,
                    storyId: data.request.storyId,
                    generation: data.generation,
                    graphVersion: this.runtimeReplans.graphVersion,
                }
                staged.retractions.set(request.retractionId, { request })
            }
            this.stagedRuntimeReplan = staged
            this.armOfferRetractionTimer(staged)
            for (const { request } of staged.retractions.values()) {
                this.emit(WorkOfferRetractionRequested.create(request))
            }
            return
        }
    }

    private executeRuntimeReplan(
        queued: QueuedRuntimeReplan,
        additionalImmutableStoryIds: Iterable<string> = [],
        retractedStoryIds: readonly string[] = [],
    ): RuntimeReplanDecisionOutcome {
        const { proposal, requireActiveLease } = queued
        const lease = this.leases.get(proposal.sourceStoryId)
        const immutableStoryIds = this.runtimeImmutableStoryIds()
        for (const storyId of additionalImmutableStoryIds) {
            immutableStoryIds.add(storyId)
        }
        const outcome = this.runtimeReplans.decide(proposal, {
            active: this.phase === "running",
            prd: this.prd,
            immutableStoryIds,
            activeLease: requireActiveLease && lease
                ? {
                      leaseId: lease.leaseId,
                      generation: lease.generation,
                  }
                : undefined,
            adaptationsSinceProgress: this.runtimeAdaptationsSinceProgress,
            requireActiveLease,
        })
        if (outcome.applied && RuntimeReplanApplied.is(outcome.event)) {
            // The coordinator has already crossed the durable commit boundary;
            // swap the Board snapshot before any observer can react to Applied.
            this.prd = outcome.applied.prd
            this.emitGraphDecision(outcome.event)
            this.noteRuntimeAdaptation(this.wave?.ordinal ?? this.waveOrdinal)
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `collective applied runtime graph ` +
                        `v${outcome.event.data.previousGraphVersion}→` +
                        `v${outcome.event.data.graphVersion} from ` +
                        `${proposal.sourceStoryId}: ${proposal.reason}`,
                    currentLevel: this.wave?.ordinal,
                    storyIds: this.wave?.storyIds,
                }),
            )
            this.reconcileRuntimeGraphApplication(outcome.applied)
            return outcome
        }
        this.emitGraphDecision(outcome.event)
        if (RuntimeReplanRejected.is(outcome.event)) {
            this.emitRuntimeReplanRejectionState(
                proposal.proposalId,
                outcome.event.data.reason,
            )
        }
        // A replayed Applied has no new durable snapshot. If its offer was
        // retracted merely to discover that replay, restore the unchanged work.
        this.restoreRetractedStories([
            ...runtimeReplanTargetIds(proposal),
            ...retractedStoryIds,
        ])
        return outcome
    }

    private onWorkOfferRetractionResolved(
        resolution: WorkOfferRetractionResolvedData,
    ): void {
        const staged = this.stagedRuntimeReplan
        const entry = staged?.retractions.get(resolution.retractionId)
        if (staged && entry) {
            if (
                entry.resolution ||
                !sameOfferRetractionCorrelation(entry.request, resolution)
            ) return
            entry.resolution = structuredClone(resolution)
            if (resolution.disposition === "retracted") {
                const active = this.activeOffers.get(resolution.storyId)
                if (active?.data.offerId === resolution.offerId) {
                    this.activeOffers.delete(resolution.storyId)
                }
            }
            if (
                [...staged.retractions.values()].every(
                    (candidate) => candidate.resolution !== undefined,
                )
            ) {
                this.finishStagedRuntimeReplan(staged)
            }
            return
        }

        const abandoned = this.abandonedOfferRetractions.get(
            resolution.retractionId,
        )
        if (
            !abandoned ||
            !sameOfferRetractionCorrelation(abandoned, resolution)
        ) return
        this.abandonedOfferRetractions.delete(resolution.retractionId)
        if (resolution.disposition !== "retracted") return
        const active = this.activeOffers.get(resolution.storyId)
        if (active?.data.offerId === resolution.offerId) {
            this.activeOffers.delete(resolution.storyId)
        }
        this.restoreRetractedStories([resolution.storyId])
    }

    private finishStagedRuntimeReplan(staged: StagedRuntimeReplan): void {
        if (this.stagedRuntimeReplan !== staged) return
        this.clearOfferRetractionTimer()
        this.stagedRuntimeReplan = null
        const resolutions = [...staged.retractions.values()].map(
            ({ resolution }) => resolution!,
        )
        const retractedStoryIds = resolutions
            .filter(({ disposition }) => disposition === "retracted")
            .map(({ storyId }) => storyId)
        const leasedStoryIds = resolutions
            .filter(({ disposition }) => disposition === "leased")
            .map(({ storyId }) => storyId)

        this.executeRuntimeReplan(
            staged,
            leasedStoryIds,
            retractedStoryIds,
        )
        this.drainRuntimeReplanQueue()
    }

    private armOfferRetractionTimer(staged: StagedRuntimeReplan): void {
        this.clearOfferRetractionTimer()
        const configured = this.opts.offerRetractionTimeoutMs ?? 5_000
        const timeoutMs =
            Number.isFinite(configured) && configured > 0
                ? Math.max(1, Math.floor(configured))
                : 5_000
        this.offerRetractionTimer = setTimeout(() => {
            this.emit(
                RuntimeReplanRetractionTimedOut.create({
                    runId: this.opts.runId,
                    stageId: staged.stageId,
                    proposalId: staged.proposal.proposalId,
                }),
            )
        }, timeoutMs)
    }

    private clearOfferRetractionTimer(): void {
        if (this.offerRetractionTimer) clearTimeout(this.offerRetractionTimer)
        this.offerRetractionTimer = null
    }

    private onRuntimeReplanRetractionTimedOut(
        timeout: RuntimeReplanRetractionTimedOutData,
    ): void {
        const staged = this.stagedRuntimeReplan
        if (
            !staged ||
            staged.stageId !== timeout.stageId ||
            staged.proposal.proposalId !== timeout.proposalId
        ) return
        this.clearOfferRetractionTimer()
        this.stagedRuntimeReplan = null
        const retractedStoryIds: string[] = []
        for (const entry of staged.retractions.values()) {
            if (entry.resolution?.disposition === "retracted") {
                retractedStoryIds.push(entry.request.storyId)
            } else if (!entry.resolution) {
                this.abandonedOfferRetractions.set(
                    entry.request.retractionId,
                    entry.request,
                )
            }
        }
        const reason =
            `offer retraction timed out before the Broker resolved every ` +
            `targeted story; the runtime graph was not changed`
        this.emitGraphDecision(
            RuntimeReplanRejected.create({
                runId: staged.proposal.runId,
                proposalId: staged.proposal.proposalId,
                sourceStoryId: staged.proposal.sourceStoryId,
                leaseId: staged.proposal.leaseId,
                generation: staged.proposal.generation,
                baseGraphVersion: staged.proposal.baseGraphVersion,
                currentGraphVersion: this.runtimeReplans.graphVersion,
                code: "offer_retraction_failed",
                reason,
            }),
        )
        this.emitRuntimeReplanRejectionState(
            staged.proposal.proposalId,
            reason,
        )
        this.restoreRetractedStories([
            ...runtimeReplanTargetIds(staged.proposal),
            ...retractedStoryIds,
        ])
        this.drainRuntimeReplanQueue()
    }

    private emitRuntimeReplanRejectionState(
        proposalId: string,
        reason: string,
    ): void {
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `collective rejected runtime replan ` +
                    `${proposalId || "(missing)"}: ${reason}`,
                currentLevel: this.wave?.ordinal,
                storyIds: this.wave?.storyIds,
            }),
        )
    }

    private runtimeImmutableStoryIds(): Set<string> {
        const immutable = new Set<string>([
            ...this.completed,
            ...this.failed,
            ...this.leases.keys(),
            ...this.pendingQuality.keys(),
            ...this.pendingRecovery,
            ...this.recoveryContext.keys(),
        ])
        for (const story of this.prd?.userStories ?? []) {
            if (story.passes) immutable.add(story.id)
        }
        for (const cleanup of this.pendingCleanup.values()) {
            immutable.add(cleanup.storyId)
        }
        return immutable
    }

    private onWorkLeaseGranted(grant: WorkLeaseGrantedData): void {
        const storyId = grant.request.storyId
        const offer = this.activeOffers.get(storyId)
        if (
            !offer ||
            offer.data.runId !== grant.runId ||
            offer.data.offerId !== grant.offerId ||
            offer.data.generation !== grant.generation ||
            !isDeepStrictEqual(offer.data.request, grant.request)
        ) return
        this.activeOffers.delete(storyId)
        this.leases.set(storyId, {
            leaseId: grant.leaseId,
            generation: grant.generation,
            workerId: grant.workerId,
            ...(grant.route ? { route: { ...grant.route } } : {}),
            supportsCooperativeSuspend:
                grant.supportsCooperativeSuspend === true,
        })
    }

    private runtimeReplanTargetsStory(storyId: string): boolean {
        return runtimeReplanTargetIds(
            this.stagedRuntimeReplan?.proposal,
        ).has(storyId)
    }

    private isOfferAwaitingRetraction(offerId: string): boolean {
        for (const entry of this.stagedRuntimeReplan?.retractions.values() ?? []) {
            if (entry.request.offerId === offerId) return true
        }
        return false
    }

    private consumeAbandonedOfferRetractions(offerId: string): boolean {
        let consumed = false
        for (const [retractionId, request] of this.abandonedOfferRetractions) {
            if (request.offerId !== offerId) continue
            this.abandonedOfferRetractions.delete(retractionId)
            consumed = true
        }
        return consumed
    }

    private restoreRetractedStories(storyIds: readonly string[]): void {
        if (this.phase !== "running" || !this.prd || !this.wave) return
        const currentById = new Map(
            this.prd.userStories.map((story) => [story.id, story]),
        )
        for (const storyId of new Set(storyIds)) {
            const story = currentById.get(storyId)
            if (
                !story ||
                story.passes ||
                !this.wave.pending.has(storyId) ||
                this.leases.has(storyId) ||
                this.activeOffers.has(storyId) ||
                this.hasContextRequest(storyId) ||
                this.runtimeReplanTargetsStory(storyId) ||
                !story.dependsOn.every(
                    (dependency) => currentById.get(dependency)?.passes === true,
                )
            ) continue
            this.requestStoryContext(story)
        }
    }

    private reconcileRuntimeGraphApplication(
        applied: NonNullable<RuntimeReplanDecisionOutcome["applied"]>,
    ): void {
        if (!this.wave) {
            this.scheduleNextWave()
            return
        }
        const rescheduled = new Set([
            ...applied.removedStoryIds,
            ...applied.modifiedStoryIds,
        ])
        for (const storyId of rescheduled) {
            this.cancelContextRequests(storyId)
            this.activeOffers.delete(storyId)
            if (
                this.wave.pending.has(storyId) &&
                !this.leases.has(storyId) &&
                !this.pendingQuality.has(storyId)
            ) {
                this.wave.pending.delete(storyId)
                this.wave.storyIds = this.wave.storyIds.filter(
                    (candidate) => candidate !== storyId,
                )
            }
        }
        this.reconcileReadyStories()
        this.maybeCompleteWave()
    }

    private hasContextRequest(storyId: string): boolean {
        for (const story of this.contextRequests.values()) {
            if (story.id === storyId) return true
        }
        return false
    }

    private cancelContextRequests(storyId: string): void {
        for (const [requestId, story] of this.contextRequests) {
            if (story.id === storyId) this.contextRequests.delete(requestId)
        }
    }

    /** Project runnable work continuously from the accepted graph. A DAG level
     * is a display/checkpoint concept, not a barrier: when one prerequisite
     * integrates, its dependents may start while unrelated siblings continue. */
    private reconcileReadyStories(): void {
        if (this.phase !== "running" || !this.prd || !this.wave) return
        const storyById = new Map(this.prd.userStories.map((story) => [story.id, story]))
        const scheduled = new Set(this.wave.storyIds)
        const blocked = this.computeBlockedStoryIds()
        const ready = this.prd.userStories.filter(
            (story) =>
                !story.passes &&
                !scheduled.has(story.id) &&
                !this.failed.has(story.id) &&
                !blocked.has(story.id) &&
                story.dependsOn.every(
                    (dependency) => storyById.get(dependency)?.passes === true,
                ),
        )
        if (ready.length === 0) return
        ready.sort(
            (left, right) =>
                left.priority - right.priority || left.id.localeCompare(right.id),
        )
        for (const story of ready) {
            this.wave.storyIds.push(story.id)
            this.wave.pending.add(story.id)
            this.requestStoryContext(story)
        }
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: `collective admitted ${ready.map((story) => story.id).join(", ")} as soon as their dependencies were integrated`,
                currentLevel: this.wave.ordinal,
                storyIds: this.wave.storyIds,
            }),
        )
    }

    private onWorkDiscovered(discovery: WorkDiscoveredData): void {
        if (this.phase !== "running" || !this.prd) return
        const lease = this.leases.get(discovery.sourceAgentId)
        if (
            !lease ||
            lease.leaseId !== discovery.leaseId ||
            lease.generation !== discovery.generation
        ) {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail: `collective rejected discovered work ${discovery.story.id || "(missing id)"}: source lease is inactive or stale`,
                    currentLevel: this.wave?.ordinal,
                }),
            )
            return
        }
        const story = discovery.story
        this.decideRuntimeReplan({
            runId: this.opts.runId,
            proposalId:
                `${this.opts.runId}:discovery:${++this.discoverySequence}:` +
                `${discovery.sourceAgentId}:${story.id || "missing"}`,
            sourceStoryId: discovery.sourceAgentId,
            leaseId: lease.leaseId,
            generation: lease.generation,
            baseGraphVersion: this.runtimeReplans.graphVersion,
            reason: discovery.reason,
            mutation: {
                removedStoryIds: [],
                modifiedDeps: {},
                addedStories: [
                    {
                        id: story.id,
                        priority:
                            story.priority ??
                            this.prd.userStories.length + 1,
                        title: story.title,
                        description: story.description,
                        dependsOn: [...story.dependsOn],
                        retries: story.retries ?? 1,
                        acceptance: [...story.acceptance],
                        tests: [...story.tests],
                        ...(story.goalInvariantIds
                            ? { goalInvariantIds: [...story.goalInvariantIds] }
                            : {}),
                        model: story.model,
                    },
                ],
            },
        })
    }

    private scheduleNextWave(): void {
        if (this.phase !== "running" || !this.prd || this.wave) return

        const planningLatch = this.progressivePlanning.scheduleLatch()
        if (planningLatch?.status === "failed") {
            this.requestPush(
                `progressive planning failed: ${planningLatch.reason}`,
            )
            return
        }
        const deadline = this.softDeadlineReason()
        if (deadline) {
            this.requestPush(deadline)
            return
        }

        const blocked = this.computeBlockedStoryIds()
        const runnable = this.prd.userStories.filter(
            (story) =>
                !story.passes &&
                !this.failed.has(story.id) &&
                !blocked.has(story.id),
        )

        let levels
        try {
            const runnableIds = new Set(runnable.map((story) => story.id))
            levels = buildDag(
                this.prd.userStories.filter(
                    (story) => story.passes || runnableIds.has(story.id),
                ),
                { onlyIncomplete: true },
            )
        } catch (error) {
            this.terminate(false, messageOf(error))
            return
        }
        if (levels.length > 0) {
            const deadline = this.softDeadlineReason()
            if (deadline) {
                this.requestPush(deadline)
                return
            }
            const ids = new Set(levels[0].storyIds)
            this.startWave(
                runnable.filter((story) => ids.has(story.id)),
                false,
                this.waveOrdinal + levels.length,
            )
            return
        }

        const capacityRecovery = this.prd.userStories.filter((story) =>
            !story.passes &&
            this.failed.has(story.id) &&
            this.capacityRecoveryPending.has(story.id) &&
            !this.recoveryAborted.has(story.id) &&
            !this.unclaimable.has(story.id) &&
            !this.unmergeable.has(story.id),
        )
        if (capacityRecovery.length > 0) {
            const deadline = this.softDeadlineReason()
            if (deadline) {
                this.requestPush(deadline)
                return
            }
            for (const story of capacityRecovery) {
                this.capacityRecoveryPending.delete(story.id)
                this.capacityRerouteAttempts.set(
                    story.id,
                    (this.capacityRerouteAttempts.get(story.id) ?? 0) + 1,
                )
                this.failed.delete(story.id)
            }
            // Route exclusions grow monotonically, so this path is bounded by
            // the finite configured market rather than the Surgeon budget.
            this.startWave(capacityRecovery, true, this.waveOrdinal + 1)
            return
        }

        const pendingOperationalRecovery = this.prd.userStories.filter((story) =>
            !story.passes &&
            this.failed.has(story.id) &&
            this.operationalRecovery.isPending(story.id) &&
            !this.recoveryAborted.has(story.id) &&
            !this.unclaimable.has(story.id) &&
            !this.unmergeable.has(story.id),
        )
        const operationalRecovery = pendingOperationalRecovery.filter((story) =>
            this.operationalRecovery.isReady(story.id),
        )
        if (operationalRecovery.length > 0) {
            const deadline = this.softDeadlineReason()
            if (deadline) {
                this.requestPush(deadline)
                return
            }
            for (const story of operationalRecovery) {
                this.operationalRecovery.startRetry(story.id)
                this.failed.delete(story.id)
            }
            // Operational retries preserve work but do not count as semantic
            // healing and never consume the runtime-reorganization budget.
            this.startWave(operationalRecovery, true, this.waveOrdinal + 1)
            return
        }
        if (pendingOperationalRecovery.length > 0) {
            const deadline = this.softDeadlineReason()
            if (deadline) {
                this.requestPush(deadline)
                return
            }
            const delay = this.operationalRecovery.nextReadyDelay(
                pendingOperationalRecovery.map((story) => story.id),
            )
            if (delay !== null) {
                this.scheduleOperationalRetry(
                    Math.min(delay, this.softDeadlineRemainingMs()),
                )
                return
            }
        }

        const recovery = this.prd.userStories.filter((story) => {
            if (story.passes || !this.failed.has(story.id)) return false
            if (this.recoveryAborted.has(story.id)) return false
            if (this.unclaimable.has(story.id) || this.unmergeable.has(story.id)) return false
            const attempts = this.recoveryAttempts.get(story.id) ?? 0
            return attempts < (this.opts.maxRecoveryAttemptsPerStory ?? 1)
        })
        if (recovery.length > 0) {
            const halt = this.healingHaltReason()
            if (halt) {
                this.requestPush(halt)
                return
            }
            this.noteHealingAction(this.waveOrdinal)
            for (const story of recovery) {
                this.recoveryAttempts.set(
                    story.id,
                    (this.recoveryAttempts.get(story.id) ?? 0) + 1,
                )
                this.failed.delete(story.id)
            }
            this.startWave(recovery, true, this.waveOrdinal + 1)
            return
        }

        if (planningLatch?.status === "open") {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail:
                        `all currently admitted work is settled; waiting for ` +
                        `progressive planner fragment ${planningLatch.nextOrdinal}`,
                    currentLevel: this.waveOrdinal,
                }),
            )
            return
        }

        // Contract-required work is a finalization latch. A transient graph
        // CAS/persistence failure gets a bounded asynchronous retry; a
        // progress-gated or exhausted proposal fails explicitly instead of
        // letting an older goal/verification snapshot reach push.
        if (this.pendingGoalRemediations.size > 0) {
            this.scheduleGoalRemediationRetry()
            if (this.goalRemediationRetryTimer) {
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail:
                            "waiting for required goal remediation admission retry",
                        currentLevel: this.waveOrdinal,
                    }),
                )
                return
            }
            const reasons = [...this.pendingGoalRemediations.keys()]
                .map((proposalId) =>
                    this.pendingGoalRemediationFailures.get(proposalId)?.reason,
                )
                .filter((reason): reason is string => Boolean(reason))
            this.requestPush(
                `collective could not admit required goal remediation: ` +
                    (reasons.join("; ") || "admission retry budget exhausted"),
            )
            return
        }

        const incomplete = this.prd.userStories.filter((story) => !story.passes)
        if (incomplete.length > 0 || this.dropped.size > 0) {
            this.requestPush(
                `collective run stopped with incomplete stories: ${incomplete.map((story) => story.id).join(", ") || "dropped work"}`,
            )
            return
        }
        this.requestVerification(null)
    }

    private startWave(
        stories: PrdStory[],
        recovery: boolean,
        totalLevelsHint: number,
    ): void {
        if (!this.prd || stories.length === 0) return
        const ordinal = ++this.waveOrdinal
        const storyIds = stories.map((story) => story.id)
        for (const storyId of storyIds) {
            this.pendingRecovery.delete(storyId)
            this.recoveryDecided.delete(storyId)
        }
        this.wave = {
            ordinal,
            storyIds,
            pending: new Set(storyIds),
            passed: [],
            failed: [],
            blocked: [],
            recovery,
        }
        if (recovery) {
            this.emit(
                RecoveryStarted.create({
                    attempt: Math.max(
                        ...stories.map((story) =>
                            Math.max(
                                this.recoveryAttempts.get(story.id) ?? 0,
                                this.capacityRerouteAttempts.get(story.id) ?? 0,
                                this.operationalRecovery.attempts(story.id),
                                1,
                            ),
                        ),
                    ),
                    storyIds,
                }),
            )
        }
        this.emit(
            LevelStarted.create({
                ordinal,
                totalLevelsHint,
                storyIds,
            }),
        )
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: recovery ? "collective recovery wave" : "collective work wave",
                currentLevel: ordinal,
                totalLevels: totalLevelsHint,
                storyIds,
            }),
        )

        for (const story of stories) this.requestStoryContext(story)
    }

    private requestStoryContext(story: PrdStory): void {
        if (
            this.hasContextRequest(story.id) ||
            this.activeOffers.has(story.id) ||
            this.leases.has(story.id) ||
            this.runtimeReplanTargetsStory(story.id)
        ) return
        const requestId = `${this.opts.runId}:context:${++this.contextSequence}:${story.id}`
        this.contextRequests.set(requestId, story)
        this.emit(
            WorkContextRequested.create({
                runId: this.opts.runId,
                requestId,
                storyId: story.id,
                hints: [
                    ...tokens(story.title),
                    ...tokens(story.description).slice(0, 8),
                ],
            }),
        )
    }

    private offerStory(story: PrdStory, context: string | null): void {
        if (
            !this.wave?.pending.has(story.id) ||
            this.activeOffers.has(story.id) ||
            this.leases.has(story.id) ||
            this.runtimeReplanTargetsStory(story.id)
        ) return
        const offerId = `${this.opts.runId}:offer:${++this.offerSequence}:${story.id}`
        const basePrompt = this.storyPrompt(story)
        const rememberedRecovery = this.recoveryContext.get(story.id)
        const recovery =
            this.wave?.recovery || rememberedRecovery?.kind === "dependency"
                ? rememberedRecovery
                : undefined
        const recoveryPrompt = recovery
            ? [
                  recovery.kind === "dependency"
                      ? "## Resumed after dependency integration"
                      : "## Recovery attempt",
                  "",
                  recovery.kind === "dependency"
                      ? `The previous attempt cooperatively paused: ${recovery.reason}`
                      : `The previous ${recovery.kind} attempt failed: ${recovery.reason}`,
                  recovery.branch
                      ? `This fresh worktree starts at the latest integrated run branch. The rejected attempt is preserved at ${recovery.branch}. Inspect \`git diff HEAD...${recovery.branch}\` and \`git show ${recovery.branch}\`, then reapply its intent while preserving already-integrated work. Do not merge or cherry-pick the backup wholesale. Run the required checks and commit the reconciled result.`
                      : "Re-run the story from the current integrated repository state, address the failure, run the required checks, and commit the corrected work.",
              ].join("\n")
            : null
        const prompt = [context?.trim() || null, recoveryPrompt, basePrompt]
            .filter((part): part is string => Boolean(part))
            .join("\n\n")
        const excludedRouteIds = [
            ...new Set([
                ...this.unavailableMarketRouteIds,
                ...this.operationalRecovery.exclusions(story.id),
            ]),
        ].sort()
        const offered = WorkOffered.create({
            runId: this.opts.runId,
            offerId,
            generation: this.wave?.ordinal ?? this.waveOrdinal,
            priority: story.priority,
            ...(excludedRouteIds.length > 0 ? { excludedRouteIds } : {}),
            request: {
                storyId: story.id,
                prompt,
                model:
                    this.opts.overrideModel ??
                    story.model ??
                    this.opts.defaultModel ??
                    "sonnet",
                retries: story.retries,
                timeoutSecs: this.opts.timeoutSecs,
                graphVersion: this.runtimeReplans.graphVersion,
                ...(this.opts.expectQualityDecisions &&
                story.acceptance.length > 0
                    ? { requiresQualityReview: true }
                    : {}),
                ...(recovery ? { recovery } : {}),
            },
        })
        this.activeOffers.set(story.id, {
            data: structuredClone(offered.data),
        })
        this.emit(offered)
    }

    private storyPrompt(story: PrdStory): string {
        const sections: string[] = []
        const contract = deriveGoalContract(this.prd?.goalEnvelope)
        if (contract) {
            sections.push(
                "## Global goal contract",
                "",
                renderGoalContractPrompt(contract, story.goalInvariantIds ?? []),
                "",
                "---",
                "",
            )
        }
        const document = this.prd?.decisionDocument?.trim()
        if (document) {
            sections.push(
                "## Current shared design decision",
                "",
                "This is the Architect's evidence-backed baseline, not an override of the global goal. Preserve it unless repository evidence proves an amendment is required; propose that amendment through the collective rather than silently diverging.",
                "",
                document,
                "",
                "---",
                "",
            )
        }
        sections.push(buildDefaultStoryPrompt(story))
        return sections.join("\n")
    }

    private computeBlockedStoryIds(): Set<string> {
        if (!this.prd || this.failed.size === 0) return new Set()
        const blocked = new Set<string>()
        let changed = true
        while (changed) {
            changed = false
            for (const story of this.prd.userStories) {
                if (story.passes || this.failed.has(story.id) || blocked.has(story.id)) {
                    continue
                }
                if (story.dependsOn.some((id) => this.failed.has(id) || blocked.has(id))) {
                    blocked.add(story.id)
                    changed = true
                }
            }
        }
        return blocked
    }

    private finishAfterPush(): void {
        if (this.phase !== "pushing" || !this.prd) return
        const incomplete = this.prd.userStories.filter((story) => !story.passes)
        const goalCompletionFailure = this.goalCompletionFailureReason()
        const success =
            this.stopReason === null &&
            incomplete.length === 0 &&
            this.dropped.size === 0 &&
            goalCompletionFailure === null
        const reason =
            this.stopReason ??
            goalCompletionFailure ??
            (success
                ? null
                : `collective run stopped with incomplete stories: ${incomplete.map((story) => story.id).join(", ") || "dropped work"}`)
        this.terminate(success, reason)
    }

    private goalCompletionFailureReason(): string | null {
        if (!this.prd) return "global goal state is unavailable"
        const contract = deriveGoalContract(this.prd.goalEnvelope)
        if (!contract) return null
        const completion = this.prd.runtimeGraph?.protocol?.completion
        if (
            completion?.contractId === contract.contractId &&
            completion.goalRevision ===
                this.prd.runtimeGraph?.protocol?.goal.revision &&
            completion.status === "satisfied"
        ) return null
        return "global goal evidence changed after completion attestation"
    }

    private requestPush(reason: string | null): void {
        if (this.phase !== "running" && this.phase !== "verifying") return
        this.clearSoftDeadlineTimer()
        this.clearVerificationTimer()
        this.clearGoalCompletionTimer()
        this.clearOperationalRetryTimer()
        this.clearGoalRemediationRetryTimer()
        this.clearOfferRetractionTimer()
        this.pendingVerificationId = null
        this.pendingGoalCheck = null
        this.stopReason = reason
        this.phase = "pushing"
        this.emit(RunPushRequested.create({ runId: this.opts.runId }))
    }

    private requestVerification(reason: string | null): void {
        if (reason !== null) {
            this.requestPush(reason)
            return
        }
        if (!this.opts.verifyBeforePush) {
            this.requestGoalCompletion("verification-disabled")
            return
        }
        if (this.phase !== "running") return
        const verificationId =
            `${this.opts.runId}:verification:${this.verificationEpoch}:${++this.verificationSequence}`
        this.pendingVerificationId = verificationId
        this.phase = "verifying"
        const timeoutMs =
            this.opts.verificationTimeoutMs ??
            envNonNegativeInt("BARO_RUN_VERIFICATION_TIMEOUT_SECS", 21 * 60) * 1_000
        if (timeoutMs > 0) {
            this.verificationTimer = setTimeout(() => {
                this.emit(
                    RunVerificationTimedOut.create({
                        runId: this.opts.runId,
                        verificationId,
                        timeoutMs,
                    }),
                )
            }, timeoutMs)
        }
        this.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: "collective work integrated; verifying merged result",
                currentLevel: this.waveOrdinal,
            }),
        )
        this.emit(
            RunVerificationRequested.create({
                runId: this.opts.runId,
                verificationId,
            }),
        )
    }

    private onVerificationCompleted(
        result: RunVerificationCompletedData,
    ): void {
        this.clearVerificationTimer()
        this.pendingVerificationId = null
        const hasPassedCommand = result.commands.some(
            (command) => command.status === "passed",
        )
        const failedCommand = result.commands.find(
            (command) => command.status === "failed",
        )
        const skippedCommands = result.commands
            .filter((command) => command.status === "skipped")
            .map((command) => command.command)
        const effectiveStatus =
            failedCommand || result.status === "failed"
                ? "failed"
                : result.status === "passed" &&
                      hasPassedCommand &&
                      skippedCommands.length === 0
                  ? "passed"
                  : "skipped"
        this.verificationStatus = effectiveStatus
        this.verification = {
            verificationId: result.verificationId,
            status: effectiveStatus,
            commands: result.commands.map((command) => ({ ...command })),
            durationMs: result.durationMs,
        }
        if (effectiveStatus === "failed") {
            this.requestPush(
                `verification failed: ${failedCommand?.command ?? "build/test"}`,
            )
            return
        }
        if (effectiveStatus === "skipped") {
            const incoherentPass = result.status === "passed"
            this.requestPush(
                incoherentPass
                    ? "objective verification incomplete: verifier reported passed without complete passing command evidence"
                    : skippedCommands.length > 0
                    ? `objective verification incomplete: skipped ${skippedCommands.join(", ")}`
                    : "objective verification incomplete: no applicable build/test/typecheck/lint commands ran",
            )
            return
        }
        this.requestGoalCompletion(result.verificationId)
    }

    private requestGoalCompletion(verificationId: string): void {
        if (!this.prd) return
        if (!this.opts.goalCompletionAuthority) {
            this.requestPush(null)
            return
        }
        if (this.phase !== "running" && this.phase !== "verifying") return

        const contract = deriveGoalContract(this.prd.goalEnvelope)
        const checkId =
            `${this.opts.runId}:goal-check:${++this.goalCheckSequence}`
        this.phase = "verifying"
        this.pendingGoalCheck = {
            checkId,
            contractId: contract?.contractId ?? null,
            verificationId,
        }
        this.armGoalCompletionTimer(this.pendingGoalCheck)
        this.emit(
            ConductorState.create({
                phase: "level_complete",
                detail: contract
                    ? "objective verification passed; checking global goal invariants"
                    : "objective verification passed; goal governance is disabled for this legacy PRD",
                currentLevel: this.waveOrdinal,
            }),
        )
        this.emit(
            GoalCompletionCheckRequested.create({
                runId: this.opts.runId,
                checkId,
                contractId: contract?.contractId ?? null,
                storyIds: this.prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                verificationId,
            }),
        )
    }

    private onGoalCompletionAttested(
        attestation: GoalCompletionAttestedData,
    ): void {
        const pending = this.pendingGoalCheck
        if (
            !pending ||
            attestation.checkId !== pending.checkId ||
            attestation.contractId !== pending.contractId ||
            attestation.verificationId !== pending.verificationId
        ) return
        this.clearGoalCompletionTimer()
        if (attestation.contractId !== null) {
            const protocol = this.prd?.runtimeGraph?.protocol
            if (
                !protocol ||
                protocol.goal.contractId !== attestation.contractId ||
                protocol.goal.revision !== attestation.goalRevision
            ) {
                throw new Error(
                    "goal attestation does not match its durable ledger projection",
                )
            }
            this.persistGoalProtocol({
                ...protocol,
                completion: structuredClone(attestation),
            })
        }
        this.pendingGoalCheck = null
        if (
            attestation.status === "satisfied" ||
            attestation.status === "disabled"
        ) {
            this.requestPush(null)
            return
        }
        const unresolved = [
            ...attestation.openInvariantIds,
            ...attestation.rejectedInvariantIds,
        ]
        this.requestPush(
            `global goal is not satisfied${
                unresolved.length > 0
                    ? ` (${unresolved.join(", ")})`
                    : ""
            }: ${attestation.reason}`,
        )
    }

    private onGoalLedgerProjectionUpdated(
        update: GoalLedgerProjectionUpdatedData,
    ): void {
        if (!this.prd || this.phase === "done") return
        const contract = deriveGoalContract(this.prd.goalEnvelope)
        if (!contract || update.contractId !== contract.contractId) return
        const projection = normalizeGoalLedgerProjection(
            update.projection,
            contract,
        )
        if (
            projection.revision !== update.revision ||
            projection.contractId !== update.contractId
        ) {
            throw new Error("goal ledger projection correlation mismatch")
        }

        const current = this.prd.runtimeGraph?.protocol?.goal
        if (current?.contractId === projection.contractId) {
            if (projection.revision < current.revision) return
            if (projection.revision === current.revision) {
                if (JSON.stringify(projection) !== JSON.stringify(current)) {
                    throw new Error(
                        "goal ledger revision was replayed with different content",
                    )
                }
                this.emitGoalLedgerProjectionPersisted(projection)
                return
            }
        }
        this.persistGoalProtocol({
            schemaVersion: 1,
            goal: projection,
        })
        this.emitGoalLedgerProjectionPersisted(projection)
    }

    private emitGoalLedgerProjectionPersisted(
        projection: GoalLedgerProjectionUpdatedData["projection"],
    ): void {
        this.emit(
            GoalLedgerProjectionPersisted.create({
                runId: this.opts.runId,
                contractId: projection.contractId,
                revision: projection.revision,
                projection: structuredClone(projection),
            }),
        )
    }

    private persistGoalProtocol(protocol: PrdCollectiveProtocolState): void {
        if (!this.prd) return
        const current = this.prd.runtimeGraph
        const runtimeGraph = current?.runId === this.opts.runId
            ? { ...current, protocol: structuredClone(protocol) }
            : {
                  runId: this.opts.runId,
                  version: this.runtimeReplans.graphVersion,
                  dynamicStories: 0,
                  policyStories: 0,
                  appliedDecisions: [],
                  protocol: structuredClone(protocol),
              }
        const next: PrdFile = { ...this.prd, runtimeGraph }
        savePrdAtomic(this.opts.prdPath, next)
        this.prd = next
    }

    private onVerificationTimedOut(
        verificationId: string,
        timeoutMs: number,
    ): void {
        const reason = `verification timed out after ${Math.ceil(timeoutMs / 1_000)}s`
        this.clearVerificationTimer()
        this.verificationStatus = "failed"
        this.verification = {
            verificationId,
            status: "failed",
            commands: [
                {
                    command: "baro run verifier",
                    status: "failed",
                    durationMs: timeoutMs,
                    tail: reason,
                },
            ],
            durationMs: timeoutMs,
        }
        this.requestPush(reason)
    }

    private onGoalCompletionCheckTimedOut(
        timeout: GoalCompletionCheckTimedOutData,
    ): void {
        const pending = this.pendingGoalCheck
        if (
            this.phase !== "verifying" ||
            !pending ||
            timeout.checkId !== pending.checkId ||
            timeout.contractId !== pending.contractId ||
            timeout.verificationId !== pending.verificationId
        ) return
        this.clearGoalCompletionTimer()
        this.requestPush(
            `goal completion attestation timed out after ` +
                `${Math.ceil(timeout.timeoutMs / 1_000)}s`,
        )
    }

    private healingHaltReason(): string | null {
        if (
            this.replanProgressBudget > 0 &&
            this.healingActionsSinceProgress >= this.replanProgressBudget
        ) {
            return `no progress after ${this.healingActionsSinceProgress} healing actions — stopping so completed work can ship`
        }
        return this.softDeadlineReason()
    }

    private softDeadlineReason(): string | null {
        if (this.softDeadlineSecs <= 0) return null
        const elapsedSecs = (Date.now() - this.startedAt) / 1_000
        return elapsedSecs >= this.softDeadlineSecs
            ? `soft deadline reached (${this.softDeadlineSecs}s) — stopping so completed work can ship`
            : null
    }

    private softDeadlineRemainingMs(): number {
        if (this.softDeadlineSecs <= 0) return Number.MAX_SAFE_INTEGER
        return Math.max(
            0,
            this.startedAt + this.softDeadlineSecs * 1_000 - Date.now(),
        )
    }

    private armSoftDeadlineTimer(): void {
        this.clearSoftDeadlineTimer()
        if (this.softDeadlineSecs <= 0 || this.startedAt <= 0) return
        const startedAt = this.startedAt
        const delayMs = Math.max(
            0,
            Math.min(this.softDeadlineRemainingMs(), 2_147_483_647),
        )
        this.softDeadlineTimer = setTimeout(() => {
            this.softDeadlineTimer = null
            this.emit(
                SoftDeadlineReached.create({
                    runId: this.opts.runId,
                    startedAt,
                }),
            )
        }, delayMs)
    }

    private onSoftDeadlineReached(deadline: SoftDeadlineReachedData): void {
        if (deadline.startedAt !== this.startedAt) return
        if (this.softDeadlineReason() === null) {
            // Very large deadlines are split at the platform timer ceiling.
            this.armSoftDeadlineTimer()
            return
        }
        if (this.phase === "preparing") {
            this.terminate(
                false,
                `${this.softDeadlineReason()} while repository preparation was still pending`,
            )
            return
        }
        // Active work remains immutable and is allowed to settle. Its normal
        // completion path calls scheduleNextWave(), which observes the expired
        // deadline before dispatching any more work.
        if (this.phase === "running" && !this.wave) this.scheduleNextWave()
    }

    private clearSoftDeadlineTimer(): void {
        if (this.softDeadlineTimer) clearTimeout(this.softDeadlineTimer)
        this.softDeadlineTimer = null
    }

    private armGoalCompletionTimer(
        pending: NonNullable<CollectiveBoard["pendingGoalCheck"]>,
    ): void {
        this.clearGoalCompletionTimer()
        const configuredTimeoutMs =
            this.opts.goalCompletionTimeoutMs ??
            envNonNegativeInt("BARO_GOAL_COMPLETION_TIMEOUT_SECS", 30) * 1_000
        const timeoutMs = Math.max(
            1,
            Math.min(configuredTimeoutMs, 2_147_483_647),
        )
        this.goalCompletionTimer = setTimeout(() => {
            this.goalCompletionTimer = null
            this.emit(
                GoalCompletionCheckTimedOut.create({
                    runId: this.opts.runId,
                    checkId: pending.checkId,
                    contractId: pending.contractId,
                    verificationId: pending.verificationId,
                    timeoutMs,
                }),
            )
        }, timeoutMs)
    }

    private clearGoalCompletionTimer(): void {
        if (this.goalCompletionTimer) clearTimeout(this.goalCompletionTimer)
        this.goalCompletionTimer = null
    }

    private scheduleOperationalRetry(delayMs: number): void {
        const boundedDelay = Math.max(0, Math.min(delayMs, 2_147_483_647))
        const dueAt = Date.now() + boundedDelay
        if (
            this.operationalRetryTimer &&
            this.operationalRetryDueAt !== null &&
            this.operationalRetryDueAt <= dueAt
        ) return
        this.clearOperationalRetryTimer()
        this.operationalRetryDueAt = dueAt
        this.operationalRetryTimer = setTimeout(() => {
            this.operationalRetryTimer = null
            this.operationalRetryDueAt = null
            this.scheduleNextWave()
        }, boundedDelay)
    }

    private clearOperationalRetryTimer(): void {
        if (this.operationalRetryTimer) clearTimeout(this.operationalRetryTimer)
        this.operationalRetryTimer = null
        this.operationalRetryDueAt = null
    }

    private noteHealingAction(currentLevel: number): void {
        this.healingActionsSinceProgress += 1
        if (this.replanProgressBudget <= 0) return
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: `healing action ${this.healingActionsSinceProgress}/${this.replanProgressBudget} without progress`,
                currentLevel,
            }),
        )
    }

    private noteRuntimeAdaptation(currentLevel: number): void {
        this.runtimeAdaptationsSinceProgress += 1
        if (this.runtimeAdaptationBudget <= 0) return
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `runtime adaptation ${this.runtimeAdaptationsSinceProgress}/` +
                    `${this.runtimeAdaptationBudget} without integrated progress`,
                currentLevel,
            }),
        )
    }

    private terminate(success: boolean, abortReason: string | null): void {
        if (this.phase === "done") return
        this.clearSoftDeadlineTimer()
        this.clearVerificationTimer()
        this.clearGoalCompletionTimer()
        this.clearOperationalRetryTimer()
        this.clearGoalRemediationRetryTimer()
        this.clearOfferRetractionTimer()
        this.pendingGoalCheck = null
        this.phase = "done"
        const totalDurationSecs = Math.round((Date.now() - this.startedAt) / 1_000)
        const failedStories = this.prd
            ? this.prd.userStories
                  .filter((story) => !story.passes)
                  .map((story) => story.id)
            : [...this.failed]
        const summary: ConductorRunSummary = {
            success,
            abortReason,
            completedStories: [...this.completed],
            failedStories,
            droppedStories: [...this.dropped],
            totalDurationSecs,
            totalAttempts: this.totalAttempts,
            ...(this.verificationStatus
                ? { verificationStatus: this.verificationStatus }
                : {}),
            ...(this.verification ? { verification: this.verification } : {}),
        }
        this.emit(
            ConductorState.create({
                phase: success ? "done" : "failed",
                detail: abortReason ?? `${this.completed.length} stories integrated`,
            }),
        )
        this.emit(
            RunCompleted.create({
                success,
                completedStories: summary.completedStories,
                failedStories,
                totalDurationSecs,
                totalAttempts: this.totalAttempts,
                abortReason,
                ...(this.verificationStatus
                    ? { verificationStatus: this.verificationStatus }
                    : {}),
                ...(this.verification ? { verification: this.verification } : {}),
                runId: this.opts.runId,
            }),
        )
        this.resolveDone(summary)
    }

    private clearVerificationTimer(): void {
        if (this.verificationTimer) clearTimeout(this.verificationTimer)
        this.verificationTimer = null
    }

    /** Publish the durable graph decision, then project any newly admitted
     * story-to-goal links for the independent GoalGuardian. */
    private emitGraphDecision(event: SemanticEvent<unknown>): void {
        this.emit(event)
        if (!RuntimeReplanApplied.is(event)) return
        for (const story of event.data.mutation.addedStories) {
            this.emit(
                GoalStoryInvariantMapped.create({
                    runId: this.opts.runId,
                    mappingId:
                        `${this.opts.runId}:goal-map:` +
                        `${event.data.graphVersion}:${story.id}`,
                    storyId: story.id,
                    invariantIds: [...(story.goalInvariantIds ?? [])],
                }),
            )
        }
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

/**
 * Concurrent Surgeon proposals share one boundary snapshot. They must not both
 * write the same existing node, nor may one remove an existing node which a
 * sibling's added story or dependency rewrite still reads. Applying either
 * overlap in arrival order would make a different mutation succeed. All
 * participants in a conflict are rejected so bus order cannot choose the
 * surviving recovery intent.
 */
function policySiblingWriteConflicts(
    mutations: readonly RuntimeReplanMutation[],
): ReadonlyMap<number, readonly string[]> {
    const accesses = mutations.map((mutation) => ({
        writes: new Set([
            ...mutation.removedStoryIds,
            ...Object.keys(mutation.modifiedDeps),
        ]),
        removals: new Set(mutation.removedStoryIds),
        dependencyReads: new Set([
            ...mutation.addedStories.flatMap((story) => story.dependsOn),
            ...Object.values(mutation.modifiedDeps).flat(),
        ]),
    }))

    const conflicts = new Map<number, Set<string>>()
    for (let left = 0; left < accesses.length; left += 1) {
        for (let right = left + 1; right < accesses.length; right += 1) {
            const leftAccess = accesses[left]!
            const rightAccess = accesses[right]!
            const targets = new Set([
                ...setIntersection(leftAccess.writes, rightAccess.writes),
                ...setIntersection(
                    leftAccess.removals,
                    rightAccess.dependencyReads,
                ),
                ...setIntersection(
                    rightAccess.removals,
                    leftAccess.dependencyReads,
                ),
            ])
            if (targets.size === 0) continue
            const leftTargets = conflicts.get(left) ?? new Set<string>()
            const rightTargets = conflicts.get(right) ?? new Set<string>()
            for (const storyId of targets) {
                leftTargets.add(storyId)
                rightTargets.add(storyId)
            }
            conflicts.set(left, leftTargets)
            conflicts.set(right, rightTargets)
        }
    }
    return new Map(
        [...conflicts].map(([index, targets]) => [
            index,
            [...targets].sort(),
        ]),
    )
}

/**
 * Individually valid sibling mutations can still compose into a cycle. For
 * example, two proposals authored against independent A/B may respectively
 * set A -> B and B -> A. Build the one logical boundary candidate, find exact
 * cyclic strongly-connected components, and reject only proposals which
 * introduced an edge inside one of those components. The boundary graph was
 * already acyclic, so every such cycle necessarily contains proposal work.
 *
 * Callers pass mutations after story-id reservation. Proposal-local added ids
 * are consequently injective and cannot be conflated while composing them.
 */
function policySiblingDependencyCycleConflicts(
    boundaryPrd: PrdFile,
    mutations: readonly RuntimeReplanMutation[],
): ReadonlyMap<number, readonly string[]> {
    const removed = new Set(
        mutations.flatMap((mutation) => mutation.removedStoryIds),
    )
    const dependencies = new Map<string, readonly string[]>()
    for (const story of boundaryPrd.userStories) {
        if (!removed.has(story.id)) {
            dependencies.set(story.id, story.dependsOn)
        }
    }
    for (const mutation of mutations) {
        for (const [storyId, dependsOn] of Object.entries(
            mutation.modifiedDeps,
        )) {
            dependencies.set(storyId, dependsOn)
        }
        for (const story of mutation.addedStories) {
            dependencies.set(story.id, story.dependsOn)
        }
    }

    const cyclicComponentByStory = cyclicStronglyConnectedComponents(
        dependencies,
    )
    if (cyclicComponentByStory.size === 0) return new Map()

    const conflicts = new Map<number, Set<string>>()
    for (const [proposalIndex, mutation] of mutations.entries()) {
        const introducedEdges = [
            ...Object.entries(mutation.modifiedDeps),
            ...mutation.addedStories.map(
                (story) => [story.id, story.dependsOn] as const,
            ),
        ] as const
        for (const [storyId, dependsOn] of introducedEdges) {
            const component = cyclicComponentByStory.get(storyId)
            if (!component) continue
            if (!dependsOn.some((dependency) => component.has(dependency))) {
                continue
            }
            const targets = conflicts.get(proposalIndex) ?? new Set<string>()
            for (const member of component) targets.add(member)
            conflicts.set(proposalIndex, targets)
        }
    }

    return new Map(
        [...conflicts].map(([index, targets]) => [
            index,
            [...targets].sort(),
        ]),
    )
}

/** Map each node in an actual cyclic SCC to that exact component. */
function cyclicStronglyConnectedComponents(
    dependencies: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
    let nextIndex = 0
    const indices = new Map<string, number>()
    const lowLinks = new Map<string, number>()
    const stack: string[] = []
    const onStack = new Set<string>()
    const cyclic = new Map<string, ReadonlySet<string>>()

    const visit = (storyId: string): void => {
        const index = nextIndex++
        indices.set(storyId, index)
        lowLinks.set(storyId, index)
        stack.push(storyId)
        onStack.add(storyId)

        for (const dependency of dependencies.get(storyId) ?? []) {
            if (!dependencies.has(dependency)) continue
            if (!indices.has(dependency)) {
                visit(dependency)
                lowLinks.set(
                    storyId,
                    Math.min(
                        lowLinks.get(storyId)!,
                        lowLinks.get(dependency)!,
                    ),
                )
            } else if (onStack.has(dependency)) {
                lowLinks.set(
                    storyId,
                    Math.min(
                        lowLinks.get(storyId)!,
                        indices.get(dependency)!,
                    ),
                )
            }
        }

        if (lowLinks.get(storyId) !== indices.get(storyId)) return
        const members = new Set<string>()
        let member: string
        do {
            member = stack.pop()!
            onStack.delete(member)
            members.add(member)
        } while (member !== storyId)

        const isCycle =
            members.size > 1 ||
            (dependencies.get(storyId) ?? []).includes(storyId)
        if (!isCycle) return
        for (const cyclicStoryId of members) {
            cyclic.set(cyclicStoryId, members)
        }
    }

    for (const storyId of dependencies.keys()) {
        if (!indices.has(storyId)) visit(storyId)
    }
    return cyclic
}

function setIntersection(
    left: ReadonlySet<string>,
    right: ReadonlySet<string>,
): string[] {
    return [...left].filter((value) => right.has(value))
}

function policyReplanMutation(replan: ReplanData): RuntimeReplanMutation {
    const record = replan as unknown as Record<string, unknown>
    // Keep malformed provider payloads intact: the total runtime validator
    // turns them into structured rejections before reservation touches them.
    return {
        addedStories: record.addedStories,
        removedStoryIds: record.removedStoryIds,
        modifiedDeps: record.modifiedDeps,
    } as RuntimeReplanMutation
}

function policyRecovery(replan: ReplanData): {
    storyId?: string
    leaseId?: string
    generation?: number
} {
    const candidate = (replan as unknown as Record<string, unknown>).recovery
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return {}
    }
    const record = candidate as Record<string, unknown>
    const storyId = nonEmptyString(record.storyId)
    const leaseId = nonEmptyString(record.leaseId)
    const generation = Number.isInteger(record.generation) &&
        (record.generation as number) >= 0
        ? record.generation as number
        : undefined
    return {
        ...(storyId ? { storyId } : {}),
        ...(leaseId ? { leaseId } : {}),
        ...(generation !== undefined ? { generation } : {}),
    }
}

function firstPolicyTarget(mutation: RuntimeReplanMutation): string | null {
    const record = mutation as unknown as Record<string, unknown>
    if (Array.isArray(record.removedStoryIds)) {
        const removed = record.removedStoryIds.find(nonEmptyString)
        if (typeof removed === "string") return removed
    }
    if (Array.isArray(record.addedStories)) {
        for (const candidate of record.addedStories) {
            if (!candidate || typeof candidate !== "object") continue
            const id = nonEmptyString((candidate as Record<string, unknown>).id)
            if (id) return id
        }
    }
    if (
        record.modifiedDeps &&
        typeof record.modifiedDeps === "object" &&
        !Array.isArray(record.modifiedDeps)
    ) {
        const modified = Object.keys(record.modifiedDeps)[0]
        if (modified) return modified
    }
    return null
}

function policyReplanSource(replan: ReplanData): string {
    return nonEmptyString(
        (replan as unknown as Record<string, unknown>).source,
    ) ?? "unknown"
}

function policyReplanReason(replan: ReplanData): string {
    return nonEmptyString(
        (replan as unknown as Record<string, unknown>).reason,
    ) ?? `invalid policy replan from ${policyReplanSource(replan)}`
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() === value && value
        ? value
        : null
}

function addUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value)
}

function runtimeReplanTargetIds(
    proposal: RuntimeReplanProposedData | undefined,
): Set<string> {
    if (!proposal) return new Set()
    return new Set([
        ...proposal.mutation.removedStoryIds,
        ...Object.keys(proposal.mutation.modifiedDeps),
    ])
}

function sameOfferRetractionCorrelation(
    request: WorkOfferRetractionRequestedData,
    resolution: WorkOfferRetractionResolvedData,
): boolean {
    return (
        request.runId === resolution.runId &&
        request.proposalId === resolution.proposalId &&
        request.retractionId === resolution.retractionId &&
        request.offerId === resolution.offerId &&
        request.storyId === resolution.storyId &&
        request.generation === resolution.generation &&
        request.graphVersion === resolution.graphVersion
    )
}

function sameRemediationStory(
    current: PrdStory,
    expected: GoalInvariantRemediationProposedData["story"],
): boolean {
    return (
        current.id === expected.id &&
        current.priority === expected.priority &&
        current.title === expected.title &&
        current.description === expected.description &&
        sameStrings(current.dependsOn, expected.dependsOn) &&
        current.retries === (expected.retries ?? 2) &&
        sameStrings(current.acceptance, expected.acceptance ?? []) &&
        sameStrings(current.tests, expected.tests ?? []) &&
        sameStrings(
            current.goalInvariantIds ?? [],
            expected.goalInvariantIds ?? [],
        ) &&
        current.model === expected.model
    )
}

function sameStrings(
    left: readonly string[],
    right: readonly string[],
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    )
}

function workBlockFingerprint(request: WorkBlockedData): string {
    return JSON.stringify([
        request.runId,
        request.blockId,
        request.storyId,
        request.leaseId,
        request.generation,
        [...request.requiredStoryIds],
        request.reason,
    ])
}

function nonNegativeSafeInteger(value: unknown): number | null {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : null
}

function nonNegativeFinite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null
}

function validDependencyBlock(request: WorkBlockedData): boolean {
    return (
        request.blockId.trim().length > 0 &&
        request.blockId.length <= 200 &&
        request.reason.trim().length > 0 &&
        request.reason.length <= 8_000 &&
        request.requiredStoryIds.length > 0 &&
        request.requiredStoryIds.length <= 32 &&
        request.requiredStoryIds.every(
            (storyId) =>
                storyId.trim().length > 0 &&
                storyId.trim() === storyId &&
                storyId.length <= 128,
        ) &&
        new Set(request.requiredStoryIds).size ===
            request.requiredStoryIds.length
    )
}

function blockRejectionCode(
    code: RuntimeReplanRejectionCode,
): WorkBlockRejectionCode {
    switch (code) {
        case "run_not_active":
            return "run_not_active"
        case "inactive_source":
        case "stale_graph_version":
            return "stale_lease"
        case "immutable_story":
            return "already_settled"
        case "unknown_dependency":
        case "unknown_story":
            return "unknown_dependency"
        case "self_dependency":
        case "dependency_cycle":
            return "dependency_cycle"
        case "no_op":
            return "dependency_already_satisfied"
        default:
            return "invalid_request"
    }
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}

function envNonNegativeInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw == null || raw.trim() === "") return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function tokens(text: string): string[] {
    return [...new Set(text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])]
}

function isPermanentCapacityFailure(code: unknown): boolean {
    return code === "session_limit" || code === "quota_exhausted"
}

function isOperationalFailure(
    failure: StoryFailureData | undefined,
): failure is StoryFailureData & {
    kind: "transport" | "infrastructure" | "verification"
} {
    if (!failure) return false
    if (failure.kind === "transport" || failure.kind === "infrastructure") {
        return true
    }
    if (failure.kind !== "verification") return false
    // These two codes are trustworthy negative evidence about the work. The
    // remaining verification codes describe missing/stale evaluation and stay
    // in the operational lane.
    return failure.code !== "acceptance_not_met" &&
        failure.code !== "canonical_check_failed"
}

function failureImplicatesWorkerRoute(failure: StoryFailureData): boolean {
    if (failure.kind === "provider_capacity" || failure.kind === "transport") {
        return true
    }
    if (failure.kind !== "infrastructure") return false
    return failure.code === "process_spawn_failed" ||
        failure.code === "tool_unavailable" ||
        failure.code === "authentication_failed"
}
