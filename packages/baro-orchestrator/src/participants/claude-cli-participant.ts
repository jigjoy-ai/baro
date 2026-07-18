/**
 * Wraps a long-lived Claude Code CLI process (stream-json in/out) as a
 * Mozaik Participant. Event shapes: docs/stream-protocols.md § Claude Code.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import { harnessChildEnvironment } from "../harness-environment.js"
import {
    ManagedProcessTree,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "../process-tree.js"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    ClaudeSystem,
    type AgentPhase,
    type AgentResultData,
} from "../semantic-events.js"
import { mapClaudeEvent } from "../stream-json-mapper.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"

export interface ClaudeCliParticipantOptions {
    cwd: string
    model?: string
    /**
     * Pass `--include-partial-messages` (a `stream_event` chunk per token
     * delta — adds ~80% bus volume). Default: false.
     */
    includePartialMessages?: boolean
    /**
     * Pass `--replay-user-messages` so Claude echoes stdin user events back
     * on stdout. Default: true.
     */
    replayUserMessages?: boolean
    permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan"
    extraArgs?: string[]
    claudeBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
    effort?: string
    /** `--resume <sessionId>` — needed by agents that span multiple infer() calls. */
    resumeSessionId?: string
    /** Compatibility targeted messages from this exact participant are
     * ignored because the owning StoryAgent consumes correlated Critique
     * events directly. */
    ignoredTargetedMessageAuthority?: Participant
    /** Exact Bridge and lease capability required in collective execution. */
    targetedMessageAuthority?: Participant
    targetedMessageCorrelation?: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>
    /** Reviewed workers consume Critique directly; ignore its correlated
     * targeted compatibility twin. */
    ignoreCorrelatedTerminalFeedback?: boolean
}

export interface ClaudeRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    /**
     * Last `result` event observed. Stored as the payload shape, not the
     * live SemanticEvent, so callers don't have to peel `.data`.
     */
    lastResult: AgentResultData | null
}

export class ClaudeCliParticipant extends BaseObserver {
    /**
     * Process-wide registry for the orchestrator's SIGINT/SIGTERM handlers,
     * so a killed baro doesn't leave orphaned agents burning quota.
     */
    private static readonly active = new Set<ClaudeCliParticipant>()

    /** Send a signal to every active Claude child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of ClaudeCliParticipant.active) {
            p.abort(signal)
        }
    }

    private readonly options: Required<
        Pick<
            ClaudeCliParticipantOptions,
            "includePartialMessages" | "replayUserMessages" | "permissionMode" | "claudeBin" | "closeDrainTimeoutMs"
        >
    > &
        ClaudeCliParticipantOptions

    private proc: ChildProcess | null = null
    private processTree: ManagedProcessTree | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private lastResult: AgentResultData | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private doneSettled = false
    private readySettled = false
    private closeDrainTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: ClaudeRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once Claude emits its first `system:init` event. */
    public readonly ready: Promise<void>
    /** Resolves after stream close, or a bounded post-root-exit drain failure. */
    public readonly done: Promise<ClaudeRunSummary>

    private static readonly CLOSE_DRAIN_TIMEOUT_MS = 7_500

