/**
 * Shared lifecycle for one-shot CLI story agents (Codex, OpenCode, Pi):
 * retries with per-attempt timeout, hard cap, quality-review loop with
 * surgical revisions, dependency suspension, external abort, and
 * process-group quiescence certification. A backend contributes only its
 * CLI participant factory, live failure-signal classifier, and the
 * positive success evidence its harness needs beyond exit 0.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import {
    AgenticEnvironment,
    BaseObserver,
    Participant,
    SemanticEvent,
} from "../runtime/mozaik.js"

import { PROCESS_TREE_CAPABILITIES } from "../process-tree.js"
import {
    AgentState,
    OneShotAttemptFinalized,
    StoryResult,
    type AgentPhase,
    type StoryFailureData,
} from "../semantic-events.js"
import {
    boardOwnsCliRecovery,
    describeCliStoryFailure,
    isCliFailureSignal,
} from "./cli-story-failure.js"
import {
    OneShotTurnReview,
    oneShotSurgicalRevisionPrompt,
} from "./one-shot-turn-review.js"
import { correlationOf, type StorySuspension } from "./story-agent.js"

export interface OneShotStoryCoreSpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    targetedMessageAuthority?: Participant
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
    /** Wait for the exact Critic verdict before publishing StoryResult. */
    requiresQualityReview?: boolean
    terminalTurnAuthority?: Participant
    turnReviewAuthority?: Participant
    turnReviewTimeoutMs?: number
    handoffInconclusiveToAcceptanceGate?: boolean
    /** Collective safety boundary: a spawned CLI attempt must earn a positive
     * cooperative process-tree observation before retry or settlement. */
    requireProcessQuiescenceCertification?: boolean
    /** Fast local repair passes before structural DAG recovery takes over. */
    maxSurgicalRevisions?: number
}

export interface OneShotRunSummaryBase {
    exitCode: number | null
    error?: { message: string } | null
    stderrTail: string | null
}

export interface OneShotStoryOutcome<TSummary> {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: TSummary | null
    error: string | null
    failure?: StoryFailureData
    suspension?: StorySuspension
}

export interface OneShotStoryRunner<TSummary> extends Participant {
    done: Promise<TSummary>
    join(environment: AgenticEnvironment): void
    start(environment: AgenticEnvironment): void
    leave(environment: AgenticEnvironment): void
    abortAndWait(): Promise<boolean>
    hasOwnedProcessGroup(): boolean
    hasSpawnedProcess(): boolean
}

export interface OneShotStoryBackend<TSummary extends OneShotRunSummaryBase> {
    /** Lowercase operator-facing harness name in failure strings. */
    name: string
    createRunner(prompt: string): OneShotStoryRunner<TSummary>
    /** Raw failure signal carried by a live event from the current runner. */
    failureSignalFrom(event: SemanticEvent<unknown>): unknown | undefined
    /** Refusal/no-op detection the harness needs beyond a clean exit. */
    positiveEvidenceFailure(
        summary: TSummary,
    ): { reason: string; failure: StoryFailureData } | null
}

type NormalizedCoreSpec = Required<
    Pick<
        OneShotStoryCoreSpec,
        | "retries"
        | "timeoutSecs"
        | "retryDelayMs"
        | "hardTimeoutSecs"
        | "requiresQualityReview"
        | "turnReviewTimeoutMs"
        | "handoffInconclusiveToAcceptanceGate"
        | "requireProcessQuiescenceCertification"
        | "maxSurgicalRevisions"
    >
> &
    OneShotStoryCoreSpec

export abstract class OneShotStoryAgent<
    TSummary extends OneShotRunSummaryBase,
