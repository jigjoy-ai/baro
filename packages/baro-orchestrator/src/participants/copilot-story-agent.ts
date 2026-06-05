/**
 * CopilotStoryAgent — story-level wrapper that drives a
 * CopilotCliParticipant through a single piece of work, with retries
 * and per-attempt timeout. Sibling of `story-agent.ts` (Claude),
 * `codex-story-agent.ts` (Codex), and `openai-story-agent.ts` (OpenAI API).
 *
 * Lifecycle is simpler than the Claude variant because Copilot `-p` is
 * one-shot: each attempt spawns a fresh `copilot -p ... --output-format
 * json` process, which streams JSONL events and exits when the agent
 * finishes. There is no multi-turn quiet-timer / stdin-injection dance.
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
    CopilotCliParticipant,
    CopilotRunSummary,
} from "./copilot-cli-participant.js"

export interface CopilotStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    /** The prompt sent to Copilot as the value of `-p`. */
    prompt: string
    /** Working directory for Copilot. */
    cwd: string
    /** Optional model override (e.g. "gpt-5", "claude-sonnet-4.5"). */
    model?: string
    /**
     * Raw baro effort value (`low|medium|high|xhigh|max`). Clamped to
     * Copilot's `low|medium|high` inside the participant before being
     * passed as `--reasoning-effort`; omitted when it clamps away.
     */
    effort?: string
    /** Path to the `copilot` binary. Default: "copilot" (resolved via PATH). */
    copilotBin?: string
    /** Retry budget (number of *additional* attempts after the first). */
    retries?: number
    /** Per-attempt timeout in seconds. Default: 600. */
    timeoutSecs?: number
    /** Delay between retries in milliseconds. Default: 1500. */
    retryDelayMs?: number
    /**
     * Hard cap in seconds for the entire story across all attempts. The
     * Copilot process is aborted unconditionally when this fires. <= 0
     * disables the absolute kill timer. Default: 0 (matches StoryAgent).
     */
    hardTimeoutSecs?: number
}

export interface CopilotStoryOutcome {
    storyId: string
    success: boolean
    attempts: number
    durationSecs: number
    finalSummary: CopilotRunSummary | null
    error: string | null
}

export class CopilotStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            CopilotStorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "hardTimeoutSecs"
        >
    > &
        CopilotStorySpec

    private envRef: AgenticEnvironment | null = null
    private currentCopilot: CopilotCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: CopilotStoryOutcome) => void
    public readonly done: Promise<CopilotStoryOutcome>

    constructor(spec: CopilotStorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            ...spec,
        }
        this.done = new Promise<CopilotStoryOutcome>((res) => {
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

    getCurrentCopilot(): CopilotCliParticipant | null {
        return this.currentCopilot
    }

    /**
     * Begin executing the story. Idempotent. Returns the `done` promise
     * for the caller's convenience.
     */
    run(environment: AgenticEnvironment): Promise<CopilotStoryOutcome> {
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
     * No-op: Copilot `-p` is one-shot, there's no stdin channel to forward
     * mid-flight messages to. Logged at the participant level if we ever
     * see an AgentTargetedMessage addressed here.
     */
    override async onExternalEvent(
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Intentionally empty — Copilot -p doesn't have the multi-turn
        // stdin lifecycle that StoryAgent uses for Claude.
    }

    /** Abort the story, killing the running Copilot (if any). */
    abort(): void {
        this.currentCopilot?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: CopilotRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.currentCopilot?.abort()
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
        summary: CopilotRunSummary | null
        error: string | null
    }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.transition("running", `attempt ${attempt}`)

        const copilot = new CopilotCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            model: this.spec.model,
            effort: this.spec.effort,
            copilotBin: this.spec.copilotBin,
        })
        this.currentCopilot = copilot
        copilot.join(this.envRef)
        copilot.start(this.envRef)

        let summary: CopilotRunSummary
        try {
            summary = await raceWithTimeout(
                copilot.done,
                this.spec.timeoutSecs * 1000,
                `attempt ${attempt} timeout after ${this.spec.timeoutSecs}s`,
            )
        } catch (e) {
            copilot.abort()
            const error = e instanceof Error ? e.message : String(e)
            try {
                await copilot.done
            } catch {
                // ignore
            }
            copilot.leave(this.envRef)
            this.currentCopilot = null
            return { success: false, summary: null, error }
        }

        copilot.leave(this.envRef)
        this.currentCopilot = null

        const success =
            summary.exitCode === 0 && summary.error == null

        if (!success) {
            const reason = summary.error
                ? summary.error.message
                : `non-zero exit ${summary.exitCode}`
            return { success: false, summary, error: reason }
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
