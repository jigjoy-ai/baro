/**
 * OpenCodeCliParticipant — wraps an OpenCode CLI process as a
 * first-class Mozaik Participant. Sibling of `CodexCliParticipant`
 * and `ClaudeCliParticipant`.
 *
 * Spawned with `opencode run --format json --dangerously-skip-permissions "PROMPT"`.
 * OpenCode `run` is one-shot non-interactive: takes a single prompt as
 * argv, streams JSONL events to stdout, exits when the agent finishes.
 * There is no stdin event loop (unlike Claude Code's stream-json input).
 * That makes this participant simpler than ClaudeCliParticipant in one
 * respect — `onExternalEvent` doesn't forward AgentTargetedMessage to a
 * running process; new prompts mean a new OpenCode invocation.
 *
 * Library-grade: knows nothing about baro, PRD, or stories. Only knows
 * about agent IDs, working directories, and OpenCode.
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
    OpenCodeSystem,
    type AgentPhase,
} from "../semantic-events.js"
import { mapOpenCodeEvent } from "../opencode-stream-mapper.js"

/** Options for constructing an OpenCodeCliParticipant. */
export interface OpenCodeCliParticipantOptions {
    /** Working directory for the OpenCode process. Required. */
    cwd: string
    /** Initial prompt — passed as the final argv to `opencode run`. */
    prompt: string
    /**
     * Model identifier in `provider/model` format (e.g.
     * "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o").
     * Passed via `-m`. Omit to let OpenCode use its configured default.
     */
    model?: string
    /** Path to the `opencode` binary. Default: "opencode" (resolved via PATH). */
    opencodeBin?: string
    /**
     * Whether to pass `--dangerously-skip-permissions`. Required for
     * autonomous baro runs because OpenCode's default mode prompts for
     * tool approvals. Default: true.
     */
    skipPermissions?: boolean
}

/** Summary emitted when the OpenCode process exits. */
export interface OpenCodeRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    /**
     * True once at least one `step_finish` event was observed — i.e. the
     * agent loop actually completed a step rather than the process simply
     * exiting. `opencode run` exits 0 even when the model refuses or
     * produces no work, so exit code alone is NOT proof of task success
     * (verified empirically). Callers should require this before treating
     * exitCode 0 as a real completion.
     */
    sawStepFinish: boolean
    /**
     * Number of `tool_call` events observed. A code-writing story that
     * claims success having invoked zero tools is suspect — the agent
     * likely answered in prose instead of editing the worktree.
     */
    toolCallCount: number
}

/**
 * Mozaik participant that wraps a single `opencode run` CLI subprocess.
 * Streams JSONL events to the bus and manages lifecycle transitions.
 */
export class OpenCodeCliParticipant extends BaseObserver {
    /**
     * Process-wide registry of every OpenCode child currently running.
     * Used by the orchestrator's SIGINT/SIGTERM handlers to nuke orphans
     * so a killed baro doesn't leave background agents burning quota.
     */
    private static readonly active = new Set<OpenCodeCliParticipant>()

    /** Send a signal to every active OpenCode child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of OpenCodeCliParticipant.active) {
            try {
                p.proc?.kill(signal)
            } catch {
                // best-effort
            }
        }
    }

    private readonly options: Required<
        Pick<OpenCodeCliParticipantOptions, "opencodeBin" | "skipPermissions">
    > &
        OpenCodeCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private sawStepFinish = false
    private toolCallCount = 0
    private doneSettled = false
    private resolveDone!: (summary: OpenCodeRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once OpenCode emits its first `step_start` event. */
    public readonly ready: Promise<void>
    /** Resolves once the OpenCode process exits (regardless of success). */
    public readonly done: Promise<OpenCodeRunSummary>

