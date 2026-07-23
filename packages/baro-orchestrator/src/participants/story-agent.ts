/**
 * StoryAgent — drives a ClaudeCliParticipant through one story with retries
 * and timeouts. Multi-turn: stdin stays OPEN after the initial prompt so
 * corrective messages can be injected; a quiet timer (started on the first
 * AgentResult, reset on further results/targeted messages) or the maxTurns
 * cap closes stdin to end the session.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "../runtime/mozaik.js"

import { AgenticEnvironment } from "../runtime/mozaik.js"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    ClaudeRateLimit,
    Critique,
    StoryResult,
    type AgentPhase,
    type AgentResultData,
    type StoryFailureData,
    type StoryResultData,
} from "../semantic-events.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import {
    classifyProviderFailure,
    classifyStoryFailure,
    compactProviderFailureDetail,
} from "../provider-failure.js"
import {
    ClaudeCliParticipant,
    ClaudeRunSummary,
} from "./claude-cli-participant.js"
import { criticInput } from "./critic-input.js"
import { StreamingTurnLifecycle } from "./turn-review.js"

export interface StorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    /** Runtime DAG version captured when this story lease was launched. */
    graphVersion?: number
    model?: string
    /** Passed as `claude --effort` (low|medium|high|xhigh|max). */
    effort?: string
    claudeBin?: string
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Ms of silence (no AgentResult for this story) before stdin is closed. */
    quietTimeoutMs?: number
    /** Max AgentResult events (turns) before stdin is closed unconditionally. */
    maxTurns?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
    /** Await an exact Critic verdict before completing each candidate turn. */
    requiresQualityReview?: boolean
    /** Object-identity authority allowed to review this worker's turns. */
    turnReviewAuthority?: Participant
    /** Exact Bridge allowed to deliver a collective message for this lease. */
    targetedMessageAuthority?: Participant
    /** Bound for one terminal-turn review. Default: 240 seconds. */
    turnReviewTimeoutMs?: number
    /** Collective-only execution handoff. An inconclusive review closes the
     * worker, while AcceptanceGate keeps the candidate pending and rechecks it. */
    handoffInconclusiveToAcceptanceGate?: boolean
    /** Require a positive process-tree quiescence certificate before a
     * spawned CLI attempt may succeed, retry, or release its worktree. */
    requireProcessQuiescenceCertification?: boolean
}

export interface StoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: ClaudeRunSummary | null
    error: string | null
    failure?: StoryFailureData
    suspension?: StorySuspension
}

export type StorySuspension = NonNullable<StoryResultData["suspension"]>

