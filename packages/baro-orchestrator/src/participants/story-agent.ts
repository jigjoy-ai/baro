/**
 * StoryAgent — story-level wrapper that drives a ClaudeCliParticipant
 * through a single piece of work, with retries and timeout.
 *
 * Lifecycle:
 *   idle ─► starting ─► running ─► done | failed
 *                               ╰► retrying ─► running ─► …
 *
 * Multi-turn lifecycle (per attempt):
 *   1. Claude process starts; the initial prompt is written to stdin.
 *   2. Stdin stays OPEN so further user messages can be injected.
 *   3. A quiet timer (quietTimeoutMs, default 2 000 ms) starts after the
 *      first AgentResultItem arrives for this story. It resets whenever
 *      another AgentResultItem arrives or whenever an AgentTargetedMessageItem
 *      addressed to this story is forwarded to Claude stdin.
 *   4. Stdin is closed (ending the turn stream) when EITHER:
 *      (a) the quiet timer fires — Claude has been silent for quietTimeoutMs, or
 *      (b) maxTurns AgentResultItems have been observed for this agentId.
 *   5. A per-story hard timeout (hardTimeoutSecs, default 300 s) caps the
 *      entire story across all attempts, aborting Claude unconditionally.
 *
 * Single-turn stories work unchanged: the quiet timer fires 2 s after the
 * lone result event, closeStdin() is called, and claude.done resolves normally.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { BaroEnvironment } from "../bus.js"
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
    /** The prompt sent to Claude as the initial user message. */
    prompt: string
    /** Working directory for Claude. */
    cwd: string
    /** Optional model override (e.g. "sonnet", "opus", "haiku"). */
    model?: string
    /** Retry budget (number of *additional* attempts after the first). */
    retries?: number
    /** Per-attempt timeout in seconds. Default: 600. */
    timeoutSecs?: number
    /** Delay between retries in milliseconds. Default: 1500. */
    retryDelayMs?: number
    /**
     * Milliseconds of silence (no AgentResultItem for this story) after which
     * stdin is closed to end the multi-turn session. Default: 2000.
     */
    quietTimeoutMs?: number
    /**
     * Maximum number of AgentResultItem events (turns) to observe before
     * closing stdin unconditionally. Default: 4.
     */
    maxTurns?: number
    /**
     * Hard cap in seconds for the entire story across all attempts. The
     * Claude process is aborted unconditionally when this fires. Default: 300.
     */
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

// StoryResultItem (was a BusEvent subclass defined here) moves to
// semantic-events.ts as `StoryResult` (defineSemanticEvent factory). The
// wire `type` string stays "story_result".

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

    private envRef: BaroEnvironment | null = null
    private currentClaude: ClaudeCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: StoryOutcome) => void
    public readonly done: Promise<StoryOutcome>

    // Callbacks wired up during an attempt's multi-turn lifecycle.
    // Nulled out when the attempt ends.
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
            // hardTimeoutSecs <= 0 disables the absolute kill timer.
            // The previous default of 300s was killing real refactor
            // work mid-flight (e.g. "delete SEF module" touches dozens
            // of files and routinely needs >5 minutes); we'd rather
            // let the per-attempt timeoutSecs and the quiet-timer
            // close out idle agents than guillotine a productive one.
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

    /**
     * Begin executing the story. Idempotent. Returns the `done` promise
     * for the caller's convenience.
     */
    run(environment: BaroEnvironment): Promise<StoryOutcome> {
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
     * Forward bus messages targeted at this story to its current Claude
     * process. Resets the multi-turn quiet timer on both result and message
     * events so the session stays open while activity is ongoing.
     *
     * StoryAgent is the sole owner of AgentTargetedMessageItem → stdin
     * forwarding. ClaudeCliParticipant.onContextItem does NOT do this.
     */
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // StoryAgent observes AgentTargetedMessage and AgentResult for
        // lifecycle/timing purposes only. The actual stdin forwarding is
        // owned by ClaudeCliParticipant.onExternalEvent to avoid
        // double-delivery.
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

    /** Abort the story, killing the running Claude (if any). */
    abort(): void {
        this.currentClaude?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: ClaudeRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        // hardTimeoutSecs <= 0 means "no absolute cap" — the timer is
        // not started. The per-attempt timeoutSecs still bounds each
        // individual Claude invocation, and the quiet timer still
        // closes idle stdin streams.
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
        })
        this.currentClaude = claude
        claude.join(this.envRef)
        claude.start(this.envRef)

        // Claude --print --input-format stream-json doesn't begin
        // emitting events until it has consumed at least one input event
        // OR stdin is closed. Waiting on `claude.ready` first would
        // deadlock — send the prompt up front, then await events.
        try {
            claude.sendUserMessage(this.spec.prompt)
            // stdin stays open — multi-turn lifecycle closes it
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
     * Wires up the multi-turn quiet timer and turn counter for one attempt.
     * Returns a cancel function that stops the timer and clears callbacks
     * without closing stdin (used when aborting due to timeout/error).
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
