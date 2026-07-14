/**
 * Wraps a one-shot `opencode run --format json` subprocess as a Mozaik
 * Participant. No stdin event loop (unlike Claude Code's stream-json input).
 * Event shapes: docs/stream-protocols.md § OpenCode.
 * Library-grade: knows agent IDs, cwds, and OpenCode — nothing about baro/PRD/stories.
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
    AgentState,
    AgentTargetedMessage,
    OpenCodeSystem,
    type AgentPhase,
} from "../semantic-events.js"
import { mapOpenCodeEvent } from "../opencode-stream-mapper.js"
import { appendCliDiagnosticTail } from "./cli-story-failure.js"

export interface OpenCodeCliParticipantOptions {
    cwd: string
    prompt: string
    /** `provider/model` format (e.g. "anthropic/claude-sonnet-4-20250514"). */
    model?: string
    opencodeBin?: string
    /**
     * Pass `--dangerously-skip-permissions` — OpenCode's default mode prompts
     * for tool approvals, which blocks autonomous runs. Default: true.
     */
    skipPermissions?: boolean
}

export interface OpenCodeRunSummary {
    sessionId: string | null
    exitCode: number | null
    error: Error | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
    /**
     * At least one `step_finish` seen. `opencode run` exits 0 even on a
     * refused/no-op turn (verified empirically), so exitCode alone is not
     * proof of completion — require this too.
     */
    sawStepFinish: boolean
    /**
     * `tool_use`/`tool_call` count. Zero tools on a code-writing story means
     * the agent likely answered in prose instead of editing the worktree.
     */
    toolCallCount: number
}

export class OpenCodeCliParticipant extends BaseObserver {
    /**
     * Process-wide registry for the orchestrator's SIGINT/SIGTERM handlers,
     * so a killed baro doesn't leave orphaned agents burning quota.
     */
    private static readonly active = new Set<OpenCodeCliParticipant>()

    /** Send a signal to every active OpenCode child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of OpenCodeCliParticipant.active) {
            p.abort(signal)
        }
    }

    private readonly options: Required<
        Pick<OpenCodeCliParticipantOptions, "opencodeBin" | "skipPermissions">
    > &
        OpenCodeCliParticipantOptions

    private proc: ChildProcess | null = null
    private buffer = ""
    private stderrTail = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private sessionId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private sawStepFinish = false
    private toolCallCount = 0
    private doneSettled = false
    private readySettled = false
    private killTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: OpenCodeRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once OpenCode emits its first `step_start` event. */
    public readonly ready: Promise<void>
    /** Resolves once OpenCode exits and its stdout/stderr streams have closed. */
    public readonly done: Promise<OpenCodeRunSummary>

    private static readonly KILL_GRACE_MS = 5_000
    private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024

    constructor(
        public readonly agentId: string,
        opts: OpenCodeCliParticipantOptions,
    ) {
        super()
        // Nullish-coalesce so an explicit `undefined` can't clobber a default.
        this.options = {
            ...opts,
            opencodeBin: opts.opencodeBin ?? "opencode",
            skipPermissions: opts.skipPermissions ?? true,
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        // No-op catch prevents UnhandledPromiseRejection when callers only
        // await `done`; awaiting `ready` still observes the rejection.
        this.ready.catch(() => { /* suppressed — callers use `done` */ })
        this.done = new Promise<OpenCodeRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    /**
     * `close` and `error` can fire in either order, or one without the other;
     * every resolution path goes through here so `done` settles exactly once
     * (an async spawn error must not leave `done` pending for a later close).
     */
    private settleDone(summary: OpenCodeRunSummary): void {
        if (this.doneSettled) return
        this.doneSettled = true
        if (this.killTimer !== null) {
            clearTimeout(this.killTimer)
            this.killTimer = null
        }
        this.resolveDone(summary)
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
            proc = spawn(this.options.opencodeBin, args, {
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
        proc.stdout!.on("end", () => this.flushStdout())
        proc.stderr!.on("data", (chunk: string) => this.handleStderr(chunk))
        proc.on("error", (err) => {
            // Settle async process errors directly; a later `close` is safely
            // ignored by settleDone's exact-once guard.
            OpenCodeCliParticipant.active.delete(this)
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone({
                sessionId: this.sessionId,
                exitCode: this.exitCode,
                error: err,
                stderrTail: this.stderrTail || null,
                sawStepFinish: this.sawStepFinish,
                toolCallCount: this.toolCallCount,
            })
        })
        // `exit` can precede the final stdout/stderr data. `close` is the
        // terminal boundary for the normal path because it fires only after
        // those streams close; the `error` path above still settles directly.
        proc.on("close", (code) => {
            OpenCodeCliParticipant.active.delete(this)
            this.exitCode = code
            this.failReady(
                this.spawnError ??
                    new Error("opencode exited before step_start"),
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
                stderrTail: this.stderrTail || null,
                sawStepFinish: this.sawStepFinish,
                toolCallCount: this.toolCallCount,
            })
        })
    }

    /** Kill the OpenCode process, escalating if it ignores the soft signal. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        this.transition("aborted")
        const proc = this.proc
        if (!proc) return
        try {
            proc.kill(signal)
        } catch {
            // best-effort
        }
        if (signal === "SIGKILL" || this.killTimer !== null) return
        this.killTimer = setTimeout(() => {
            this.killTimer = null
            if (this.doneSettled) return
            try {
                proc.kill("SIGKILL")
            } catch {
                // best-effort
            }
        }, OpenCodeCliParticipant.KILL_GRACE_MS)
        this.killTimer.unref?.()
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // OpenCode run is one-shot — no stdin channel; targeted messages are
        // logged and dropped.
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
        const args = ["run", "--format", "json"]
        if (this.options.skipPermissions) {
            args.push("--dangerously-skip-permissions")
        }
        if (this.options.model) args.push("-m", this.options.model)
        if (this.options.cwd) args.push("--dir", this.options.cwd)
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
        if (this.buffer.length > OpenCodeCliParticipant.MAX_BUFFER_BYTES) {
            process.stderr.write(
                `[opencode:${this.agentId}] stdout buffer exceeded ${OpenCodeCliParticipant.MAX_BUFFER_BYTES} bytes without a newline — discarding partial line\n`,
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
        // Completion evidence for the success predicate — exit 0 alone is
        // not sufficient (see OpenCodeRunSummary field docs).
        if (parsed.type === "step_finish") this.sawStepFinish = true
        // Real opencode emits `tool_use`; `tool_call` is the legacy fallback.
        if (parsed.type === "tool_use" || parsed.type === "tool_call") {
            this.toolCallCount += 1
        }

        for (const item of items) {
            if (item instanceof SemanticEvent) {
                if (
                    OpenCodeSystem.is(item) &&
                    item.data.subtype === "step_start"
                ) {
                    this.transition("running", "opencode step started")
                    this.settleReady()
                }
                // Don't transition to "done" on step_finish — the process-close
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
