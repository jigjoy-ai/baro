/**
 * ClaudeCliParticipant — wraps a long-lived Claude Code CLI process as a
 * first-class Mozaik Participant.
 *
 * Spawned with `--print --input-format stream-json --output-format
 * stream-json --verbose`. Each line in is a JSON event Claude consumes,
 * each line out is a JSON event Claude emits. We map outbound events
 * through the stream-json mapper into typed Mozaik ContextItems and
 * deliver them to the environment.
 *
 * Library-grade: knows nothing about baro, PRD, or stories. Only knows
 * about agent IDs, working directories, and Claude.
 */

import { ChildProcess, spawn } from "child_process"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../bus.js"
import { mapClaudeEvent } from "../stream-json-mapper.js"
import {
    AgentPhase,
    AgentStateItem,
    AgentTargetedMessageItem,
    AgentResultItem,
    ClaudeSystemItem,
} from "../types.js"

export interface ClaudeCliParticipantOptions {
    /** Working directory for the Claude process. Required. */
    cwd: string
    /** Model to use (e.g. "sonnet", "opus", "haiku"). Optional. */
    model?: string
    /**
     * If true, pass `--include-partial-messages` so Claude emits
     * `stream_event` chunks for each token delta. Adds ~80% bus volume.
     * Default: false.
     */
    includePartialMessages?: boolean
    /**
     * If true, pass `--replay-user-messages` so Claude echoes received
     * stdin user events back as `user` events on stdout. Useful for
     * confirming bus → Claude routing. Default: true.
     */
    replayUserMessages?: boolean
    /**
     * Permission mode passed to Claude. Default: "bypassPermissions".
     * Production multi-agent runs may want stricter modes.
     */
    permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan"
    /** Extra CLI arguments appended after the standard set. */
    extraArgs?: string[]
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
    /**
     * If provided, pass `--resume <sessionId>` so Claude continues an
     * existing session instead of starting fresh. Required for
     * multi-turn agents that survive across multiple infer() calls.
     */
    resumeSessionId?: string
}

export interface ClaudeRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    lastResult: AgentResultItem | null
}

export class ClaudeCliParticipant extends BaroParticipant {
    /**
     * Process-wide registry of every Claude child currently running.
     * Used by the orchestrator's SIGINT/SIGTERM handlers to nuke
     * orphaned Claude processes so a killed baro doesn't leave a swarm
     * of background agents burning quota.
     */
    private static readonly active = new Set<ClaudeCliParticipant>()

    /** Send a signal to every active Claude child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of ClaudeCliParticipant.active) {
            try {
                p.proc?.kill(signal)
            } catch {
                // best-effort
            }
        }
    }

    private readonly options: Required<
        Pick<
            ClaudeCliParticipantOptions,
            "includePartialMessages" | "replayUserMessages" | "permissionMode" | "claudeBin"
        >
    > &
        ClaudeCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: BaroEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private lastResult: AgentResultItem | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private resolveDone!: (summary: ClaudeRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once Claude emits its first `system:init` event. */
    public readonly ready: Promise<void>
    /** Resolves once the Claude process exits (regardless of success). */
    public readonly done: Promise<ClaudeRunSummary>

    constructor(
        public readonly agentId: string,
        opts: ClaudeCliParticipantOptions,
    ) {
        super()
        this.options = {
            includePartialMessages: false,
            replayUserMessages: true,
            permissionMode: "bypassPermissions",
            claudeBin: "claude",
            ...opts,
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        this.done = new Promise<ClaudeRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * Spawn the Claude process and start streaming its events into the
     * environment. Idempotent: subsequent calls are a no-op.
     */
    start(environment: BaroEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.claudeBin, args, {
                cwd: this.options.cwd,
                stdio: ["pipe", "pipe", "pipe"],
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.rejectReady(this.spawnError)
            this.resolveDone({
                sessionId: null,
                exitCode: null,
                error: this.spawnError,
                lastResult: null,
            })
            return
        }

        this.proc = proc
        ClaudeCliParticipant.active.add(this)
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
            ClaudeCliParticipant.active.delete(this)
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(finalPhase, code != null ? `exit code ${code}` : "no exit code")
            this.resolveDone({
                sessionId: this.sessionId,
                exitCode: code,
                error: this.spawnError,
                lastResult: this.lastResult,
            })
        })
    }

