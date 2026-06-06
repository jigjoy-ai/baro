/**
 * PiStoryAgent — story-level wrapper that drives a PiCliParticipant
 * through a single piece of work, with retries and per-attempt timeout.
 * Sibling of `opencode-story-agent.ts` (OpenCode) and `story-agent.ts`
 * (Claude).
 *
 * Lifecycle mirrors OpenCodeStoryAgent because Pi `-p` is also one-shot:
 * each attempt spawns a fresh process, which streams events and exits
 * when the agent finishes. There is no multi-turn quiet-timer /
 * stdin-injection dance.
 *
 *   idle ─► starting ─► running ─► done | failed
 *                              ╰► retrying ─► running ─► …
 *
 * Outer retry budget and hard timeout match StoryAgent's defaults so
 * the orchestrator-level semantics are uniform across backends.
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

/** Specification for a Pi-backed story execution. */
export interface PiStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    /** The prompt sent to Pi as the initial user message. */
    prompt: string
    /** Working directory for Pi. */
    cwd: string
    /**
     * Provider override (e.g. "google", "anthropic"). Pi's default is
     * "google". Omit to use Pi's configured default.
     */
    provider?: string
    /** Optional model override. Treated as an opaque string. */
    model?: string
    /** Retry budget (number of *additional* attempts after the first). */
    retries?: number
    /** Per-attempt timeout in seconds. Default: 600. */
    timeoutSecs?: number
    /** Delay between retries in milliseconds. Default: 1500. */
    retryDelayMs?: number
    /**
     * Hard cap in seconds for the entire story across all attempts. The
     * Pi process is aborted unconditionally when this fires. <= 0
     * disables the absolute kill timer. Default: 0 (matches StoryAgent).
     */
    hardTimeoutSecs?: number
}

/** Outcome of a completed (passed or exhausted) story execution. */
export interface PiStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: PiRunSummary | null
    error: string | null
}

/**
 * Mozaik observer that runs a story on the Pi backend with retry logic
 * and timeout management.
 */
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

    /**
     * Begin executing the story. Idempotent. Returns the `done` promise
     * for the caller's convenience.
     */
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

    /**
     * No-op: Pi `-p` is one-shot, there's no stdin channel to forward
     * mid-flight messages to.
     */
    override async onExternalEvent(
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Intentionally empty — Pi run doesn't have the multi-turn stdin
        // lifecycle that StoryAgent uses for Claude.
    }

    /**
     * Abort the story, killing the running Pi process (if any).
     *
     * Note: this does NOT itself settle the `done` promise. It only
     * signals the in-flight Pi child to die; `done` settles later via the
     * attempt's normal exit/timeout path in `executeAllAttempts`
     * (`runOneAttempt` awaits `pi.done` and `resolveDone` runs once the
     * loop resolves or exhausts). The phase transition to "aborted" here
     * is cosmetic and does not short-circuit that flow.
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

        // Success requires POSITIVE evidence of completed work, not
        // merely the absence of a crash. Pi exits 0 even when the model
        // refuses the task or produces no edits, so a clean exit alone
        // would mark a no-op story as passed. We therefore also require
        // the agent loop to have actually finished (`sawAgentEnd`) and to
        // have invoked at least one tool — a code-writing story that
        // claims success having touched no tools almost certainly answered
        // in prose instead of editing the worktree.
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

/**
 * Race a promise against a timeout. Rejects with an Error carrying the
 * label on timeout.
 */
function raceWithTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>(
        (_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms) },
    )
    // Clear the timeout timer whether `p` fulfils OR rejects — clearing on
    // the fulfil branch only would leave the timer pending (and keeping the
    // event loop alive up to `ms`) on any rejection of `p`.
    const settled = p.finally(() => clearTimeout(timer))
    // If the timeout wins the race, `settled` stays pending and would surface
    // an UnhandledPromiseRejection should `p` later reject (Node ≥ 15). The
    // race already propagates the real outcome to the caller, so swallow the
    // now-unobserved rejection on the losing branch. Harmless for the current
    // sole caller (`pi.done` never rejects); makes the helper safe to reuse.
    settled.catch(() => { /* observed via the race; ignore late rejection */ })
    return Promise.race([settled, timeout])
}
