/**
 * StoryAgent — drives a ClaudeCliParticipant through one story with retries
 * and timeouts. Multi-turn: stdin stays OPEN after the initial prompt so
 * corrective messages can be injected; a quiet timer (started on the first
 * AgentResult, reset on further results/targeted messages) or the maxTurns
 * cap closes stdin to end the session.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    StoryResult,
    type AgentPhase,
} from "../semantic-events.js"
import {
    ClaudeCliParticipant,
    ClaudeRunSummary,
} from "./claude-cli-participant.js"

export interface StorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
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
}

export interface StoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: ClaudeRunSummary | null
    error: string | null
}

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
        >
    > &
        StorySpec

    private envRef: AgenticEnvironment | null = null
    private currentClaude: ClaudeCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: StoryOutcome) => void
    public readonly done: Promise<StoryOutcome>

    // Wired up per attempt by setupMultiTurnLifecycle; nulled when it ends.
    private notifyStoryResult: (() => void) | null = null
    private notifyStoryMessage: (() => void) | null = null

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
            ...spec,
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
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.spec.id
        ) {
            this.notifyStoryMessage?.()
        }

        if (AgentResult.is(event) && event.data.agentId === this.spec.id) {
            this.notifyStoryResult?.()
        }
    }

    abort(): void {
        this.currentClaude?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: ClaudeRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.currentClaude?.abort()
                  }, this.spec.hardTimeoutSecs * 1000)
                : null

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (hardTimedOut) {
                    lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                    break
                }

                if (attempt > 1) {
                    this.transition(
                        "waiting",
                        `retrying (attempt ${attempt}/${maxAttempts})`,
                    )
                    await setTimeoutPromise(this.spec.retryDelayMs)
                    if (hardTimedOut) {
                        lastError = `hard timeout after ${this.spec.hardTimeoutSecs}s`
                        break
                    }
                }

                const result = await this.runOneAttempt(attempt)
                lastSummary = result.summary
                lastError = result.error

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
                    break
                }
            }
        } finally {
            if (hardTimer !== null) clearTimeout(hardTimer)
        }

        const durationSecs = Math.round(
            (Date.now() - (this.startedAt ?? Date.now())) / 1000,
        )
        this.transition("failed", `exhausted ${maxAttempts} attempts`)
        this.emitStoryResult(false, maxAttempts, durationSecs, lastError)
        this.resolveDone({
            storyId: this.spec.id,
            success: false,
            attempts: maxAttempts,
            durationSecs,
            finalSummary: lastSummary,
            error: lastError,
        })
    }

    private async runOneAttempt(
        attempt: number,
    ): Promise<{ success: boolean; summary: ClaudeRunSummary | null; error: string | null }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.transition("running", `attempt ${attempt}`)

        const claude = new ClaudeCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            model: this.spec.model,
            effort: this.spec.effort,
            claudeBin: this.spec.claudeBin,
        })
        this.currentClaude = claude
        claude.join(this.envRef)
        claude.start(this.envRef)

        // Claude --print --input-format stream-json emits nothing until it
        // consumes an input event or stdin closes — waiting on `claude.ready`
        // first would deadlock. Send the prompt up front; stdin stays open
        // and the multi-turn lifecycle closes it.
        try {
            claude.sendUserMessage(this.spec.prompt)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            claude.abort()
            claude.leave(this.envRef)
            this.currentClaude = null
            return { success: false, summary: null, error }
        }

        const cancelMultiTurn = this.setupMultiTurnLifecycle(claude)

        let summary: ClaudeRunSummary
        try {
            summary = await raceWithTimeout(
                claude.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            cancelMultiTurn()
            claude.abort()
            const error = e instanceof Error ? e.message : String(e)
            // Wait for the kill to land so subsequent attempts get a clean slate.
            try {
                await claude.done
            } catch {
                // ignore
            }
            claude.leave(this.envRef)
            this.currentClaude = null
            return { success: false, summary: null, error }
        }

        cancelMultiTurn()
        claude.leave(this.envRef)
        this.currentClaude = null

        const success =
            summary.exitCode === 0 &&
            summary.error == null &&
            summary.lastResult != null &&
            !summary.lastResult.isError

        if (!success) {
            const reason = summary.error
                ? summary.error.message
                : summary.lastResult?.isError
                  ? `claude reported isError on result:${summary.lastResult.subtype}`
                  : `non-zero exit ${summary.exitCode}`
            return { success: false, summary, error: reason }
        }

        return { success: true, summary, error: null }
    }

    /**
     * Wires the quiet timer + turn counter for one attempt. The returned
     * cancel stops the timer WITHOUT closing stdin (for timeout/error aborts).
     */
    private setupMultiTurnLifecycle(claude: ClaudeCliParticipant): () => void {
        let turnsObserved = 0
        let quietTimer: ReturnType<typeof setTimeout> | null = null
        let finished = false

        const finish = () => {
            if (finished) return
            finished = true
            if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
            this.notifyStoryResult = null
            this.notifyStoryMessage = null
            claude.closeStdin()
        }

        const resetQuietTimer = () => {
            if (quietTimer) clearTimeout(quietTimer)
            quietTimer = setTimeout(finish, this.spec.quietTimeoutMs)
        }

        this.notifyStoryResult = () => {
            turnsObserved++
            if (turnsObserved >= this.spec.maxTurns) {
                finish()
            } else {
                resetQuietTimer()
            }
        }

        // Reset the timer when a message is injected, but only once the
        // first result has arrived (timer already started).
        this.notifyStoryMessage = () => {
            if (quietTimer !== null) resetQuietTimer()
        }

        return () => {
            if (finished) return
            finished = true
            if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
            this.notifyStoryResult = null
            this.notifyStoryMessage = null
            // Caller is responsible for aborting the process.
        }
    }

    private emitStoryResult(
        success: boolean,
        attempts: number,
        durationSecs: number,
        error: string | null,
    ): void {
        if (!this.envRef) return
        this.envRef.deliverSemanticEvent(
            this,
            StoryResult.create({
                storyId: this.spec.id,
                success,
                attempts,
                durationSecs,
                error,
            }),
        )
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
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
    ])
}
