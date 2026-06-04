/**
 * OpenCodeStoryAgent — story-level wrapper that drives an
 * OpenCodeCliParticipant through a single piece of work, with retries
 * and per-attempt timeout. Sibling of `codex-story-agent.ts` (Codex)
 * and `story-agent.ts` (Claude).
 *
 * Lifecycle is simpler than the Claude variant because OpenCode `run` is
 * one-shot: each attempt spawns a fresh `opencode run --format json`
 * process, which streams events and exits when the agent finishes. There
 * is no multi-turn quiet-timer / stdin-injection dance.
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
    OpenCodeCliParticipant,
    type OpenCodeRunSummary,
} from "./opencode-cli-participant.js"

/** Specification for an OpenCode-backed story execution. */
export interface OpenCodeStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    /** The prompt sent to OpenCode as the initial user message. */
    prompt: string
    /** Working directory for OpenCode. */
    cwd: string
    /** Optional model override (e.g. "anthropic/claude-sonnet-4-20250514"). */
    model?: string
    /** Retry budget (number of *additional* attempts after the first). */
    retries?: number
    /** Per-attempt timeout in seconds. Default: 600. */
    timeoutSecs?: number
    /** Delay between retries in milliseconds. Default: 1500. */
    retryDelayMs?: number
    /**
     * Hard cap in seconds for the entire story across all attempts. The
     * OpenCode process is aborted unconditionally when this fires. <= 0
     * disables the absolute kill timer. Default: 0 (matches StoryAgent).
     */
    hardTimeoutSecs?: number
    /**
     * Whether to pass `--dangerously-skip-permissions`. Required for
     * autonomous baro runs because OpenCode's default mode prompts for
     * tool approvals. Default: true.
     */
    skipPermissions?: boolean
}

/** Outcome of a completed (passed or exhausted) story execution. */
export interface OpenCodeStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: OpenCodeRunSummary | null
    error: string | null
}

/**
 * Mozaik observer that runs a story on the OpenCode backend with retry
 * logic and timeout management.
 */
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
    private currentOpenCode: OpenCodeCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
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

    /**
     * Begin executing the story. Idempotent. Returns the `done` promise
     * for the caller's convenience.
     */
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

    /**
     * No-op: OpenCode run is one-shot, there's no stdin channel to forward
     * mid-flight messages to.
     */
    override async onExternalEvent(
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Intentionally empty — OpenCode run doesn't have the multi-turn
        // stdin lifecycle that StoryAgent uses for Claude.
    }

    /** Abort the story, killing the running OpenCode (if any). */
    abort(): void {
        this.currentOpenCode?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: OpenCodeRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.currentOpenCode?.abort()
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
        summary: OpenCodeRunSummary | null
        error: string | null
    }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.transition("running", `attempt ${attempt}`)

        const opencode = new OpenCodeCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            model: this.spec.model,
            skipPermissions: this.spec.skipPermissions,
        })
        this.currentOpenCode = opencode
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
            opencode.abort()
            const error = e instanceof Error ? e.message : String(e)
            try {
                await opencode.done
            } catch {
                // ignore
            }
            opencode.leave(this.envRef)
            this.currentOpenCode = null
            return { success: false, summary: null, error }
        }

        opencode.leave(this.envRef)
        this.currentOpenCode = null

        // Success requires POSITIVE evidence of completed work, not
        // merely the absence of a crash. `opencode run` exits 0 even when
        // the model refuses the task or produces no edits (verified
        // empirically: a refusal turn returns exitCode 0), so a clean exit
        // alone would mark a no-op story as passed. We therefore also
        // require the agent loop to have actually finished (`sawStepFinish`)
        // and to have invoked at least one tool — a code-writing story that
        // claims success having touched no tools almost certainly answered
        // in prose instead of editing the worktree. This brings the
        // OpenCode predicate up to (and slightly past) the Claude path,
        // which gates on a non-error result payload.
        if (summary.exitCode !== 0 || summary.error != null) {
            const reason = summary.error
                ? summary.error.message
                : `non-zero exit ${summary.exitCode}`
            return { success: false, summary, error: reason }
        }
        if (!summary.sawStepFinish) {
            return {
                success: false,
                summary,
                error: "opencode exited 0 but emitted no step_finish — the agent loop did not complete (likely a refusal or early abort)",
            }
        }
        if (summary.toolCallCount === 0) {
            return {
                success: false,
                summary,
                error: "opencode exited 0 but invoked no tools — the agent answered in prose without editing the worktree, so the story is not verifiably done",
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
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
    ])
}
