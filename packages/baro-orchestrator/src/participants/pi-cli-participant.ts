/**
 * PiCliParticipant — wraps a Pi CLI process as a first-class Mozaik
 * Participant. Sibling of `OpenCodeCliParticipant` and `CodexCliParticipant`.
 *
 * Spawned with `pi --mode json -p --no-session "PROMPT"`.
 * Pi in `-p` mode is one-shot non-interactive: takes a single prompt as
 * argv, streams JSONL events to stdout, exits when the agent finishes.
 * There is no stdin event loop and no permissions prompt — Pi runs tools
 * autonomously when invoked with `-p`. That makes this participant
 * structurally identical to OpenCodeCliParticipant; the key differences
 * are CLI flags, event shapes, and the completion evidence tokens
 * (`agent_end` / `tool_execution_start` instead of `step_finish` /
 * `tool_use`).
 *
 * Library-grade: knows nothing about baro, PRD, or stories. Only knows
 * about agent IDs, working directories, and Pi.
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
    PiSystem,
    type AgentPhase,
} from "../semantic-events.js"
import { mapPiEvent } from "../pi-stream-mapper.js"

/** Options for constructing a PiCliParticipant. */
export interface PiCliParticipantOptions {
    /** Working directory for the Pi process. Required. */
    cwd: string
    /** Initial prompt — passed as the final argv to `pi`. */
    prompt: string
    /**
     * Provider override (e.g. "google", "anthropic"). Pi's default is
     * "google". Omit to use Pi's configured default.
     */
    provider?: string
    /**
     * Model identifier. Treated as an opaque string and forwarded via
     * `--model`. Omit to use Pi's configured default.
     */
    model?: string
    /** Path to the `pi` binary. Default: "pi" (resolved via PATH). */
    piBin?: string
}

/** Summary emitted when the Pi process exits. */
export interface PiRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    /**
     * True once at least one `agent_end` event was observed — i.e. the
     * agent loop actually completed rather than the process simply exiting.
     * Pi exits 0 even when the model produces no work, so exit code alone
     * is NOT proof of task success. Callers should require this before
     * treating exitCode 0 as a real completion.
     */
    sawAgentEnd: boolean
    /**
     * Number of `tool_execution_start` events observed. A code-writing
     * story that claims success having invoked zero tools is suspect — the
     * agent likely answered in prose instead of editing the worktree.
     */
    toolCallCount: number
    /**
     * Number of `tool_execution_end` events whose `isError` was NOT true —
     * i.e. tools that actually succeeded. A story whose every tool call
     * failed (all writes 500'd, etc.) still emits agent_end with
     * toolCallCount > 0, so gating success on attempts alone marks a
     * do-nothing run as passed. Callers should require at least one
     * SUCCESSFUL tool, not merely one attempted.
     */
    toolSuccessCount: number
}

/**
 * Mozaik participant that wraps a single `pi -p` CLI subprocess.
 * Streams JSONL events to the bus and manages lifecycle transitions.
 */
export class PiCliParticipant extends BaseObserver {
    /**
     * Process-wide registry of every Pi child currently running.
     * Used by the orchestrator's SIGINT/SIGTERM handlers to nuke orphans
     * so a killed baro doesn't leave background agents burning quota.
     */
    private static readonly active = new Set<PiCliParticipant>()