    constructor(
        public readonly agentId: string,
        opts: ClaudeCliParticipantOptions,
    ) {
        super()
        // Nullish-coalesce so an explicit `undefined` from the caller can't
        // clobber a default (esp. claudeBin → spawn crash).
        this.options = {
            ...opts,
            includePartialMessages: opts.includePartialMessages ?? false,
            replayUserMessages: opts.replayUserMessages ?? true,
            permissionMode: opts.permissionMode ?? "bypassPermissions",
            claudeBin: opts.claudeBin ?? "claude",
            closeDrainTimeoutMs:
                opts.closeDrainTimeoutMs ??
                ClaudeCliParticipant.CLOSE_DRAIN_TIMEOUT_MS,
        }
        if (
            !Number.isFinite(this.options.closeDrainTimeoutMs) ||
            this.options.closeDrainTimeoutMs < 1
        ) {
            throw new RangeError(
                "Claude closeDrainTimeoutMs must be positive",
            )
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        this.ready.catch(() => {
            // suppressed — story agents normally await `done`
        })
        this.done = new Promise<ClaudeRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    private settleDone(
        summary: ClaudeRunSummary,
        waitForProcessTree = true,
    ): void {
        this.clearCloseDrainWatchdog()
        if (this.doneSettled) return
        this.doneSettled = true
        const releaseTreeOwnership = (): void => {
            ClaudeCliParticipant.active.delete(this)
        }
        const processTree = this.processTree
        if (processTree === null) {
            releaseTreeOwnership()
            this.resolveDone(summary)
            return
        }
        processTree.markRootClosed()
        if (!waitForProcessTree) {
            // The participant result is bounded, while both registries retain
            // the tree until its independent cleanup actually completes.
            this.resolveDone(summary)
            void processTree.done.then(releaseTreeOwnership)
            return
        }
        void processTree.done.then(() => {
            releaseTreeOwnership()
            this.resolveDone(summary)
        })
    }

    private startCloseDrainWatchdog(code: number | null): void {
        this.exitCode = code
        if (this.doneSettled || this.closeDrainTimer !== null) return
        this.closeDrainTimer = setTimeout(() => {
            if (this.doneSettled) return
            const error = new Error(
                `claude streams remained open ${this.options.closeDrainTimeoutMs}ms after root exit`,
            )
            this.spawnError = error
            this.transition("failed", error.message)
            this.failReady(error)
            this.settleDone(
                {
                    sessionId: this.sessionId,
                    exitCode: this.exitCode,
                    error,
                    lastResult: this.lastResult,
                },
                false,
            )
            this.destroyLocalStdio()
        }, this.options.closeDrainTimeoutMs)
    }

    private clearCloseDrainWatchdog(): void {
        if (this.closeDrainTimer === null) return
        clearTimeout(this.closeDrainTimer)
        this.closeDrainTimer = null
    }

    private destroyLocalStdio(): void {
        this.proc?.stdin?.destroy()
        this.proc?.stdout?.destroy()
        this.proc?.stderr?.destroy()
    }

    private settleReady(): void {
        if (this.readySettled) return
        this.readySettled = true
        this.resolveReady()
    }

    private failReady(error: Error): void {
        if (this.readySettled) return
        this.readySettled = true
        this.rejectReady(error)
    }

    getSessionId(): string | null {
        return this.sessionId
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /** Idempotent: subsequent calls are a no-op. */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.claudeBin, args, {
                cwd: this.options.cwd,
                env: harnessChildEnvironment(),
                stdio: ["pipe", "pipe", "pipe"],
                detached: POSIX_PROCESS_GROUPS_SUPPORTED,
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.failReady(this.spawnError)
            this.settleDone({
                sessionId: null,
                exitCode: null,
                error: this.spawnError,
                lastResult: null,
            })
            return
        }

        this.proc = proc
        this.processTree = new ManagedProcessTree(proc, {
            ownsProcessGroup: POSIX_PROCESS_GROUPS_SUPPORTED,
        })
        ClaudeCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.once("data", () => this.processTree?.refresh())
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        // `close` waits for every inherited stdio handle. A provider child can
        // keep those handles open after the direct CLI shim has exited, so the
        // tree supervisor must learn about root exit independently.
        proc.on("exit", (code) => {
            this.processTree?.markRootClosed()
            this.startCloseDrainWatchdog(code)
        })
        proc.on("error", (err) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: this.exitCode,
                error: err,
                lastResult: this.lastResult,
            })
        })
        proc.on("close", (code) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            this.exitCode = code
            this.failReady(
                this.spawnError ??
                    new Error("claude exited before system:init"),
            )
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
                lastResult: this.lastResult,
            })
        })
    }

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

    /** Kill Claude and every provider descendant, with shared escalation. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        if (!this.doneSettled) this.transition("aborted")
        this.processTree?.terminate(signal)
    }

    /** True only when the owned POSIX group is authoritatively absent. */
    async abortAndWait(
        signal: NodeJS.Signals = "SIGTERM",
    ): Promise<boolean> {
        const processTree = this.processTree
        if (processTree === null) {
            this.abort(signal)
            return false
        }
        return processTree.terminateAndWait(signal)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // This participant owns bus → stdin forwarding for its agentId;
        // StoryAgent observes these events for lifecycle only and must NOT
        // also write to stdin (double-delivery).
        if (
            AgentTargetedMessage.is(event) &&
            acceptsTargetedMessage(
                source,
                event.data,
                this.agentId,
                this.options.targetedMessageAuthority,
                this.options.targetedMessageCorrelation ?? {},
            ) &&
            source !== this.options.ignoredTargetedMessageAuthority &&
            !(
                this.options.ignoreCorrelatedTerminalFeedback === true &&
                source === this.options.targetedMessageAuthority &&
                typeof event.data.metadata.terminalId === "string"
            )
        ) {
            if (!this.proc?.stdin) return
            this.sendUserMessage(event.data.text)
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
        if (this.options.effort) {
            args.push("--effort", this.options.effort)
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
        // Informational only — not an error.
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
            if (item instanceof SemanticEvent) {
                if (ClaudeSystem.is(item) && item.data.subtype === "init") {
                    this.transition("running", "claude init received")
                    this.settleReady()
                }
                if (AgentResult.is(item)) {
                    this.lastResult = item.data
                    this.transition(
                        item.data.isError ? "failed" : "done",
                        `result:${item.data.subtype}`,
                    )
                }
            }
            this.dispatch(item)
        }
    }

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
