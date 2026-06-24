/**
 * CodexCliParticipant — wraps an OpenAI Codex CLI process as a
 * first-class Mozaik Participant. Sibling of `ClaudeCliParticipant`.
 *
 * Spawned with `codex exec --json <prompt>`. Codex exec is one-shot
 * non-interactive: takes a single prompt as argv, streams JSONL events
 * to stdout, exits when the agent finishes. There is no stdin event
 * loop (unlike Claude Code's stream-json input). That makes this
 * participant simpler than ClaudeCliParticipant in one respect —
 * `onExternalEvent` doesn't forward AgentTargetedMessage to a running
 * process; new prompts mean a new Codex invocation.
 *
 * Library-grade: knows nothing about baro, PRD, or stories. Only knows
 * about agent IDs, working directories, and Codex.
 */

import { ChildProcess, spawn } from "child_process"

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    AgentState,
    AgentTargetedMessage,
    CodexSystem,
    CodexTurnEvent,
    type AgentPhase,
} from "../semantic-events.js"
import { mapCodexEvent } from "../codex-stream-mapper.js"

export interface CodexCliParticipantOptions {
    /** Working directory for the Codex process. Required. */
    cwd: string
    /** Initial prompt — passed as the final argv to `codex exec`. */
    prompt: string
    /**
     * Model identifier. Codex defaults to gpt-5.5 on accounts that have
     * Plus+ access; on Free it routes to whatever Codex Mini variant the
     * promo is currently exposing. Pass undefined to let Codex pick.
     */
    model?: string
    /**
     * Bypass Codex's sandbox AND approval prompts. Equivalent to
     * `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`)
     * on the CLI. Replaces the deprecated `--full-auto` flag —
     * which was just sandbox=workspace-write + no-approvals, but
     * workspace-write blocks writes to `.git/` so the agent can't
     * commit. Baro story workers run in a per-story git worktree
     * (WorktreeManager, #50) — an isolated tree merged back only on
     * success — so the "danger" is bounded; the agent NEEDS .git/
     * writes to land commits and let Finalizer push.
     *
     * Default: false. Callers that don't need autonomous .git
     * writes (e.g. read-only probes) should leave it off.
     */
    bypassSandbox?: boolean
    /**
     * If true, pass `--skip-git-repo-check`. Required when the cwd is
     * not a git repo (Codex refuses to run otherwise). baro's story
     * workers run inside a per-story git worktree (a valid git repo), so
     * the default is false — set this only when wiring up tests or
     * one-off runs from /tmp.
     */
    skipGitRepoCheck?: boolean
    /** Extra CLI arguments appended after the standard set. */
    extraArgs?: string[]
    /** Path to the `codex` binary. Default: "codex" (resolved via PATH). */
    codexBin?: string
}

export interface CodexRunSummary {
    threadId: string | null
    exitCode: number | null
    error: Error | null
}

export class CodexCliParticipant extends BaseObserver {
    /**
     * Process-wide registry of every Codex child currently running. Used
     * by the orchestrator's SIGINT/SIGTERM handlers to nuke orphans so a
     * killed baro doesn't leave a swarm of background agents burning
     * quota.
     */
    private static readonly active = new Set<CodexCliParticipant>()

    /** Send a signal to every active Codex child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of CodexCliParticipant.active) {
            try {
                p.proc?.kill(signal)
            } catch {
                // best-effort
            }
        }
    }

    private readonly options: Required<
        Pick<
            CodexCliParticipantOptions,
            "codexBin" | "bypassSandbox" | "skipGitRepoCheck"
        >
    > &
        CodexCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private threadId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private resolveDone!: (summary: CodexRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once Codex emits its first `thread.started` event. */
    public readonly ready: Promise<void>
    /** Resolves once the Codex process exits (regardless of success). */
    public readonly done: Promise<CodexRunSummary>