    /**
     * Send a signal to every active Pi child, then escalate to SIGKILL
     * after a grace period for any child that ignored the soft signal.
     * Idempotent. A Pi child that ignores SIGTERM (e.g. blocked in a
     * syscall or holding its own child group) would otherwise outlive a
     * killed baro and keep burning quota.
     */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of PiCliParticipant.active) {
            p.abort(signal)
        }
    }

    private readonly options: Required<
        Pick<PiCliParticipantOptions, "piBin">
    > &
        PiCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private sawAgentEnd = false
    private toolCallCount = 0
    private toolSuccessCount = 0
    private doneSettled = false
    private readySettled = false
    private killTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: PiRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /**
     * Grace period (ms) between SIGTERM and the SIGKILL escalation in
     * {@link abort}. A Pi child wedged in a blocking syscall ignores
     * SIGTERM; without escalation `await done` would hang forever.
     */
    private static readonly KILL_GRACE_MS = 5_000

    /** Cap on the un-newlined stdout buffer (16 MiB). See handleStdout. */
    private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024

    /** Resolves once Pi emits its first `agent_start` or `session` event. */
    public readonly ready: Promise<void>
    /** Resolves once the Pi process exits (regardless of success). */
    public readonly done: Promise<PiRunSummary>

    constructor(
        public readonly agentId: string,
        opts: PiCliParticipantOptions,
    ) {
        super()
        this.options = {
            piBin: "pi",
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
        this.done = new Promise<PiRunSummary>((res) => {
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
    private settleDone(summary: PiRunSummary): void {
        if (this.doneSettled) return
        this.doneSettled = true
        // The process is gone (or never started); cancel any pending
        // SIGKILL escalation so it can't fire against a recycled pid and
        // so the timer doesn't keep the event loop alive.
        if (this.killTimer !== null) {
            clearTimeout(this.killTimer)
            this.killTimer = null
        }
        this.resolveDone(summary)
    }

    /**
     * Resolve `ready` exactly once (first `session`/`agent_start` seen).
     */
    private settleReady(): void {
        if (this.readySettled) return
        this.readySettled = true
        this.resolveReady()
    }

    /**
     * Reject `ready` exactly once. Used on spawn/async error AND on a clean
     * process exit that never produced a `session`/`agent_start` — without
     * this the public `ready` promise would stay pending forever for any
     * caller that awaits it (e.g. a wedged Pi that exits 0 with no events).
     */
    private failReady(e: Error): void {
        if (this.readySettled) return
        this.readySettled = true
        this.rejectReady(e)
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * Spawn the Pi process and start streaming its events into the
     * environment. Idempotent: subsequent calls are a no-op.
     */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.piBin, args, {
                cwd: this.options.cwd,
                // stdin: "ignore" — one-shot, no interactive input
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.failReady(this.spawnError)
            this.settleDone({
                sessionId: null,
                exitCode: null,
                error: this.spawnError,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
            return
        }

        this.proc = proc
        PiCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        proc.on("error", (err) => {
            // Async process error (e.g. EACCES/EPIPE surfaced after a
            // successful spawn). An 'exit' event may NOT follow, so settle
            // `done` here too — otherwise the story agent's `await pi.done`
            // recovery path hangs until its outer timeout, or forever where
            // there is none.
            PiCliParticipant.active.delete(this)
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: this.exitCode,
                error: err,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
        })
        proc.on("exit", (code) => {
            PiCliParticipant.active.delete(this)
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            // If Pi exited without ever emitting session/agent_start, `ready`
            // was never resolved. Settle it now so an awaiter can't hang:
            // reject, because the agent provably never reached "running".
            this.failReady(
                new Error(
                    `pi exited (code ${code}) before signalling ready`,
                ),
            )
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: code,
                error: this.spawnError,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
        })
    }

    /**
     * Kill the Pi process. `done` resolves once `exit`/`error` fires.
     * Sends the soft signal first, then escalates to SIGKILL after a
     * grace period if the child is still alive — otherwise a Pi process
     * that ignores SIGTERM would leave any `await done` hanging forever.
     */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        const proc = this.proc
        if (!proc) return
        try {
            proc.kill(signal)
        } catch {
            // best-effort
        }
        // SIGKILL is unconditional; if we're already escalating, don't
        // stack timers.
        if (signal === "SIGKILL" || this.killTimer !== null) return
        this.killTimer = setTimeout(() => {
            this.killTimer = null
            if (this.doneSettled) return
            try {
                proc.kill("SIGKILL")
            } catch {
                // best-effort
            }
        }, PiCliParticipant.KILL_GRACE_MS)
        // Don't let the escalation timer hold the process open if the
        // story already settled through another path.
        this.killTimer.unref?.()
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // No-op. Pi `-p` is one-shot: it doesn't have a stdin user-message
        // channel like Claude Code. AgentTargetedMessage delivery to a
        // running Pi would require a new invocation.
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.agentId
        ) {
            process.stderr.write(
                `[pi:${this.agentId}] received AgentTargetedMessage but Pi run is one-shot — dropped\n`,
            )
        }
    }

    private buildArgs(): string[] {
        // `pi --mode json -p --no-session [--provider P] [--model M] PROMPT`
        const args = ["--mode", "json", "-p", "--no-session"]
        if (this.options.provider) args.push("--provider", this.options.provider)
        if (this.options.model) args.push("--model", this.options.model)
        // Prompt is the final positional. spawn() passes argv directly
        // so no shell quoting needed.
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
        // Guard against unbounded growth from a pathological newline-less
        // stream (a wedged Pi, or a single enormous tool-result line). A
        // bare JSONL event is never this large; drop the partial so memory
        // can't balloon while still parsing well-formed lines that follow.
        if (this.buffer.length > PiCliParticipant.MAX_BUFFER_BYTES) {
            process.stderr.write(
                `[pi:${this.agentId}] stdout buffer exceeded ${PiCliParticipant.MAX_BUFFER_BYTES} bytes without a newline — discarding partial line\n`,
            )
            this.buffer = ""
        }
    }

    private handleStderr(chunk: string): void {
        const trimmed = chunk.trimEnd()
        if (!trimmed) return
        process.stderr.write(`[pi:${this.agentId}/stderr] ${trimmed}\n`)
    }

    private processLine(line: string): void {
        let parsed: Record<string, unknown>
        try {
            parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
            process.stderr.write(
                `[pi:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }

        const { items, sessionId } = mapPiEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }

        // Track completion evidence for the success predicate. exitCode 0
        // is necessary but not sufficient — Pi exits 0 even on a refused
        // or no-op turn — so the story agent additionally requires an
        // agent_end (the agent loop actually completed) and at least one
        // tool_execution_start (it did work rather than answering in prose).
        if (parsed.type === "agent_end") this.sawAgentEnd = true
        if (parsed.type === "tool_execution_start") this.toolCallCount += 1
        // Count tools that actually succeeded (isError !== true) separately
        // from attempts — the story success predicate gates on successes so a
        // run where every tool failed is not reported as done.
        if (parsed.type === "tool_execution_end" && parsed.isError !== true) {
            this.toolSuccessCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                // Lifecycle signals: agent_start / session → ready + running.
                if (
                    PiSystem.is(item) &&
                    (item.data.subtype === "session" ||
                        item.data.subtype === "agent_start")
                ) {
                    this.transition("running", "pi agent started")
                    this.settleReady()
                }
                // Don't transition to "done" on agent_end — the
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
