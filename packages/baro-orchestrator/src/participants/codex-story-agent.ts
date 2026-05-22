/**
 * CodexStoryAgent — story-level wrapper that drives a
 * CodexCliParticipant through a single piece of work, with retries
 * and per-attempt timeout. Sibling of `story-agent.ts` (Claude) and
 * `openai-story-agent.ts` (OpenAI API).
 *
 * Lifecycle is simpler than the Claude variant because Codex exec is
 * one-shot: each attempt spawns a fresh `codex exec --json` process,
 * which streams events and exits when the agent finishes. There is no
 * multi-turn quiet-timer / stdin-injection dance.
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
    CodexCliParticipant,
    CodexRunSummary,
} from "./codex-cli-participant.js"

export interface CodexStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    /** The prompt sent to Codex as the initial user message. */
    prompt: string
    /** Working directory for Codex. Must be a git repo (Codex enforces). */
    cwd: string
    /** Optional model override (e.g. "gpt-5.5"). */
    model?: string
    /** Retry budget (number of *additional* attempts after the first). */
    retries?: number
    /** Per-attempt timeout in seconds. Default: 600. */
    timeoutSecs?: number
    /** Delay between retries in milliseconds. Default: 1500. */
    retryDelayMs?: number
    /**
     * Hard cap in seconds for the entire story across all attempts. The
     * Codex process is aborted unconditionally when this fires. <= 0
     * disables the absolute kill timer. Default: 0 (matches StoryAgent).
     */
    hardTimeoutSecs?: number
    /**
     * Pass `--full-auto` to Codex so it does not prompt for permission
     * on every shell command / edit. Required for autonomous baro runs.
     * Default: true.
     */
    fullAuto?: boolean
    /**
     * Pass `--skip-git-repo-check`. baro story workers always run inside
     * per-story git worktrees, so the default is false; set this only
     * when wiring up tests or one-off runs.
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
}

export class CodexStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            CodexStorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "hardTimeoutSecs"
            | "fullAuto"
            | "skipGitRepoCheck"
        >
    > &
        CodexStorySpec

    private envRef: AgenticEnvironment | null = null
    private currentCodex: CodexCliParticipant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: CodexStoryOutcome) => void
    public readonly done: Promise<CodexStoryOutcome>

    constructor(spec: CodexStorySpec) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            hardTimeoutSecs: 0,
            fullAuto: true,
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

    /**
     * Begin executing the story. Idempotent. Returns the `done` promise
     * for the caller's convenience.
     */
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

    /**
     * No-op: Codex exec is one-shot, there's no stdin channel to forward
     * mid-flight messages to. Logged at the participant level if we ever
     * see an AgentTargetedMessage addressed here.
     */
    override async onExternalEvent(
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Intentionally empty — Codex exec doesn't have the multi-turn
        // stdin lifecycle that StoryAgent uses for Claude.
    }

    /** Abort the story, killing the running Codex (if any). */
    abort(): void {
        this.currentCodex?.abort()
        this.transition("aborted", "external abort")
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastSummary: CodexRunSummary | null = null
        let lastError: string | null = null
        let hardTimedOut = false

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      hardTimedOut = true
                      this.currentCodex?.abort()
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
        summary: CodexRunSummary | null
        error: string | null
    }> {
        if (!this.envRef) {
            return { success: false, summary: null, error: "no environment" }
        }

        this.transition("running", `attempt ${attempt}`)

        const codex = new CodexCliParticipant(this.spec.id, {
            cwd: this.spec.cwd,
            prompt: this.spec.prompt,
            model: this.spec.model,
            fullAuto: this.spec.fullAuto,
            skipGitRepoCheck: this.spec.skipGitRepoCheck,
        })
        this.currentCodex = codex
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
            codex.abort()
            const error = e instanceof Error ? e.message : String(e)
            try {
                await codex.done
            } catch {
                // ignore
            }
            codex.leave(this.envRef)
            this.currentCodex = null
            return { success: false, summary: null, error }
        }

        codex.leave(this.envRef)
        this.currentCodex = null

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
