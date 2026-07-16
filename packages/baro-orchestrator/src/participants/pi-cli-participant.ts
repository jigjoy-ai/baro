/**
 * Wraps a one-shot `pi --mode json -p --no-session "PROMPT"` subprocess as a
 * Mozaik Participant. No stdin channel or permission prompts in `-p` mode.
 * Event shapes: docs/stream-protocols.md § Pi.
 * Library-grade: knows agent IDs, cwds, and Pi — nothing about baro/PRD/stories.
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
import { ManagedProcessTree } from "../process-tree.js"
import {
    AgentState,
    AgentTargetedMessage,
    PiSystem,
    type AgentPhase,
} from "../semantic-events.js"
import { mapPiEvent } from "../pi-stream-mapper.js"
import { appendCliDiagnosticTail } from "./cli-story-failure.js"

export interface PiCliParticipantOptions {
    cwd: string
    prompt: string
    /** Provider override (e.g. "anthropic"); Pi's default is "google". */
    provider?: string
    model?: string
    piBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
}

export interface PiRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
    /**
     * At least one `agent_end` seen. Pi exits 0 even on a no-op/refused
     * turn, so exitCode alone is not proof of completion — require this too.
     */
    sawAgentEnd: boolean
    /**
     * `tool_execution_start` count. Zero tools on a code-writing story means
     * the agent likely answered in prose instead of editing the worktree.
     */
    toolCallCount: number
    /**
     * `tool_execution_end` events with `isError !== true`. Gate success on
     * this, not attempts — a run where every tool failed still emits
     * agent_end with toolCallCount > 0.
     */
    toolSuccessCount: number
}

export class PiCliParticipant extends BaseObserver {
    /**
     * Process-wide registry for the orchestrator's SIGINT/SIGTERM handlers,
     * so a killed baro doesn't leave orphaned agents burning quota.
     */
    private static readonly active = new Set<PiCliParticipant>()

    /** Signal every active Pi child; each escalates per {@link abort}. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of PiCliParticipant.active) {
            p.abort(signal)
        }
    }

    private readonly options: Required<
        Pick<PiCliParticipantOptions, "piBin" | "closeDrainTimeoutMs">
    > &
        PiCliParticipantOptions

    private proc: ChildProcess | null = null
    private processTree: ManagedProcessTree | null = null
    private buffer = ""
    private stderrTail = ""
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
    private closeDrainTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: PiRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Cap on the un-newlined stdout buffer (16 MiB). See handleStdout. */
    private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024
    private static readonly CLOSE_DRAIN_TIMEOUT_MS = 7_500

    /** Resolves once Pi emits its first `agent_start` or `session` event. */
    public readonly ready: Promise<void>
    /** Resolves after stream close, or a bounded post-root-exit drain failure. */
    public readonly done: Promise<PiRunSummary>

