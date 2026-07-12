import type { Participant, SemanticEvent } from "@mozaik-ai/core"
import { randomUUID } from "node:crypto"

import { buildDag } from "../dag.js"
import {
    buildDefaultStoryPrompt,
    loadPrd,
    markStoryPassed,
    savePrdAtomic,
    type PrdFile,
    type PrdStory,
} from "../prd.js"
import {
    ConductorState,
    CoordinationModeSelected,
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
    WorkLeaseGranted,
    WorkLeaseExpired,
    WorkDiscovered,
    WorkContextProvided,
    WorkContextRequested,
    WorkOfferExpired,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupFailed,
    WorkspaceCleanupRequested,
    type ReplanData,
    type RuntimeReplanProposedData,
    type RunVerificationCompletedData,
    type RunVerificationEvidence,
    type StoryResultData,
    type WorkDiscoveredData,
} from "../semantic-events.js"
import type { ConductorRunSummary } from "./conductor.js"
import { RuntimeReplanCoordinator } from "./runtime-replan-coordinator.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import { isProviderCapacityFailure } from "../provider-failure.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface CollectiveBoardOptions {
    runId: string
    prdPath: string
    cwd: string
    timeoutSecs: number
    overrideModel?: string
    defaultModel?: string
    expectRecoveryDecisions?: boolean
    maxRecoveryAttemptsPerStory?: number
    /** Credential-free routes registered in the deterministic worker market. */
    marketRouteIds?: readonly string[]
    maxDynamicStories?: number
    replanProgressBudget?: number
    softDeadlineSecs?: number
    /** Gate a clean completion on objective build/test verification. */
    verifyBeforePush?: boolean
    /** Fail closed if the verifier never answers. Default: 21 minutes. */
    verificationTimeoutMs?: number
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
    /** Object-identity Surgeon authority allowed to publish recovery policy. */
    recoveryAuthority?: Participant
    /** Object-identity CollaborationBridge authority allowed to discover work. */
    discoveryAuthority?: Participant
    /** Object-identity bridge authority allowed to relay CLI runtime replans.
     * Native story participants are authorized through `outcomeAuthority`. */
    runtimeReplanAuthority?: Participant
    /** Explicitly unsafe unit-test seam. Never enable in a real run. */
    unsafeAllowUnboundRuntimeReplanAuthority?: boolean
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
    recovery: boolean
}

type BoardPhase = "idle" | "preparing" | "running" | "verifying" | "pushing" | "done"

export class CollectiveBoard extends SerializedObserver {
    private phase: BoardPhase = "idle"
    private prd: PrdFile | null = null
    private startedAt = 0
    private wave: WaveState | null = null
    private waveOrdinal = 0
    private offerSequence = 0
    private contextSequence = 0
    private cleanupSequence = 0
    private verificationSequence = 0
    private discoverySequence = 0
    private totalAttempts = 0
    private readonly completed: string[] = []
    private readonly failed = new Set<string>()
    private readonly dropped = new Set<string>()
    private readonly leases = new Map<
        string,
        {
            leaseId: string
            generation: number
            workerId: string
            route?: { routeId: string; backend: string; model: string }
        }
    >()
    private readonly settledLeaseResults = new Set<string>()
    private readonly pendingQuality = new Map<string, StoryResultData>()
    private readonly durations = new Map<string, number>()
    private readonly recoveryAttempts = new Map<string, number>()
    private readonly capacityRerouteAttempts = new Map<string, number>()
    private readonly recoveryContext = new Map<
        string,
        {
            kind: "execution" | "integration"
            reason: string
            branch?: string
        }
    >()
    private readonly recoveryAborted = new Set<string>()
    /** Capacity recovery is deterministic routing, not a Surgeon decision. */
    private readonly capacityRecoveryPending = new Set<string>()
    private readonly marketRouteIds: ReadonlySet<string>
    private readonly unavailableMarketRouteIds = new Set<string>()
    private readonly unclaimable = new Set<string>()
    private readonly unmergeable = new Set<string>()
    private readonly pendingReplans: ReplanData[] = []
    /** Future nodes touched by runtime proposals and eligible to cross the
     * old level barrier as soon as their actual dependencies integrate. */
    private readonly runtimeAdaptiveStoryIds = new Set<string>()
    private readonly runtimeReplans: RuntimeReplanCoordinator
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
    private readonly softDeadlineSecs: number
    private healingActionsSinceProgress = 0
    private stopReason: string | null = null
    private pendingVerificationId: string | null = null
    private verificationStatus: "passed" | "failed" | "skipped" | undefined
    private verification: RunVerificationEvidence | undefined
    private verificationTimer: ReturnType<typeof setTimeout> | null = null
    readonly done: Promise<ConductorRunSummary>
    private resolveDone!: (summary: ConductorRunSummary) => void