    constructor(
        public readonly agentId: string,
        opts: CodexCliParticipantOptions,
    ) {
        super()
        this.options = {
            codexBin: "codex",
            bypassSandbox: false,
            skipGitRepoCheck: false,
            ...opts,
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        this.done = new Promise<CodexRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    getThreadId(): string | null {
        return this.threadId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * Spawn the Codex process and start streaming its events into the
     * environment. Idempotent: subsequent calls are a no-op.
     */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.codexBin, args, {
                cwd: this.options.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.rejectReady(this.spawnError)
            this.resolveDone({
                threadId: null,
                exitCode: null,
                error: this.spawnError,
            })
            return
        }

        this.proc = proc
        CodexCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        proc.on("error", (err) => {
            this.spawnError = err
            this.rejectReady(err)
        })
        proc.on("exit", (code) => {
            CodexCliParticipant.active.delete(this)
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            this.resolveDone({
                threadId: this.threadId,
                exitCode: code,
                error: this.spawnError,
            })
        })
    }

    /** Kill the Codex process. Resolves once exit fires. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        this.proc?.kill(signal)
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // No-op for now. Codex exec is one-shot: it doesn't have a stdin
        // user-message channel like Claude Code. AgentTargetedMessage
        // delivery to a running Codex would require either a new
        // invocation or future Codex SDK support for session resumption.
        // Surface this as a noisy warning during M3/M4 so we catch any
        // assumption from the orchestrator that messages route the way
        // they do for Claude.
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.agentId
        ) {
            process.stderr.write(
                `[codex:${this.agentId}] received AgentTargetedMessage but Codex exec is one-shot — dropped\n`,
            )
        }
    }

    private buildArgs(): string[] {
        // `codex exec --json` — non-interactive JSONL stream.
        const args = ["exec", "--json"]
        if (this.options.skipGitRepoCheck) args.push("--skip-git-repo-check")
        if (this.options.bypassSandbox) {
            // `--dangerously-bypass-approvals-and-sandbox` is the
            // modern replacement for the deprecated `--full-auto`.
            // workspace-write isn't enough — `.git/` is read-only
            // even in workspace-write mode (per openai/codex#15505).
            // baro stories need `.git/` writes to commit, so we go
            // full bypass and rely on the per-story worktree (#50) for
            // isolation.
            args.push("--dangerously-bypass-approvals-and-sandbox")
        }
        if (this.options.model) args.push("--model", this.options.model)
        if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)
        // Prompt is the final positional. Codex expects it as a single
        // shell arg; spawn() passes argv directly so no quoting needed.
        args.push(this.options.prompt)
        return args
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk
        let nl: number
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim()
            this.buffer = this.buffer.slice(nl + 1)
            if (!line) continue
            this.processLine(line)
        }
    }

    private handleStderr(chunk: string): void {
        const trimmed = chunk.trimEnd()
        if (!trimmed) return
        process.stderr.write(`[codex:${this.agentId}/stderr] ${trimmed}\n`)
    }

    private processLine(line: string): void {
        let parsed: Record<string, any>
        try {
            parsed = JSON.parse(line)
        } catch {
            process.stderr.write(
                `[codex:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }

        const { items, threadId } = mapCodexEvent(this.agentId, parsed)
        if (threadId && !this.threadId) {
            this.threadId = threadId
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                // Lifecycle signals. Real Codex stream shape (observed
                // 2026-05-22, codex v0.133.0):
                //   thread.started   → ready
                //   turn.started     → no-op (we're already running)
                //   turn.completed   → success terminal for one-shot
                //                      exec (thread.completed is only
                //                      emitted on multi-turn sessions)
                //   turn.failed      → failure terminal
                //   thread.completed → process is shutting down cleanly
                if (
                    CodexSystem.is(item) &&
                    item.data.subtype === "thread.started"
                ) {
                    this.transition("running", "codex thread started")
                    this.resolveReady()
                }
                if (CodexTurnEvent.is(item)) {
                    const phase = item.data.phase
                    if (phase === "failed") {
                        this.transition("failed", "codex turn failed")
                    }
                }
                // Don't transition to "done" on thread.completed either —
                // the process-exit listener owns that, so we observe the
                // real exit code before locking in the AgentPhase.
            }
            this.dispatch(item)
        }
    }

    /**
     * Route a mapped event to the right Mozaik delivery channel.
     * Mirror of ClaudeCliParticipant.dispatch — assistant-side LLM items
     * use Mozaik's typed channels; everything else goes through
     * deliverSemanticEvent.
     */
    private dispatch(
        item:
            | ModelMessageItem
            | FunctionCallItem
            | FunctionCallOutputItem
            | SemanticEvent<unknown>,
    ): void {
        if (!this.envRef) return
        if (item instanceof ModelMessageItem) {
            this.envRef.deliverModelMessage(this, item)
            return
        }
        if (item instanceof FunctionCallItem) {
            this.envRef.deliverFunctionCall(this, item)
            return
        }
        if (item instanceof FunctionCallOutputItem) {
            this.envRef.deliverFunctionCallOutput(this, item)
            return
        }
        this.envRef.deliverSemanticEvent(this, item)
    }

    private transition(next: AgentPhase, detail?: string): void {
        if (next === this.currentPhase) return
        this.currentPhase = next
        this.envRef?.deliverSemanticEvent(
            this,
            AgentState.create({
                agentId: this.agentId,
                phase: next,
                detail,
            }),
        )
    }
}
