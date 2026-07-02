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
    StoryResult,
    type AgentPhase,
} from "../semantic-events.js"
import {
    OpenCodeCliParticipant,
    type OpenCodeRunSummary,
} from "./opencode-cli-participant.js"

export interface OpenCodeStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    cwd: string
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
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
    }

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
            opencodeBin: this.spec.opencodeBin,
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

        // `opencode run` exits 0 even on a refusal or no-op (verified
        // empirically), so success needs positive evidence: the agent loop
        // finished (`sawStepFinish`) and at least one tool was invoked —
        // no tools ⇒ it answered in prose, not edits.
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

function raceWithTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<T>(
        (_, rej) => { timer = setTimeout(() => rej(new Error(label)), ms) },
    )
    return Promise.race([
        p.then((v) => { clearTimeout(timer); return v }),
        timeout,
    ])
}
