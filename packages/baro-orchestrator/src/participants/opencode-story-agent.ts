/**
 * OpenCodeStoryAgent — drives an OpenCodeCliParticipant through one story
 * with retries and per-attempt timeout. `opencode run` is one-shot (fresh
 * process per attempt, no multi-turn stdin dance); retry/timeout defaults
 * match StoryAgent so orchestrator-level semantics stay uniform.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentState,
    OpenCodeUnknownEvent,
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
    OpenCodeCliParticipant,
    type OpenCodeRunSummary,
} from "./opencode-cli-participant.js"
import { correlationOf, type StorySuspension } from "./story-agent.js"

export interface OpenCodeStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    /** Provider-qualified model, e.g. "anthropic/claude-sonnet-4-20250514". */
    model?: string
    opencodeBin?: string
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
    /**
     * Pass `--dangerously-skip-permissions`. Required for autonomous baro
     * runs — OpenCode's default mode prompts for tool approvals.
     */
    skipPermissions?: boolean
}

export interface OpenCodeStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: OpenCodeRunSummary | null
    error: string | null
    failure?: StoryFailureData
    suspension?: StorySuspension
}

export class OpenCodeStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            OpenCodeStorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "hardTimeoutSecs"
            | "skipPermissions"
        >
    > &
        OpenCodeStorySpec

    private envRef: AgenticEnvironment | null = null
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private terminalSourceRegistrar: ((source: Participant) => void) | null = null
    private currentOpenCode: OpenCodeCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private currentFailureSignals: unknown[] = []
    private stopRequested = false
    /** Lifecycle signal also closes the tiny transition→timer lost-wake window. */
    private readonly retryDelayController = new AbortController()
    private suspension: StorySuspension | null = null
    private processQuiescence: Promise<boolean> | null = null
    private resolveDone!: (outcome: OpenCodeStoryOutcome) => void
    public readonly done: Promise<OpenCodeStoryOutcome>

    constructor(spec: OpenCodeStorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            skipPermissions: true,
            ...spec,
        }
        this.done = new Promise<OpenCodeStoryOutcome>((res) => {
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

    getCurrentOpenCode(): OpenCodeCliParticipant | null {
        return this.currentOpenCode
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
    run(environment: AgenticEnvironment): Promise<OpenCodeStoryOutcome> {
        if (this.startedAt != null) {
            return this.done
        }
        this.envRef = environment
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    /** No-op: OpenCode run is one-shot — no stdin channel for mid-flight messages. */
    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            source === this.currentOpenCode &&
            OpenCodeUnknownEvent.is(event) &&
            isCliFailureSignal(event.data.raw, event.data.openCodeType)
        ) {
            this.currentFailureSignals.push(event.data.raw)
        }
    }

    abort(): void {
        this.stopRequested = true
        this.wakeRetryDelay()
        this.quiesceCurrentOpenCode()
        this.transition("aborted", "external abort")
    }

    async suspend(blockId: string): Promise<OpenCodeStoryOutcome> {
        this.recordSuspension(blockId)
        this.stopRequested = true
        this.wakeRetryDelay()
        this.transition("aborted", `dependency suspension ${blockId}`)
        const quiesced = await this.quiesceCurrentOpenCode()
        if (!quiesced) {
            throw new Error(
                `story ${this.spec.id} process group quiescence could not be certified`,
            )
        }
        return this.done
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: OpenCodeRunSummary | null = null
        let lastError: string | null = null
        let lastFailure: StoryFailureData | undefined
        let attempts = 0
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.wakeRetryDelay()
                      this.quiesceCurrentOpenCode()
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

                if (this.stopRequested) break
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

                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    lastFailure = {
                        kind: "infrastructure",
                        code: "command_timeout",
                    }
                    break
                }
                if (boardOwnsCliRecovery(result.failure)) break
            }
        } finally {
            if (hardTimer !== null) clearTimeout(hardTimer)
        }

        await this.processQuiescence

        if (this.suspension) {
            lastError = null
            lastFailure = undefined
        } else if (this.stopRequested) {
            lastError = "story execution aborted externally"
            lastFailure = undefined
        }

        const durationSecs = Math.round(
            (Date.now() - (this.startedAt ?? Date.now())) / 1000,
        )
        if (this.stopRequested) {
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
        summary: OpenCodeRunSummary | null
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
        this.transition("running", `attempt ${attempt}`)
        this.currentFailureSignals = []

        const opencode = new OpenCodeCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            model: this.spec.model,
            opencodeBin: this.spec.opencodeBin,
            skipPermissions: this.spec.skipPermissions,
        })
        this.currentOpenCode = opencode
        this.terminalSourceRegistrar?.(opencode)
        opencode.join(this.envRef)
        opencode.start(this.envRef)

        let summary: OpenCodeRunSummary
        try {
            summary = await raceWithTimeout(
                opencode.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            await this.quiesceCurrentOpenCode()
            const error = e instanceof Error ? e.message : String(e)
            let stderrTail: string | null = null
            try {
                stderrTail = (await opencode.done).stderrTail
            } catch {
                // ignore
            }
            opencode.leave(this.envRef)
            this.currentOpenCode = null
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

        await this.quiesceCurrentOpenCode()
        opencode.leave(this.envRef)
        this.currentOpenCode = null

        // `opencode run` exits 0 even on a refusal or no-op (verified
        // empirically), so success needs positive evidence: the agent loop
        // finished (`sawStepFinish`) and at least one tool was invoked —
        // no tools ⇒ it answered in prose, not edits.
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
                  ? "opencode reported a failed turn"
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
        if (!summary.sawStepFinish) {
            return {
                success: false,
                summary,
                ...describeCliStoryFailure(
                    "opencode exited 0 but emitted no step_finish — the agent loop did not complete (likely a refusal or early abort)",
                    { kind: "execution", code: "model_error" },
                ),
            }
        }
        if (summary.toolCallCount === 0) {
            return {
                success: false,
                summary,
                ...describeCliStoryFailure(
                    "opencode exited 0 but invoked no tools — the agent answered in prose without editing the worktree, so the story is not verifiably done",
                    { kind: "execution", code: "no_work_product" },
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

    private quiesceCurrentOpenCode(): Promise<boolean> {
        const opencode = this.currentOpenCode
        if (!opencode) return this.processQuiescence ?? Promise.resolve(true)
        if (!this.processQuiescence) {
            this.processQuiescence = opencode.abortAndWait()
        }
        return this.processQuiescence
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