> extends BaseObserver {
    protected readonly spec: NormalizedCoreSpec

    private envRef: AgenticEnvironment | null = null
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private terminalSourceRegistrar: ((source: Participant) => void) | null = null
    private currentRunner: OneShotStoryRunner<TSummary> | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private currentFailureSignals: unknown[] = []
    private stopRequested = false
    /** Lifecycle signal also closes the tiny transition→timer lost-wake window. */
    private readonly retryDelayController = new AbortController()
    private readonly turnReview: OneShotTurnReview
    private suspension: StorySuspension | null = null
    private processQuiescence: Promise<boolean> | null = null
    private currentProcessQuiesced = false
    private currentProcessOwnedGroup = false
    private currentProcessSpawned = false
    private resolveDone!: (outcome: OneShotStoryOutcome<TSummary>) => void
    public readonly done: Promise<OneShotStoryOutcome<TSummary>>

    protected constructor(
        core: OneShotStoryCoreSpec,
        private readonly backend: OneShotStoryBackend<TSummary>,
    ) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            ...core,
            requiresQualityReview: core.requiresQualityReview ?? false,
            turnReviewTimeoutMs: core.turnReviewTimeoutMs ?? 240_000,
            handoffInconclusiveToAcceptanceGate:
                core.handoffInconclusiveToAcceptanceGate ?? false,
            requireProcessQuiescenceCertification:
                core.requireProcessQuiescenceCertification ?? false,
            maxSurgicalRevisions: core.maxSurgicalRevisions ?? 2,
        }
        this.turnReview = new OneShotTurnReview({
            agentId: this.spec.id,
            requiresReview: this.spec.requiresQualityReview,
            terminalAuthority: this.spec.terminalTurnAuthority,
            authority: this.spec.turnReviewAuthority,
            timeoutMs: this.spec.turnReviewTimeoutMs,
            handoffInconclusiveToAcceptanceGate:
                this.spec.handoffInconclusiveToAcceptanceGate,
            maxSurgicalRevisions: this.spec.maxSurgicalRevisions,
        })
        this.done = new Promise<OneShotStoryOutcome<TSummary>>((res) => {
            this.resolveDone = res
        })
    }

    get id(): string {
        return this.spec.id
    }

    get agentId(): string {
        return this.spec.id
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    protected getCurrentRunner(): OneShotStoryRunner<TSummary> | null {
        return this.currentRunner
    }

    setResultAuthority(source: Participant): void {
        if (this.resultAuthority && this.resultAuthority !== source) {
            throw new Error(`result authority already set for ${this.spec.id}`)
        }
        this.resultAuthority = source
    }

    setTerminalSourceRegistrar(
        register: (source: Participant) => void,
    ): void {
        if (this.terminalSourceRegistrar && this.terminalSourceRegistrar !== register) {
            throw new Error(`terminal source registrar already set for ${this.spec.id}`)
        }
        this.terminalSourceRegistrar = register
    }

    /** Idempotent; returns the `done` promise. */
    run(environment: AgenticEnvironment): Promise<OneShotStoryOutcome<TSummary>> {
        if (this.startedAt != null) {
            return this.done
        }
        this.envRef = environment
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    /** A rejected one-shot turn is resumed by a fresh process in the same worktree. */
    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (this.turnReview.observe(source, event)) return
        if (source !== this.currentRunner) return
        const signal = this.backend.failureSignalFrom(event)
        if (signal !== undefined) {
            this.currentFailureSignals.push(signal)
        }
    }

    abort(): void {
        this.stopRequested = true
        this.wakeRetryDelay()
        this.turnReview.cancel()
        this.quiesceCurrentRunner()
        this.transition("aborted", "external abort")
    }

    async suspend(blockId: string): Promise<OneShotStoryOutcome<TSummary>> {
        this.recordSuspension(blockId)
        this.stopRequested = true
        this.wakeRetryDelay()
        this.turnReview.cancel()
        this.transition("aborted", `dependency suspension ${blockId}`)
        const quiesced = await this.quiesceCurrentRunner()
        if (!quiesced) {
            throw new Error(
                `story ${this.spec.id} process group quiescence could not be certified`,
            )
        }
        return this.done
    }

    private uncertifiedQuiescenceError(): string {
        return (
            `${this.backend.name} process group quiescence could not be certified; ` +
            "stopped without workspace cleanup"
        )
    }

    private async executeAllAttempts(): Promise<void> {
        const maxExecutionAttempts = this.spec.retries + 1
        let lastSummary: TSummary | null = null
        let lastError: string | null = null
        let lastFailure: StoryFailureData | undefined
        let attempts = 0
        let executionFailures = 0
        let hardTimedOut = false
        let prompt = this.spec.prompt
        let needsRetryDelay = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.wakeRetryDelay()
                      this.turnReview.cancel()
                      this.quiesceCurrentRunner()
                  }, this.spec.hardTimeoutSecs * 1000)
                : null

        try {
            while (true) {
                if (this.stopRequested) break
                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }

                if (needsRetryDelay) {
                    if (this.stopRequested) break
                    this.transition(
                        "waiting",
                        `retrying execution (${executionFailures + 1}/${maxExecutionAttempts})`,
                    )
                    await this.waitForRetryDelay()
                    if (this.stopRequested) break
                    if (hardTimedOut) {
                        lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                        lastFailure = {
                            kind: "infrastructure",
                            code: "command_timeout",
                        }
                        break
                    }
                }

                attempts++
                needsRetryDelay = false
                this.turnReview.beginCandidate()
                const result = await this.runOneAttempt(attempts, prompt)
                lastSummary = result.summary
                lastError = result.error
                lastFailure = result.failure

                if (this.stopRequested) {
                    this.turnReview.discardCandidate()
                    this.finalizeProjectedCandidate("discard", attempts)
                    break
                }
                if (hardTimedOut) {
                    this.turnReview.discardCandidate()
                    this.finalizeProjectedCandidate("discard", attempts)
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }
                if (result.success) {
                    if (this.hasUncertifiedOwnedProcessGroup()) {
                        this.turnReview.discardCandidate()
                        this.finalizeProjectedCandidate("discard", attempts)
                        lastError = this.uncertifiedQuiescenceError()
                        lastFailure = {
                            kind: "infrastructure",
                            code: "process_quiescence_uncertified",
                        }
                        break
                    }
                    this.finalizeProjectedCandidate("publish", attempts)
                    if (this.turnReview.requiresReview) {
                        this.transition("waiting", "awaiting quality review")
                    }
                    const review = await this.turnReview.reviewNext()
                    if (this.stopRequested) break
                    if (hardTimedOut) {
                        lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                        lastFailure = {
                            kind: "infrastructure",
                            code: "command_timeout",
                        }
                        break
                    }
                    if (review.kind === "revise") {
                        if (this.currentProcessQuiesced) {
                            prompt = oneShotSurgicalRevisionPrompt(
                                this.spec.prompt,
                                review.review,
                            )
                            this.transition(
                                "waiting",
                                `surgical revision ${review.revision}`,
                            )
                            continue
                        }
                        if (!this.spec.handoffInconclusiveToAcceptanceGate) {
                            lastError =
                                "cannot safely launch a surgical revision: " +
                                "prior process-tree quiescence was not certified"
                            lastFailure = {
                                kind: "infrastructure",
                                code: "worktree_unavailable",
                            }
                            break
                        }
                        // The platform cannot certify that a fresh one-shot
                        // process is safe. Keep this candidate unchanged and
                        // make the existing AcceptanceGate/DAG recovery lane
                        // the explicit owner of the rejection instead.
                        this.transition(
                            "waiting",
                            "surgical revision handed to acceptance gate: prior process quiescence uncertified",
                        )
                    }
                    if (review.kind === "failure") {
                        lastError = review.error
                        lastFailure = review.failure
                        break
                    }
                    if (review.kind === "cancelled") {
                        lastError = "quality review wait cancelled"
                        lastFailure = {
                            kind: "infrastructure",
                            code: "review_timeout",
                        }
                        break
                    }
                    const durationSecs = Math.round(
                        (Date.now() - (this.startedAt ?? Date.now())) / 1000,
                    )
                    this.transition("done", `success after ${attempts} invocation(s)`)
                    this.emitStoryResult(true, attempts, durationSecs, null)
                    this.resolveDone({
                        storyId: this.spec.id,
                        success: true,
                        attempts,
                        durationSecs,
                        finalSummary: result.summary,
                        error: null,
                    })
                    return
                }

                this.turnReview.discardCandidate()
                this.finalizeProjectedCandidate("discard", attempts)

                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }
                if (this.hasUncertifiedOwnedProcessGroup()) {
                    lastError = this.uncertifiedQuiescenceError()
                    lastFailure = {
                        kind: "infrastructure",
                        code: "process_quiescence_uncertified",
                    }
                    break
                }
                if (boardOwnsCliRecovery(result.failure)) break
                executionFailures++
                if (executionFailures >= maxExecutionAttempts) break
                needsRetryDelay = true
            }
        } finally {
            if (hardTimer !== null) clearTimeout(hardTimer)
        }

        await this.processQuiescence

        const quiescenceFailure = this.hasUncertifiedOwnedProcessGroup()
        if (quiescenceFailure) {
            lastError = this.uncertifiedQuiescenceError()
            lastFailure = {
                kind: "infrastructure",
                code: "process_quiescence_uncertified",
            }
            this.suspension = null
        }

        if (!quiescenceFailure && this.suspension) {
            lastError = null
            lastFailure = undefined
        } else if (!quiescenceFailure && this.stopRequested) {
            lastError = "story execution aborted externally"
            lastFailure = undefined
        }

        const durationSecs = Math.round(
            (Date.now() - (this.startedAt ?? Date.now())) / 1000,
        )
        if (quiescenceFailure) {
            this.transition("failed", "process group quiescence uncertified")
        } else if (this.stopRequested) {
            this.transition(
                "aborted",
                this.suspension
                    ? `suspended on dependency block ${this.suspension.blockId}`
                    : "external abort settled",
            )
        } else {
            this.transition(
                "failed",
                boardOwnsCliRecovery(lastFailure)
                    ? `operational failure after ${attempts} attempt(s)`
                    : `failed after ${attempts} model invocation(s)`,
            )
        }
        this.emitStoryResult(
            false,
            attempts,
            durationSecs,
            lastError,
            lastFailure,
        )
        this.resolveDone({
            storyId: this.spec.id,
            success: false,
            attempts,
            durationSecs,
            finalSummary: lastSummary,
            error: lastError,
            ...(lastFailure ? { failure: lastFailure } : {}),
            ...(this.suspension ? { suspension: this.suspension } : {}),
        })
    }

    private async runOneAttempt(
        attempt: number,
        prompt: string,
    ): Promise<{
        success: boolean
        summary: TSummary | null
        error: string | null
        failure?: StoryFailureData
    }> {
        if (!this.envRef) {
            return {
                success: false,
                summary: null,
                ...describeCliStoryFailure(
                    "no environment",
                    { kind: "infrastructure", code: "process_spawn_failed" },
                ),
            }
        }

        this.processQuiescence = null
        this.currentProcessQuiesced = false
        this.currentProcessOwnedGroup = false
        this.currentProcessSpawned = false
        this.transition("running", `attempt ${attempt}`)
        this.currentFailureSignals = []

        const runner = this.backend.createRunner(prompt)
        this.currentRunner = runner
        this.terminalSourceRegistrar?.(runner)
        runner.join(this.envRef)
        runner.start(this.envRef)
        this.currentProcessOwnedGroup = runner.hasOwnedProcessGroup()
        this.currentProcessSpawned = runner.hasSpawnedProcess()

        let summary: TSummary
        try {
            summary = await raceWithTimeout(
                runner.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            this.currentProcessQuiesced = await this.quiesceCurrentRunner()
            const error = e instanceof Error ? e.message : String(e)
            let stderrTail: string | null = null
            try {
                stderrTail = (await runner.done).stderrTail
            } catch {
                // ignore
            }
            runner.leave(this.envRef)
            this.currentRunner = null
            return {
                success: false,
                summary: null,
                ...describeCliStoryFailure(
                    error,
                    { kind: "infrastructure", code: "command_timeout" },
                    [...this.currentFailureSignals, stderrTail],
                ),
            }
        }

        this.currentProcessQuiesced = await this.quiesceCurrentRunner()
        runner.leave(this.envRef)
        this.currentRunner = null

        const failureSignals = [
            ...this.currentFailureSignals,
            summary.stderrTail,
        ]
        const reportedFailure = failureSignals.some((signal) =>
            isCliFailureSignal(signal, ""),
        )
        if (
            summary.exitCode !== 0 ||
            summary.error != null ||
            reportedFailure
        ) {
            const reason = summary.error
                ? summary.error.message
                : reportedFailure
                  ? `${this.backend.name} reported a failed turn`
                  : `non-zero exit ${summary.exitCode}`
            return {
                success: false,
                summary,
                ...describeCliStoryFailure(
                    reason,
                    summary.error
                        ? {
                              kind: "infrastructure",
                              code: "process_spawn_failed",
                          }
                        : { kind: "execution", code: "model_error" },
                    failureSignals,
                ),
            }
        }
        const evidenceFailure = this.backend.positiveEvidenceFailure(summary)
        if (evidenceFailure) {
            return {
                success: false,
                summary,
                ...describeCliStoryFailure(
                    evidenceFailure.reason,
                    evidenceFailure.failure,
                ),
            }
        }

        return { success: true, summary, error: null }
    }

    private emitStoryResult(
        success: boolean,
        attempts: number,
        durationSecs: number,
        error: string | null,
        failure?: StoryFailureData,
    ): void {
        if (!this.envRef) return
        this.envRef.deliverSemanticEvent(
            this.resultAuthority ?? this,
            StoryResult.create({
                storyId: this.spec.id,
                success,
                attempts,
                durationSecs,
                error,
                ...(failure ? { failure } : {}),
                ...(this.suspension ? { suspension: this.suspension } : {}),
                ...correlationOf(this.spec),
            }),
        )
    }

    private recordSuspension(blockId: string): void {
        if (typeof blockId !== "string" || blockId.trim() !== blockId || !blockId) {
            throw new TypeError("suspension blockId must be a non-empty trimmed string")
        }
        if (this.suspension && this.suspension.blockId !== blockId) {
            throw new Error(
                `story ${this.spec.id} is already suspending for block ${this.suspension.blockId}`,
            )
        }
        this.suspension ??= { kind: "dependency", blockId }
    }

    private quiesceCurrentRunner(): Promise<boolean> {
        const runner = this.currentRunner
        if (!runner) return this.processQuiescence ?? Promise.resolve(true)
        this.currentProcessOwnedGroup ||= runner.hasOwnedProcessGroup()
        this.currentProcessSpawned ||= runner.hasSpawnedProcess()
        if (!this.processQuiescence) {
            this.processQuiescence = runner.abortAndWait()
        }
        return this.processQuiescence
    }

    private hasUncertifiedOwnedProcessGroup(): boolean {
        return (
            !this.currentProcessQuiesced &&
            ((this.spec.requireProcessQuiescenceCertification &&
                this.currentProcessSpawned) ||
                (PROCESS_TREE_CAPABILITIES
                    .cooperativeQuiescenceObservation &&
                    this.currentProcessOwnedGroup))
        )
    }

    private finalizeProjectedCandidate(
        requested: "publish" | "discard",
        attempt: number,
    ): void {
        if (
            !this.envRef ||
            !this.spec.runId ||
            !this.spec.leaseId ||
            this.spec.generation == null
        ) return
        this.envRef.deliverSemanticEvent(
            this,
            OneShotAttemptFinalized.create({
                runId: this.spec.runId,
                storyId: this.spec.id,
                leaseId: this.spec.leaseId,
                generation: this.spec.generation,
                attempt,
                disposition:
                    requested === "publish" && this.currentProcessQuiesced
                        ? "publish"
                        : "discard",
                ownedProcessGroup: this.currentProcessOwnedGroup,
                quiescenceAssurance: this.currentProcessQuiesced
                    ? "cooperative-observed"
                    : "none",
            }),
        )
    }

    private async waitForRetryDelay(): Promise<void> {
        try {
            await setTimeoutPromise(this.spec.retryDelayMs, undefined, {
                signal: this.retryDelayController.signal,
            })
        } catch (error) {
            if (!this.retryDelayController.signal.aborted) throw error
        }
    }

    private wakeRetryDelay(): void {
        this.retryDelayController.abort()
    }

    private transition(next: AgentPhase, detail?: string): void {
        if (next === this.currentPhase) return
        this.currentPhase = next
        if (this.envRef) {
            this.envRef.deliverSemanticEvent(
                this,
                AgentState.create({
                    agentId: this.spec.id,
                    phase: next,
                    detail,
                }),
            )
        }
    }
}

function raceWithTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>(
        (_, rej) => {
            timer = setTimeout(() => rej(new Error(label)), ms)
        },
    )
    const settled = p.finally(() => clearTimeout(timer))
    settled.catch(() => {})
    return Promise.race([settled, timeout])
}