export class StoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            StorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "quietTimeoutMs"
            | "maxTurns"
            | "hardTimeoutSecs"
            | "requiresQualityReview"
            | "turnReviewTimeoutMs"
            | "handoffInconclusiveToAcceptanceGate"
            | "requireProcessQuiescenceCertification"
        >
    > &
        StorySpec

    private envRef: AgenticEnvironment | null = null
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private terminalSourceRegistrar: ((source: Participant) => void) | null = null
    private currentClaude: ClaudeCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    /** Rejected capacity frame for the currently executing CLI attempt. */
    private currentProviderCapacitySignal: unknown | undefined
    private stopRequested = false
    /** Lifecycle signal also closes the tiny transition→timer lost-wake window. */
    private readonly retryDelayController = new AbortController()
    private suspension: StorySuspension | null = null
    private processQuiescence: Promise<boolean> | null = null
    /** Spawn provenance is deliberately separate from POSIX group ownership:
     * unsupported platforms can return a real PID without a certifiable group. */
    private currentProcessSpawned = false
    private currentProcessQuiesced = false
    private resolveDone!: (outcome: StoryOutcome) => void
    public readonly done: Promise<StoryOutcome>

    /** Wired up per attempt and detached when that process settles. */
    private turnLifecycle: StreamingTurnLifecycle | null = null

    constructor(spec: StorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            quietTimeoutMs: 2000,
            maxTurns: 4,
            // Kill timer disabled by default: a 300s cap was guillotining
            // productive refactors mid-flight; per-attempt timeoutSecs and the
            // quiet timer still close out idle agents.
            hardTimeoutSecs: 0,
            requiresQualityReview: false,
            handoffInconclusiveToAcceptanceGate: false,
            ...spec,
            requireProcessQuiescenceCertification:
                spec.requireProcessQuiescenceCertification ?? false,
            // `StoryFactory` legitimately forwards an optional timeout. Keep
            // an omitted/explicit-undefined value from erasing the default;
            // nullish coalescing deliberately preserves an explicit 0ms test
            // or operator configuration.
            turnReviewTimeoutMs: spec.turnReviewTimeoutMs ?? 240_000,
        }
        if (this.spec.requiresQualityReview && !this.spec.turnReviewAuthority) {
            throw new Error(`StoryAgent ${spec.id} requires a turnReviewAuthority`)
        }
        this.done = new Promise<StoryOutcome>((res) => {
            this.resolveDone = res
        })
    }

    get id(): string {
        return this.spec.id
    }

    /** Mark "agentId" so observer helpers can attribute events. */
    get agentId(): string {
        return this.spec.id
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    getCurrentClaude(): ClaudeCliParticipant | null {
        return this.currentClaude
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
    run(environment: AgenticEnvironment): Promise<StoryOutcome> {
        if (this.startedAt != null) {
            return this.done
        }
        this.envRef = environment
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    /**
     * Observes AgentTargetedMessage / AgentResult for quiet-timer timing only.
     * Stdin forwarding is owned by ClaudeCliParticipant.onExternalEvent —
     * doing it here too would double-deliver.
     */
    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            AgentTargetedMessage.is(event) &&
            acceptsTargetedMessage(
                source,
                event.data,
                this.spec.id,
                this.spec.targetedMessageAuthority,
                this.spec,
            ) &&
            !(
                this.spec.requiresQualityReview &&
                typeof event.data.metadata.terminalId === "string"
            )
        ) {
            this.turnLifecycle?.observeMessage()
        }

        if (
            source === this.currentClaude &&
            AgentResult.is(event) &&
            event.data.agentId === this.spec.id
        ) {
            this.turnLifecycle?.observeResult(
                criticInput(event)?.terminalId ?? null,
            )
        }

        if (
            this.spec.requiresQualityReview &&
            source === this.spec.turnReviewAuthority &&
            Critique.is(event) &&
            event.data.agentId === this.spec.id &&
            event.data.terminalId
        ) {
            this.turnLifecycle?.deliverReview(event.data)
        }

        if (
            ClaudeRateLimit.is(event) &&
            event.data.agentId === this.spec.id &&
            source === this.currentClaude &&
            classifyProviderFailure(event.data.raw)
        ) {
            const eventSession = stringField(event.data.raw, "session_id")
            const activeSession = this.currentClaude?.getSessionId()
            if (!eventSession || !activeSession || eventSession === activeSession) {
                this.currentProviderCapacitySignal = event.data.raw
            }
        }
    }

    abort(): void {
        this.stopRequested = true
        this.wakeRetryDelay()
        this.quiesceCurrentClaude()
        this.transition("aborted", "external abort")
    }

    async suspend(blockId: string): Promise<StoryOutcome> {
        this.recordSuspension(blockId)
        this.stopRequested = true
        this.wakeRetryDelay()
        this.transition("aborted", `dependency suspension ${blockId}`)
        const quiesced = await this.quiesceCurrentClaude()
        if (!quiesced) {
            throw new Error(
                `story ${this.spec.id} process group quiescence could not be certified`,
            )
        }
        return this.done
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: ClaudeRunSummary | null = null
        let lastError: string | null = null
        let lastFailure: StoryFailureData | undefined
        let attempts = 0
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.wakeRetryDelay()
                      this.quiesceCurrentClaude()
                  }, this.spec.hardTimeoutSecs * 1000)
                : null

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (this.stopRequested) break
                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }

                if (attempt > 1) {
                    if (this.stopRequested) break
                    this.transition(
                        "waiting",
                        `retrying (attempt ${attempt}/${maxAttempts})`,
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

                attempts = attempt
                const result = await this.runOneAttempt(attempt)
                lastSummary = result.summary
                lastError = result.error
                lastFailure = result.failure

                if (this.hasUncertifiedRequiredProcess()) {
                    lastError = this.quiescenceFailureMessage()
                    lastFailure = quiescenceFailure()
                    this.suspension = null
                    break
                }
                if (this.stopRequested) break
                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }
                if (result.success) {
                    const durationSecs = Math.round(
                        (Date.now() - (this.startedAt ?? Date.now())) / 1000,
                    )
                    this.transition("done", `success on attempt ${attempt}`)
                    this.emitStoryResult(true, attempt, durationSecs, null)
                    this.resolveDone({
                        storyId: this.spec.id,
                        success: true,
                        attempts: attempt,
                        durationSecs,
                        finalSummary: result.summary,
                        error: null,
                    })
                    return
                }

                // Typed operational lanes belong to Board/Broker recovery;
                // only execution failures and legacy untyped outcomes consume
                // this agent's local retry budget. Provider capacity remains
                // included here so another route can bid immediately.
                if (boardOwnsRecovery(result.failure)) break

            }
        } finally {
            if (hardTimer !== null) clearTimeout(hardTimer)
        }

        await this.processQuiescence

        const quiescenceUncertified = this.hasUncertifiedRequiredProcess()
        if (quiescenceUncertified) {
            lastError = this.quiescenceFailureMessage()
            lastFailure = quiescenceFailure()
            this.suspension = null
        }

        if (!quiescenceUncertified && this.suspension) {
            lastError = null
            lastFailure = undefined
        } else if (!quiescenceUncertified && this.stopRequested) {
            lastError = "story execution aborted externally"
            lastFailure = undefined
        }

        const durationSecs = Math.round(
            (Date.now() - (this.startedAt ?? Date.now())) / 1000,
        )
        if (quiescenceUncertified) {
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
                lastFailure?.kind === "provider_capacity"
                    ? `provider capacity unavailable after ${attempts} attempt(s)`
                    : boardOwnsRecovery(lastFailure)
                      ? `operational failure after ${attempts} attempt(s)`
                      : `exhausted ${attempts}/${maxAttempts} attempts`,
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
    ): Promise<{
        success: boolean
        summary: ClaudeRunSummary | null
        error: string | null
        failure?: StoryFailureData
    }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.processQuiescence = null
        this.currentProcessSpawned = false
        this.currentProcessQuiesced = false
        this.transition("running", `attempt ${attempt}`)
        // Capacity evidence is scoped to one CLI process. Never let a late
        // failure from an earlier retry taint a fresh attempt.
        this.currentProviderCapacitySignal = undefined

        const claude = new ClaudeCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            model: this.spec.model,
            effort: this.spec.effort,
            claudeBin: this.spec.claudeBin,
            targetedMessageAuthority: this.spec.targetedMessageAuthority,
            targetedMessageCorrelation: correlationOf(this.spec),
            ignoreCorrelatedTerminalFeedback:
                this.spec.requiresQualityReview,
            ...(this.spec.requiresQualityReview && this.spec.turnReviewAuthority
                ? {
                      ignoredTargetedMessageAuthority:
                          this.spec.turnReviewAuthority,
                  }
                : {}),
        })
        this.currentClaude = claude
        this.terminalSourceRegistrar?.(claude)
        claude.join(this.envRef)
        claude.start(this.envRef)
        this.currentProcessSpawned = claude.hasSpawnedProcess()

        // Claude --print --input-format stream-json emits nothing until it
        // consumes an input event or stdin closes — waiting on `claude.ready`
        // first would deadlock. Send the prompt up front; stdin stays open
        // and the multi-turn lifecycle closes it.
        try {
            claude.sendUserMessage(this.spec.prompt)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            await this.quiesceCurrentClaude()
            claude.leave(this.envRef)
            this.currentClaude = null
            return {
                success: false,
                summary: null,
                error,
                failure: {
                    kind: "infrastructure",
                    code: "process_spawn_failed",
                },
            }
        }

        const multiTurn = this.setupMultiTurnLifecycle(claude)

        let summary: ClaudeRunSummary
        try {
            summary = await raceWithTimeout(
                claude.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            multiTurn.cancel()
            if (this.turnLifecycle === multiTurn) this.turnLifecycle = null
            await this.quiesceCurrentClaude()
            const error = e instanceof Error ? e.message : String(e)
            claude.leave(this.envRef)
            this.currentClaude = null
            const failure = e instanceof StoryAttemptTimeoutError
                ? {
                      kind: "infrastructure" as const,
                      code: "command_timeout" as const,
                  }
                : classifyStoryFailure(e)
            return {
                success: false,
                summary: null,
                error,
                ...(failure ? { failure } : {}),
            }
        }

        // Normal `done` already owns tree cleanup. The close-drain watchdog
        // intentionally resolves it early, so confirm quiescence through the
        // stronger participant boundary before releasing this attempt.
        await this.quiesceCurrentClaude()
        multiTurn.cancel()
        if (this.turnLifecycle === multiTurn) this.turnLifecycle = null
        claude.leave(this.envRef)
        this.currentClaude = null

        const reviewFailure = multiTurn.failure()
        if (reviewFailure) {
            return {
                success: false,
                summary,
                error: reviewFailure.error,
                failure: reviewFailure.failure,
            }
        }

        const success =
            summary.exitCode === 0 &&
            summary.error == null &&
            summary.lastResult != null &&
            !summary.lastResult.isError

        if (!success) {
            const described = describeClaudeFailure(
                summary,
                this.currentProviderCapacitySignal,
            )
            return { success: false, summary, ...described }
        }

        return { success: true, summary, error: null }
    }

    /**
     * Wires the quiet timer + turn counter for one attempt. The returned
     * cancel stops the timer WITHOUT closing stdin (for timeout/error aborts).
     */
    private setupMultiTurnLifecycle(claude: ClaudeCliParticipant): {
        cancel(): void
        failure(): { error: string; failure: StoryFailureData } | null
    } {
        const lifecycle = new StreamingTurnLifecycle({
            requiresReview: this.spec.requiresQualityReview,
            maxTurns: this.spec.maxTurns,
            quietTimeoutMs: this.spec.quietTimeoutMs,
            reviewTimeoutMs: this.spec.turnReviewTimeoutMs,
            handoffInconclusiveToAcceptanceGate:
                this.spec.handoffInconclusiveToAcceptanceGate,
            onFinish: () => {
                claude.closeStdin()
                if (this.turnLifecycle === lifecycle) this.turnLifecycle = null
            },
            onRevision: (feedback) => claude.sendUserMessage(feedback),
            revisionFailure: (error) => ({
                error:
                    `could not continue reviewed Claude session: ` +
                    ((error as Error)?.message ?? String(error)),
                failure: {
                    kind: "infrastructure",
                    code: "process_spawn_failed",
                },
            }),
        })
        this.turnLifecycle = lifecycle
        return lifecycle
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

    private quiesceCurrentClaude(): Promise<boolean> {
        const claude = this.currentClaude
        if (!claude) return this.processQuiescence ?? Promise.resolve(true)
        this.currentProcessSpawned ||= claude.hasSpawnedProcess()
        if (!this.processQuiescence) {
            this.processQuiescence = claude.abortAndWait().then((certified) => {
                this.currentProcessQuiesced = certified
                return certified
            })
        }
        return this.processQuiescence
    }

    private hasUncertifiedRequiredProcess(): boolean {
        return (
            this.spec.requireProcessQuiescenceCertification &&
            this.currentProcessSpawned &&
            !this.currentProcessQuiesced
        )
    }

    private quiescenceFailureMessage(): string {
        return (
            "claude process group quiescence could not be certified; " +
            "stopped without workspace cleanup"
        )
    }

    private async waitForRetryDelay(): Promise<void> {
        try {
            await setTimeoutPromise(this.spec.retryDelayMs, undefined, {
                signal: this.retryDelayController.signal,
            })
        } catch (error) {
            // Loop flags remain authoritative. Aborting this timer only wakes
            // the loop so it can settle without launching another attempt.
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

function describeClaudeFailure(
    summary: ClaudeRunSummary,
    capacitySignal?: unknown,
): {
    error: string
    failure?: StoryFailureData
} {
    const result = summary.lastResult
    const failure = classifyStoryFailure(
        capacitySignal,
        summary.error,
        result?.resultText,
        result ? { code: result.subtype } : undefined,
    )
    if (failure) {
        const detail = compactProviderFailureDetail(
            result?.resultText ?? summary.error,
        )
        const resultLabel = result ? ` (result:${result.subtype})` : ""
        return {
            error: `${failureSummary(failure)}${resultLabel}${detail ? `: ${detail}` : ""}`,
            failure,
        }
    }
    if (summary.error) return { error: summary.error.message }
    if (result?.isError) {
        return { error: describeClaudeResultError(result) }
    }
    return { error: `non-zero exit ${summary.exitCode}` }
}

function stringField(value: unknown, key: string): string | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const field = (value as Record<string, unknown>)[key]
    return typeof field === "string" ? field : undefined
}

function boardOwnsRecovery(failure: StoryFailureData | undefined): boolean {
    return failure !== undefined && failure.kind !== "execution"
}

function quiescenceFailure(): StoryFailureData {
    return {
        kind: "infrastructure",
        code: "process_quiescence_uncertified",
    }
}

function describeClaudeResultError(result: AgentResultData): string {
    return `claude reported isError on result:${result.subtype}`
}

export function correlationOf(
    spec: Pick<StorySpec, "runId" | "leaseId" | "generation">,
): { runId: string; leaseId: string; generation: number } | Record<string, never> {
    return spec.runId && spec.leaseId && spec.generation != null
        ? {
              runId: spec.runId,
              leaseId: spec.leaseId,
              generation: spec.generation,
          }
        : {}
}

function raceWithTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new StoryAttemptTimeoutError(label)), ms)
    })
    return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
    })
}

class StoryAttemptTimeoutError extends Error {}

function failureSummary(failure: StoryFailureData): string {
    switch (failure.kind) {
        case "provider_capacity":
            return "claude provider capacity unavailable"
        case "transport":
            return "claude provider transport failed"
        case "infrastructure":
            return "claude execution infrastructure failed"
        case "verification":
            return "claude verification failed"
        case "execution":
            return "claude story execution failed"
    }
}