    constructor(
        public readonly agentId: string,
        opts: PiCliParticipantOptions,
    ) {
        super()
        // Nullish-coalesce so an explicit `undefined` can't clobber the default.
        this.options = {
            ...opts,
            piBin: opts.piBin ?? "pi",
            closeDrainTimeoutMs:
                opts.closeDrainTimeoutMs ??
                PiCliParticipant.CLOSE_DRAIN_TIMEOUT_MS,
        }
        if (
            !Number.isFinite(this.options.closeDrainTimeoutMs) ||
            this.options.closeDrainTimeoutMs < 1
        ) {
            throw new RangeError("Pi closeDrainTimeoutMs must be positive")
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        // No-op catch prevents UnhandledPromiseRejection when callers only
        // await `done`; awaiting `ready` still observes the rejection.
        this.ready.catch(() => { /* suppressed — callers use `done` */ })
        this.done = new Promise<PiRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    /**
     * `close` and `error` can fire in either order, or one without the other;
     * every resolution path goes through here so `done` settles exactly once
     * (an async spawn error must not leave `done` pending for a later close).
     */
    private settleDone(summary: PiRunSummary, waitForProcessTree = true): void {
        this.clearCloseDrainWatchdog()
        if (this.doneSettled) return
        this.doneSettled = true
        const releaseTreeOwnership = (): void => {
            PiCliParticipant.active.delete(this)
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
                `pi streams remained open ${this.options.closeDrainTimeoutMs}ms after root exit`,
            )
            this.spawnError = error
            this.transition("failed", error.message)
            this.failReady(error)
            this.settleDone(
                {
                    sessionId: this.sessionId,
                    exitCode: this.exitCode,
                    error,
                    stderrTail: this.stderrTail || null,
                    sawAgentEnd: this.sawAgentEnd,
                    toolCallCount: this.toolCallCount,
                    toolSuccessCount: this.toolSuccessCount,
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

    /**
     * Also called on a clean close that never produced `session`/`agent_start`
     * — otherwise `ready` would stay pending forever for any awaiter.
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

    /** Idempotent: subsequent calls are a no-op. */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.options.piBin, args, {
                cwd: this.options.cwd,
                env: harnessChildEnvironment(),
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
                stderrTail: this.stderrTail || null,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
            return
        }

        this.proc = proc
        this.processTree = new ManagedProcessTree(proc)
        PiCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.once("data", () => this.processTree?.refresh())
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        // A final line without `\n` (e.g. agent_end) would otherwise be
        // dropped, corrupting the success predicate. 'end' fires after the
        // last 'data', before the child 'close' boundary.
        proc.stdout!.on("end", () => this.flushStdout())
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        // Root `exit` precedes `close` when a descendant inherited stdio. Tell
        // the tree supervisor now so that descendant cannot hold `done` open.
        proc.on("exit", (code) => {
            this.processTree?.markRootClosed()
            this.startCloseDrainWatchdog(code)
        })
        proc.on("error", (err) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            // Settle async process errors directly; a later `close` is safely
            // ignored by settleDone's exact-once guard.
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: this.exitCode,
                error: err,
                stderrTail: this.stderrTail || null,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
        })
        // `exit` can precede the final stdout/stderr data. `close` is the
        // terminal boundary for the normal path because it fires only after
        // those streams close; the `error` path above still settles directly.
        proc.on("close", (code) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            this.exitCode = code
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            // Reject `ready` if Pi exited without ever emitting
            // session/agent_start, so an awaiter can't hang.
            this.failReady(
                new Error(
                    `pi exited (code ${code}) before signalling ready`,
                ),
            )
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: code,
                error: this.spawnError,
                stderrTail: this.stderrTail || null,
                sawAgentEnd: this.sawAgentEnd,
                toolCallCount: this.toolCallCount,
                toolSuccessCount: this.toolSuccessCount,
            })
        })
    }

    /** Shared tree supervisor escalates and retains ownership until clean. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        if (!this.doneSettled) this.transition("aborted")
        this.processTree?.terminate(signal)
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Pi `-p` is one-shot — no stdin channel; targeted messages are
        // logged and dropped.
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
        const args = ["--mode", "json", "-p", "--no-session"]
        if (this.options.provider) args.push("--provider", this.options.provider)
        if (this.options.model) args.push("--model", this.options.model)
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
        // A pathological newline-less stream (wedged Pi, one enormous
        // tool-result line) must not balloon memory; drop the partial but
        // keep parsing well-formed lines that follow.
        if (this.buffer.length > PiCliParticipant.MAX_BUFFER_BYTES) {
            process.stderr.write(
                `[pi:${this.agentId}] stdout buffer exceeded ${PiCliParticipant.MAX_BUFFER_BYTES} bytes without a newline — discarding partial line\n`,
            )
            this.buffer = ""
        }
    }

    private flushStdout(): void {
        const line = this.buffer.trim()
        this.buffer = ""
        if (line) this.processLine(line)
    }

    private handleStderr(chunk: string): void {
        this.stderrTail = appendCliDiagnosticTail(this.stderrTail, chunk)
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

        // Completion evidence for the success predicate — exit 0 alone is
        // not sufficient (see PiRunSummary field docs).
        if (parsed.type === "agent_end") this.sawAgentEnd = true
        if (parsed.type === "tool_execution_start") this.toolCallCount += 1
        if (parsed.type === "tool_execution_end" && parsed.isError !== true) {
            this.toolSuccessCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                if (
                    PiSystem.is(item) &&
                    (item.data.subtype === "session" ||
                        item.data.subtype === "agent_start")
                ) {
                    this.transition("running", "pi agent started")
                    this.settleReady()
                }
                // Don't transition to "done" on agent_end — the process-close
                // listener owns that, so the real exit code is observed first.
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