    constructor(private readonly opts: CollectiveBoardOptions) {
        super()
        this.marketRouteIds = new Set(opts.marketRouteIds ?? [])
        this.replanProgressBudget =
            opts.replanProgressBudget ??
            envNonNegativeInt("BARO_REPLAN_PROGRESS_BUDGET", 3)
        this.softDeadlineSecs =
            opts.softDeadlineSecs ??
            envNonNegativeInt("BARO_RUN_SOFT_DEADLINE_SECS", 0)
        this.runtimeReplans = new RuntimeReplanCoordinator({
            runId: opts.runId,
            prdPath: opts.prdPath,
            maxDynamicStories: opts.maxDynamicStories ?? 3,
            adaptationBudget: this.replanProgressBudget,
        })
        this.done = new Promise((resolve) => {
            this.resolveDone = resolve
        })
    }

    protected override async handleEvent(
        context: SerializedEventContext,
    ): Promise<void> {
        const { event } = context
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
            this.leases.set(event.data.request.storyId, {
                leaseId: event.data.leaseId,
                generation: event.data.generation,
                workerId: event.data.workerId,
                ...(event.data.route ? { route: { ...event.data.route } } : {}),
            })
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
            if (this.wave?.pending.has(story.id)) {
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
            this.failStory(
                event.data.storyId,
                `spawn failed: ${event.data.error}`,
                true,
                "execution",
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
            this.failStory(event.data.storyId, event.data.reason, true, "execution")
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
                if (recovery?.kind === "execution") {
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
            this.unmergeable.add(event.data.storyId)
            this.recoveryAborted.add(event.data.storyId)
            this.capacityRecoveryPending.delete(event.data.storyId)
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
            RuntimeReplanProposed.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.onRuntimeReplanProposed(context.source, event.data)
            return
        }
        if (
            Replan.is(event) &&
            (context.internal ||
                (this.opts.expectRecoveryDecisions === true &&
                    (!this.opts.recoveryAuthority ||
                        context.source === this.opts.recoveryAuthority)))
        ) {
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
        this.prd = loadPrd(this.opts.prdPath)
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
                ...(this.prd.executionMode ? { mode: this.prd.executionMode.mode } : {}),
            }),
        )
        this.scheduleNextWave()
    }