    /**
     * Send a user message into the Claude process. Used by both bus
     * routing (via onContextItem) and direct callers (the orchestrator
     * may want to inject the initial prompt directly to avoid a circular
     * AgentTargetedMessageItem dance).
     */
    sendUserMessage(text: string): void {
        if (!this.proc?.stdin) {
            throw new Error(`[${this.agentId}] proc not started`)
        }
        const event = {
            type: "user",
            message: { role: "user", content: text },
        }
        this.proc.stdin.write(JSON.stringify(event) + "\n")
    }

    /** Close stdin so Claude knows no more input is coming. */
    closeStdin(): void {
        this.proc?.stdin?.end()
    }

    /** Kill the Claude process. Resolves once exit fires. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        this.proc?.kill(signal)
    }

    override async onExternalBusEvent(_source: Participant, event: BusEvent): Promise<void> {
        // ClaudeCliParticipant owns bus → stdin forwarding for messages
        // addressed to its agentId. StoryAgent (when present) observes
        // these events for lifecycle/timing purposes only — it does NOT
        // also write to stdin, to avoid double-delivery.
        if (
            event instanceof AgentTargetedMessageItem &&
            event.recipientId === this.agentId
        ) {
            if (!this.proc?.stdin) return
            this.sendUserMessage(event.text)
        }
    }

    private buildArgs(): string[] {
        const args = [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            this.options.permissionMode,
        ]
        if (this.options.includePartialMessages) {
            args.push("--include-partial-messages")
        }
        if (this.options.replayUserMessages) {
            args.push("--replay-user-messages")
        }
        if (this.options.model) {
            args.push("--model", this.options.model)
        }
        if (this.options.resumeSessionId) {
            args.push("--resume", this.options.resumeSessionId)
        }
        if (this.options.extraArgs && this.options.extraArgs.length > 0) {
            args.push(...this.options.extraArgs)
        }
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
        // Stderr is informational only; surface via state detail rather
        // than as an error so observers can decide what to do with it.
        process.stderr.write(`[claude:${this.agentId}/stderr] ${trimmed}\n`)
    }

    private processLine(line: string): void {
        let parsed: Record<string, any>
        try {
            parsed = JSON.parse(line)
        } catch {
            process.stderr.write(
                `[claude:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }

        const { items, sessionId } = mapClaudeEvent(this.agentId, parsed)
        if (sessionId && !this.sessionId) {
            this.sessionId = sessionId
        }

        for (const item of items) {
            if (item instanceof ClaudeSystemItem && item.subtype === "init") {
                this.transition("running", "claude init received")
                this.resolveReady()
            }
            if (item instanceof AgentResultItem) {
                this.lastResult = item
                this.transition(item.isError ? "failed" : "done", `result:${item.subtype}`)
            }
            this.dispatch(item)
        }
    }

    /**
     * Route a mapped stream-json item to the right Mozaik 3.9 delivery
     * channel. Assistant-side LLM items get their dedicated typed
     * channels so future Mozaik-native participants can listen
     * idiomatically; everything else (user-side messages, system frames,
     * result frames, custom Claude wrappers) rides our `BusEvent` bus.
     */
    private dispatch(item: ModelMessageItem | FunctionCallItem | FunctionCallOutputItem | BusEvent): void {
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
        this.envRef.deliverBusEvent(this, item)
    }

    private transition(next: AgentPhase, detail?: string): void {
        if (next === this.currentPhase) return
        this.currentPhase = next
        this.envRef?.deliverBusEvent(
            this,
            new AgentStateItem(this.agentId, next, detail),
        )
    }
}
