/**
 * PiStoryAgent — drives a PiCliParticipant through one story with retries and
 * per-attempt timeout. Pi `-p` is one-shot (fresh process per attempt, no
 * multi-turn stdin dance); retry/timeout defaults match StoryAgent so
 * orchestrator-level semantics stay uniform across backends.
 */

import { setTimeout as setTimeoutPromise } from "timers/promises"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentState,
    StoryResult,
    type AgentPhase,
} from "../semantic-events.js"
import {
    PiCliParticipant,
    type PiRunSummary,
} from "./pi-cli-participant.js"
import { correlationOf } from "./story-agent.js"

export interface PiStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
    /** Provider override; omit to use Pi's configured default ("google"). */
    provider?: string
    /** Model override, passed through as an opaque string. */
    model?: string
    piBin?: string
    /** Number of *additional* attempts after the first. */
    retries?: number
    /** Per-attempt timeout in seconds. */
    timeoutSecs?: number
    retryDelayMs?: number
    /** Hard cap in seconds for the whole story across all attempts; <= 0 disables. */
    hardTimeoutSecs?: number
}

export interface PiStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: PiRunSummary | null
    error: string | null
}

export class PiStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            PiStorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "hardTimeoutSecs"
        >
    > &
        PiStorySpec

    private envRef: AgenticEnvironment | null = null
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private currentPi: PiCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: PiStoryOutcome) => void
    public readonly done: Promise<PiStoryOutcome>

    constructor(spec: PiStorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            ...spec,
        }
        this.done = new Promise<PiStoryOutcome>((res) => {
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

    getCurrentPi(): PiCliParticipant | null {
        return this.currentPi
    }

    setResultAuthority(source: Participant): void {
        if (this.resultAuthority && this.resultAuthority !== source) {
            throw new Error(`result authority already set for ${this.spec.id}`)
        }
        this.resultAuthority = source
    }

    /** Idempotent; returns the `done` promise. */
    run(environment: AgenticEnvironment): Promise<PiStoryOutcome> {
        if (this.startedAt != null) {
            return this.done
        }
        this.envRef = environment
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    /** No-op: Pi `-p` is one-shot — no stdin channel for mid-flight messages. */
    override async onExternalEvent(
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
    }

    /**
     * Kills the in-flight Pi child but does NOT settle `done` — that happens
     * via the attempt's normal exit/timeout path in `executeAllAttempts`.
     * The "aborted" transition is cosmetic and doesn't short-circuit it.
     */
    abort(): void {
        this.currentPi?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: PiRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.currentPi?.abort()
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
    ): Promise<{
        success: boolean
        summary: PiRunSummary | null
        error: string | null
    }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.transition("running", `attempt ${attempt}`)

        const pi = new PiCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            provider: this.spec.provider,
            model: this.spec.model,
            piBin: this.spec.piBin,
        })
        this.currentPi = pi
        pi.join(this.envRef)
        pi.start(this.envRef)

        let summary: PiRunSummary
        try {
            summary = await raceWithTimeout(
                pi.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            pi.abort()
            const error = e instanceof Error ? e.message : String(e)
            try {
                await pi.done
            } catch {
                // ignore
            }
            pi.leave(this.envRef)
            this.currentPi = null
            return { success: false, summary: null, error }
        }

        pi.leave(this.envRef)
        this.currentPi = null

        // Pi exits 0 even on a refusal or no-op, so success needs positive
        // evidence: the agent loop finished (`sawAgentEnd`) and at least one
        // tool call succeeded — no tools ⇒ it answered in prose, not edits.
        if (summary.exitCode !== 0 || summary.error != null) {
            const reason = summary.error
                ? summary.error.message
                : `non-zero exit ${summary.exitCode}`
            return { success: false, summary, error: reason }
        }
        if (!summary.sawAgentEnd) {
            return {
                success: false,
                summary,
                error: "pi exited 0 but emitted no agent_end — the agent loop did not complete",
            }
        }
        if (summary.toolSuccessCount === 0) {
            return {
                success: false,
                summary,
                error:
                    summary.toolCallCount === 0
                        ? "pi exited 0 but invoked no tools — answered in prose without editing the worktree"
                        : "pi exited 0 and invoked tools but every tool call failed (isError) — the worktree was not successfully edited",
            }
        }

        return { success: true, summary, error: null }
    }

    private emitStoryResult(
        success: boolean,
        attempts: number,
        durationSecs: number,
        error: string | null,
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
                ...correlationOf(this.spec),
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
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>(
        (_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms) },
    )
    // finally (not then) so a rejection of `p` also clears the timer,
    // which would otherwise keep the event loop alive up to `ms`.
    const settled = p.finally(() => clearTimeout(timer))
    // If the timeout wins, a later rejection of `p` would be unhandled
    // (Node >= 15); the race already propagated the outcome, so swallow it.
    settled.catch(() => {})
    return Promise.race([settled, timeout])
}