    private onStoryResult(result: StoryResultData): void {
        if (this.phase !== "running" || !this.wave?.pending.has(result.storyId)) return
        this.totalAttempts += result.attempts
        this.durations.set(result.storyId, result.durationSecs)

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
            this.prepareCapacityRecovery(result.storyId)
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
            "execution",
        )
    }

    private requestIntegration(result: StoryResultData): void {
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
            this.emit(
                StoryIntegrationRequested.create({
                    runId: this.opts.runId,
                    leaseId: lease.leaseId,
                    storyId: result.storyId,
                    attempts: result.attempts,
                    durationSecs: result.durationSecs,
                }),
            )
    }

    private onStoryQuality(data: {
        storyId: string
        leaseId: string
        generation: number
        status: "passed" | "failed"
        reason: string
    }): void {
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
            this.requestIntegration(result)
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
        this.wave.pending.delete(storyId)
        addUnique(this.wave.passed, storyId)
        addUnique(this.completed, storyId)
        this.failed.delete(storyId)
        this.recoveryContext.delete(storyId)
        this.recoveryAborted.delete(storyId)
        this.capacityRecoveryPending.delete(storyId)
        this.capacityRerouteAttempts.delete(storyId)
        this.recoveryDecided.delete(storyId)
        this.leases.delete(storyId)
        this.pendingQuality.delete(storyId)
        this.healingActionsSinceProgress = 0
        this.reconcileRuntimeReadyStories()
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
        recoveryKind?: "execution" | "integration",
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
            const preserveForRecovery = recoveryKind === "execution"
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

    private completeWave(): void {
        const wave = this.wave
        if (!wave || !this.prd) return
        this.emit(
            LevelCompleted.create({
                ordinal: wave.ordinal,
                passed: wave.passed,
                failed: wave.failed,
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
        const replans = this.pendingReplans.splice(0)
        for (const replan of replans) {
            if (replan.removedStoryIds.length > 0 && replan.addedStories.length === 0) {
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail: `collective deferred destructive drop from ${replan.source}: ${replan.reason}`,
                        currentLevel,
                    }),
                )
                continue
            }
            const halt = this.healingHaltReason()
            if (halt) {
                return halt
            }
            const recovery = replan.recovery
            const proposal: RuntimeReplanProposedData = {
                runId: this.opts.runId,
                proposalId:
                    `${this.opts.runId}:policy-replan:` +
                    randomUUID(),
                sourceStoryId:
                    recovery?.storyId ??
                    replan.removedStoryIds[0] ??
                    replan.addedStories[0]?.id ??
                    `policy:${replan.source}`,
                leaseId: recovery?.leaseId ?? `${this.opts.runId}:policy`,
                generation: recovery?.generation ?? currentLevel,
                // Policy replans are serialized at the safe wave boundary and
                // intentionally revalidate against the latest durable graph.
                baseGraphVersion: this.runtimeReplans.graphVersion,
                reason: replan.reason,
                mutation: {
                    addedStories: replan.addedStories,
                    removedStoryIds: replan.removedStoryIds,
                    modifiedDeps: replan.modifiedDeps,
                },
            }
            const outcome = this.runtimeReplans.decide(proposal, {
                active: this.phase === "running",
                prd: this.prd,
                immutableStoryIds: this.prd.userStories
                    .filter((story) => story.passes)
                    .map((story) => story.id),
                activeLease: undefined,
                healingActionsSinceProgress: this.healingActionsSinceProgress,
                requireActiveLease: false,
                storyAccounting: "policy",
                maxAddedStories: Number.MAX_SAFE_INTEGER,
            })
            if (!outcome.applied || !RuntimeReplanApplied.is(outcome.event)) {
                const detail = RuntimeReplanRejected.is(outcome.event)
                    ? outcome.event.data.reason
                    : "policy mutation was not applied"
                this.emit(
                    ConductorState.create({
                        phase: "running_level",
                        detail:
                            `collective rejected replan from ${replan.source}: ` +
                            detail,
                        currentLevel,
                    }),
                )
                continue
            }
            this.prd = outcome.applied.prd
            // Raw Surgeon Replan is a proposal in collective mode. Stateful
            // observers consume only this authoritative, persisted decision.
            this.emit(outcome.event)
            this.noteHealingAction(currentLevel)
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
        return null
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

    private decideRuntimeReplan(proposal: RuntimeReplanProposedData): void {
        const lease = this.leases.get(proposal.sourceStoryId)
        const outcome = this.runtimeReplans.decide(proposal, {
            active: this.phase === "running",
            prd: this.prd,
            immutableStoryIds: this.runtimeImmutableStoryIds(),
            activeLease: lease
                ? {
                      leaseId: lease.leaseId,
                      generation: lease.generation,
                  }
                : undefined,
            healingActionsSinceProgress: this.healingActionsSinceProgress,
        })
        if (outcome.applied && RuntimeReplanApplied.is(outcome.event)) {
            // The coordinator has already crossed the durable commit boundary;
            // swap the Board snapshot before any observer can react to Applied.
            this.prd = outcome.applied.prd
            for (const storyId of outcome.applied.removedStoryIds) {
                this.runtimeAdaptiveStoryIds.delete(storyId)
            }
            for (const storyId of [
                ...outcome.applied.addedStoryIds,
                ...outcome.applied.modifiedStoryIds,
            ]) {
                this.runtimeAdaptiveStoryIds.add(storyId)
            }
            this.emit(outcome.event)
            this.noteHealingAction(this.wave?.ordinal ?? this.waveOrdinal)
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
            this.reconcileRuntimeReadyStories()
            return
        }
        this.emit(outcome.event)
        if (!RuntimeReplanRejected.is(outcome.event)) return
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail:
                    `collective rejected runtime replan ` +
                    `${proposal.proposalId || "(missing)"}: ` +
                    outcome.event.data.reason,
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
            ...(this.wave?.storyIds ?? []),
        ])
        for (const story of this.prd?.userStories ?? []) {
            if (story.passes) immutable.add(story.id)
        }
        for (const cleanup of this.pendingCleanup.values()) {
            immutable.add(cleanup.storyId)
        }
        return immutable
    }

    private reconcileRuntimeReadyStories(): void {
        if (this.phase !== "running" || !this.prd || !this.wave) return
        const storyById = new Map(this.prd.userStories.map((story) => [story.id, story]))
        const scheduled = new Set(this.wave.storyIds)
        const ready = this.prd.userStories.filter(
            (story) =>
                !story.passes &&
                this.runtimeAdaptiveStoryIds.has(story.id) &&
                !scheduled.has(story.id) &&
                !this.failed.has(story.id) &&
                story.dependsOn.every((dependency) => storyById.get(dependency)?.passes),
        )
        if (ready.length === 0) return
        ready.sort((left, right) => left.priority - right.priority)
        for (const story of ready) {
            this.runtimeAdaptiveStoryIds.delete(story.id)
            this.wave.storyIds.push(story.id)
            this.wave.pending.add(story.id)
            this.requestStoryContext(story)
        }
        this.emit(
            ConductorState.create({
                phase: "running_level",
                detail: `collective admitted ${ready.map((story) => story.id).join(", ")} into the active wave after runtime adaptation`,
                currentLevel: this.wave.ordinal,
                storyIds: this.wave.storyIds,
            }),
        )
    }

    private onWorkDiscovered(discovery: WorkDiscoveredData): void {
        if (this.phase !== "running" || !this.prd) return
        const lease = this.leases.get(discovery.sourceAgentId)
        if (!lease) {
            this.emit(
                ConductorState.create({
                    phase: "running_level",
                    detail: `collective rejected discovered work ${discovery.story.id || "(missing id)"}: source lease is inactive`,
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
                        model: story.model,
                    },
                ],
            },
        })
    }

    private scheduleNextWave(): void {
        if (this.phase !== "running" || !this.prd || this.wave) return

        const blocked = this.computeBlockedStoryIds()
        const runnable = this.prd.userStories.filter(
            (story) =>
                !story.passes &&
                !this.failed.has(story.id) &&
                !blocked.has(story.id),
        )

        let levels
        try {
            levels = buildDag(runnable)
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
            this.runtimeAdaptiveStoryIds.delete(storyId)
            this.pendingRecovery.delete(storyId)
            this.recoveryDecided.delete(storyId)
        }
        this.wave = {
            ordinal,
            storyIds,
            pending: new Set(storyIds),
            passed: [],
            failed: [],
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
        const offerId = `${this.opts.runId}:offer:${++this.offerSequence}:${story.id}`
        const basePrompt = this.storyPrompt(story)
        const recovery = this.wave?.recovery
            ? this.recoveryContext.get(story.id)
            : undefined
        const recoveryPrompt = recovery
            ? [
                  "## Recovery attempt",
                  "",
                  `The previous ${recovery.kind} attempt failed: ${recovery.reason}`,
                  recovery.branch
                      ? `This fresh worktree starts at the latest integrated run branch. The rejected attempt is preserved at ${recovery.branch}. Inspect \`git diff HEAD...${recovery.branch}\` and \`git show ${recovery.branch}\`, then reapply its intent while preserving already-integrated work. Do not merge or cherry-pick the backup wholesale. Run the required checks and commit the reconciled result.`
                      : "Re-run the story from the current integrated repository state, address the failure, run the required checks, and commit the corrected work.",
              ].join("\n")
            : null
        const prompt = [context?.trim() || null, recoveryPrompt, basePrompt]
            .filter((part): part is string => Boolean(part))
            .join("\n\n")
        const excludedRouteIds = [...this.unavailableMarketRouteIds].sort()
        this.emit(
            WorkOffered.create({
                runId: this.opts.runId,
                offerId,
                generation: this.wave?.ordinal ?? this.waveOrdinal,
                priority: story.priority,
                ...(excludedRouteIds.length > 0 ? { excludedRouteIds } : {}),
                request: {
                    storyId: story.id,
                    prompt,
                    model: this.opts.overrideModel ?? story.model ?? this.opts.defaultModel ?? "sonnet",
                    retries: story.retries,
                    timeoutSecs: this.opts.timeoutSecs,
                    graphVersion: this.runtimeReplans.graphVersion,
                    ...(recovery ? { recovery } : {}),
                },
            }),
        )
    }

    private storyPrompt(story: PrdStory): string {
        let prompt = buildDefaultStoryPrompt(story)
        const document = this.prd?.decisionDocument?.trim()
        if (!document) return prompt
        prompt = [
            "## Design spec (authoritative — already decided)",
            "",
            document,
            "",
            "---",
            "",
            prompt,
        ].join("\n")
        return prompt
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
        const success =
            this.stopReason === null &&
            incomplete.length === 0 &&
            this.dropped.size === 0
        const reason =
            this.stopReason ??
            (success
                ? null
                : `collective run stopped with incomplete stories: ${incomplete.map((story) => story.id).join(", ") || "dropped work"}`)
        this.terminate(success, reason)
    }

    private requestPush(reason: string | null): void {
        if (this.phase !== "running" && this.phase !== "verifying") return
        this.clearVerificationTimer()
        this.pendingVerificationId = null
        this.stopReason = reason
        this.phase = "pushing"
        this.emit(RunPushRequested.create({ runId: this.opts.runId }))
    }

    private requestVerification(reason: string | null): void {
        if (reason !== null || !this.opts.verifyBeforePush) {
            this.requestPush(reason)
            return
        }
        if (this.phase !== "running") return
        const verificationId =
            `${this.opts.runId}:verification:${++this.verificationSequence}`
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
        this.verificationStatus = result.status
        this.verification = {
            verificationId: result.verificationId,
            status: result.status,
            commands: result.commands.map((command) => ({ ...command })),
            durationMs: result.durationMs,
        }
        if (result.status === "failed") {
            const failed = result.commands.find((command) => command.status === "failed")
            this.requestPush(
                `verification failed: ${failed?.command ?? "build/test"}`,
            )
            return
        }
        this.requestPush(null)
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

    private terminate(success: boolean, abortReason: string | null): void {
        if (this.phase === "done") return
        this.clearVerificationTimer()
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

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

function addUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value)
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
