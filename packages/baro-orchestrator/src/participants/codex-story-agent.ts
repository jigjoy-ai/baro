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
    StoryResult,
    type AgentPhase,
} from "../semantic-events.js"
import {
    CodexCliParticipant,
    CodexRunSummary,
} from "./codex-cli-participant.js"
import { correlationOf } from "./story-agent.js"

export interface CodexStorySpec {
    /** Story ID, used as agentId for observer attribution. */
    id: string
    prompt: string
    /** Must be a git repo (Codex enforces). */
    cwd: string
    runId?: string
    leaseId?: string
    generation?: number
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
        _source: Participant,
        _event: SemanticEvent<unknown>,
    ): Promise<void> {
    }

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
            codexBin: this.spec.codexBin,
            bypassSandbox: this.spec.bypassSandbox,
            skipGitRepoCheck: this.spec.skipGitRepoCheck,
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
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
    ])
}
