/**
 * CodexStoryAgent — drives a CodexCliParticipant through one story with
 * retries and per-attempt timeout. `codex exec` is one-shot (fresh process
 * per attempt, no multi-turn stdin dance); retry/timeout defaults match
 * StoryAgent so orchestrator-level semantics stay uniform.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentState,
    CodexSystem,
    CodexTurnEvent,
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
    CodexCliParticipant,
    CodexRunSummary,
} from "./codex-cli-participant.js"
import { correlationOf, type StorySuspension } from "./story-agent.js"

export interface CodexStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    /** Must be a git repo (Codex enforces). */
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    targetedMessageAuthority?: Participant
    model?: string
    codexBin?: string
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
    /**
     * Pass `--dangerously-bypass-approvals-and-sandbox`. Required: Codex's
     * `workspace-write` sandbox blocks `.git/` writes, so the agent can't
     * commit. The danger is bounded by the per-story git worktree
     * (WorktreeManager, #50), merged back only on success.
     */
    bypassSandbox?: boolean
    /**
     * Pass `--skip-git-repo-check`. Story workers run inside a per-story git
     * worktree (a valid repo), so default false; only for tests/one-offs.
     */
    skipGitRepoCheck?: boolean
}

export interface CodexStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: CodexRunSummary | null
    error: string | null
    failure?: StoryFailureData
    suspension?: StorySuspension
}

export class CodexStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            CodexStorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "hardTimeoutSecs"
            | "bypassSandbox"
            | "skipGitRepoCheck"
        >
    > &
        CodexStorySpec

    private envRef: AgenticEnvironment | null = null
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private terminalSourceRegistrar: ((source: Participant) => void) | null = null
    private currentCodex: CodexCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private currentFailureSignals: unknown[] = []
    private stopRequested = false
    /** Lifecycle signal also closes the tiny transition→timer lost-wake window. */
    private readonly retryDelayController = new AbortController()
    private suspension: StorySuspension | null = null
    private processQuiescence: Promise<boolean> | null = null
    private resolveDone!: (outcome: CodexStoryOutcome) => void
    public readonly done: Promise<CodexStoryOutcome>

    constructor(spec: CodexStorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            bypassSandbox: true,
            skipGitRepoCheck: false,
            ...spec,
        }
        this.done = new Promise<CodexStoryOutcome>((res) => {
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

    getCurrentCodex(): CodexCliParticipant | null {
        return this.currentCodex
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
    run(environment: AgenticEnvironment): Promise<CodexStoryOutcome> {
        if (this.startedAt != null) {
            return this.done
        }
        this.envRef = environment
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    /** No-op: Codex exec is one-shot — no stdin channel for mid-flight messages. */
    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (source !== this.currentCodex) return
        if (
            (CodexSystem.is(event) && event.data.subtype === "error") ||
            (CodexTurnEvent.is(event) && event.data.phase === "failed")
        ) {
            this.currentFailureSignals.push(event.data.raw)
        }
    }

    abort(): void {
        this.stopRequested = true
        this.wakeRetryDelay()
        this.quiesceCurrentCodex()
        this.transition("aborted", "external abort")
    }

    async suspend(blockId: string): Promise<CodexStoryOutcome> {
        this.recordSuspension(blockId)
        this.stopRequested = true
        this.wakeRetryDelay()
        this.transition("aborted", `dependency suspension ${blockId}`)
        const quiesced = await this.quiesceCurrentCodex()
        if (!quiesced) {
            throw new Error(
                `story ${this.spec.id} process group quiescence could not be certified`,
            )
        }
        return this.done
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: CodexRunSummary | null = null
        let lastError: string | null = null
        let lastFailure: StoryFailureData | undefined
        let attempts = 0
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.wakeRetryDelay()
                      this.quiesceCurrentCodex()
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
        summary: CodexRunSummary | null
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

        const codex = new CodexCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            model: this.spec.model,
            codexBin: this.spec.codexBin,
            bypassSandbox: this.spec.bypassSandbox,
            skipGitRepoCheck: this.spec.skipGitRepoCheck,
            targetedMessageAuthority: this.spec.targetedMessageAuthority,
            targetedMessageCorrelation: correlationOf(this.spec),
        })
        this.currentCodex = codex
        this.terminalSourceRegistrar?.(codex)
        codex.join(this.envRef)
        codex.start(this.envRef)

        let summary: CodexRunSummary
        try {
            summary = await raceWithTimeout(
                codex.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            await this.quiesceCurrentCodex()
            const error = e instanceof Error ? e.message : String(e)
            let stderrTail: string | null = null
            try {
                stderrTail = (await codex.done).stderrTail
            } catch {
                // ignore
            }
            codex.leave(this.envRef)
            this.currentCodex = null
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

        await this.quiesceCurrentCodex()
        codex.leave(this.envRef)
        this.currentCodex = null

        const failureSignals = [
            ...this.currentFailureSignals,
            summary.stderrTail,
        ]
        const reportedFailure = failureSignals.some((signal) =>
            isCliFailureSignal(signal, ""),
        )
        const success =
            summary.exitCode === 0 &&
            summary.error == null &&
            !reportedFailure

        if (!success) {
            const reason = summary.error
                ? summary.error.message
                : reportedFailure
                  ? "codex reported a failed turn"
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

    private quiesceCurrentCodex(): Promise<boolean> {
        const codex = this.currentCodex
        if (!codex) return this.processQuiescence ?? Promise.resolve(true)
        if (!this.processQuiescence) {
            this.processQuiescence = codex.abortAndWait()
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