    constructor(
        public readonly agentId: string,
        opts: OpenCodeCliParticipantOptions,
    ) {
        super()
        this.options = {
            opencodeBin: "opencode",
            skipPermissions: true,
            ...opts,
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        // Suppress UnhandledPromiseRejection when callers only await
        // `done` and never attach a rejection handler to `ready`. The
        // rejection is still observable by callers who do await `ready`;
        // the no-op catch here only prevents the Node.js warning when no
        // one is listening.
        this.ready.catch(() => { /* suppressed — callers use `done` */ })
        this.done = new Promise<OpenCodeRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    /**
     * Settle the `done` promise exactly once. Both the `exit` and
     * `error` process listeners can fire (in either order, or one
     * without the other), so every resolution path goes through here to
     * avoid a double-resolve and, more importantly, to guarantee `done`
     * always settles — the previous `error` handler rejected `ready` but
     * never resolved `done`, so an async spawn error with no following
     * `exit` left `done` pending forever and any awaiter hung.
     */
    private settleDone(summary: OpenCodeRunSummary): void {
        if (this.doneSettled) return
        this.doneSettled = true
        this.resolveDone(summary)
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * Spawn the OpenCode process and start streaming its events into the
     * environment. Idempotent: subsequent calls are a no-op.
     */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.opencodeBin, args, {
                cwd: this.options.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.rejectReady(this.spawnError)
            this.settleDone({
                sessionId: null,
                exitCode: null,
                error: this.spawnError,
                sawStepFinish: this.sawStepFinish,
                toolCallCount: this.toolCallCount,
            })
            return
        }

        this.proc = proc
        OpenCodeCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        proc.on("error", (err) => {
            // Async process error (e.g. EACCES/EPIPE surfaced after a
            // successful spawn). An 'exit' event may NOT follow, so settle
            // `done` here too — otherwise the story agent's `await
            // opencode.done` recovery path (and the one-shot caller) hang
            // until their outer timeout, or forever where there is none.
            OpenCodeCliParticipant.active.delete(this)
            this.spawnError = err
            this.transition("failed", err.message)
            this.rejectReady(err)
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: this.exitCode,
                error: err,
                sawStepFinish: this.sawStepFinish,
                toolCallCount: this.toolCallCount,
            })
        })
        proc.on("exit", (code) => {
            OpenCodeCliParticipant.active.delete(this)
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: code,
                error: this.spawnError,
                sawStepFinish: this.sawStepFinish,
                toolCallCount: this.toolCallCount,
            })
        })
    }

    /** Kill the OpenCode process. Resolves once exit fires. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        this.proc?.kill(signal)
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // No-op for now. OpenCode run is one-shot: it doesn't have a
        // stdin user-message channel like Claude Code. AgentTargetedMessage
        // delivery to a running OpenCode would require a new invocation.
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.agentId
        ) {
            process.stderr.write(
                `[opencode:${this.agentId}] received AgentTargetedMessage but OpenCode run is one-shot — dropped\n`,
            )
        }
    }

    private buildArgs(): string[] {
        // `opencode run --format json --dangerously-skip-permissions`
        const args = ["run", "--format", "json"]
        if (this.options.skipPermissions) {
            args.push("--dangerously-skip-permissions")
        }
        if (this.options.model) args.push("-m", this.options.model)
        if (this.options.cwd) args.push("--dir", this.options.cwd)
        // Prompt is the final positional. spawn() passes argv directly
        // so no quoting needed.
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
        process.stderr.write(`[opencode:${this.agentId}/stderr] ${trimmed}\n`)
    }

    private processLine(line: string): void {
        let parsed: Record<string, any>
        try {
            parsed = JSON.parse(line)
        } catch {
            process.stderr.write(
                `[opencode:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }

        const { items, sessionId } = mapOpenCodeEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }
        // Track completion evidence for the success predicate. exitCode 0
        // is necessary but not sufficient — `opencode run` exits 0 on a
        // refused/no-op turn — so the story agent additionally requires a
        // step_finish (the agent loop actually completed) and at least one
        // tool_call (it did work rather than answering in prose).
        if (parsed.type === "step_finish") this.sawStepFinish = true
        // Real opencode emits `tool_use`; `tool_call` is the legacy
        // fallback shape. Count either as evidence the agent did work.
        if (parsed.type === "tool_use" || parsed.type === "tool_call") {
            this.toolCallCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                // Lifecycle signals: step_start → ready + running.
                if (
                    OpenCodeSystem.is(item) &&
                    item.data.subtype === "step_start"
                ) {
                    this.transition("running", "opencode step started")
                    this.resolveReady()
                }
                // Don't transition to "done" on step_finish — the
                // process-exit listener owns that, so we observe the real
                // exit code before locking in the AgentPhase.
            }
            this.dispatch(item)
        }
    }

    /**
     * Route a mapped event to the right Mozaik delivery channel.
     * Assistant-side LLM items use Mozaik's typed channels; everything
     * else goes through deliverSemanticEvent.
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
