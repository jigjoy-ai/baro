/**
 * Wraps a one-shot `codex exec --json <prompt>` subprocess as a Mozaik
 * Participant. No stdin event loop (unlike Claude Code's stream-json input).
 * Event shapes: docs/stream-protocols.md § Codex.
 * Library-grade: knows agent IDs, cwds, and Codex — nothing about baro/PRD/stories.
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
    AgentState,
    AgentTargetedMessage,
    CodexSystem,
    CodexTurnEvent,
    type AgentPhase,
} from "../semantic-events.js"
import { mapCodexEvent } from "../codex-stream-mapper.js"
import { appendCliDiagnosticTail } from "./cli-story-failure.js"

export interface CodexCliParticipantOptions {
    cwd: string
    prompt: string
    /** Omit to let Codex pick (gpt-5.5 on Plus+, a Mini variant on Free). */
    model?: string
    /**
     * Pass `--dangerously-bypass-approvals-and-sandbox` (`--yolo`).
     * workspace-write sandboxing blocks `.git/` writes so the agent can't
     * commit; per-story worktrees (#50) bound the blast radius.
     * Default: false — leave off for read-only probes.
     */
    bypassSandbox?: boolean
    /**
     * Pass `--skip-git-repo-check` — Codex refuses to run when cwd is not a
     * git repo. Only needed for tests or one-off runs from /tmp.
     */
    skipGitRepoCheck?: boolean
    extraArgs?: string[]
    codexBin?: string
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs?: number
}

export interface CodexRunSummary {
    threadId: string | null
    exitCode: number | null
    error: Error | null
    /** Bounded tail used only to classify terminal operational failures. */
    stderrTail: string | null
}

export class CodexCliParticipant extends BaseObserver {
    /**
     * Process-wide registry for the orchestrator's SIGINT/SIGTERM handlers,
     * so a killed baro doesn't leave orphaned agents burning quota.
     */
    private static readonly active = new Set<CodexCliParticipant>()

    /** Send a signal to every active Codex child. Idempotent. */
    static killAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const p of CodexCliParticipant.active) {
            p.abort(signal)
        }
    }

    private readonly options: Required<
        Pick<
            CodexCliParticipantOptions,
            "codexBin" | "bypassSandbox" | "skipGitRepoCheck" | "closeDrainTimeoutMs"
        >
    > &
        CodexCliParticipantOptions

    private proc: ChildProcess | null = null
    private processTree: ManagedProcessTree | null = null
    private buffer = ""
    private stderrTail = ""
    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private threadId: string | null = null
    private exitCode: number | null = null
    private spawnError: Error | null = null
    private doneSettled = false
    private readySettled = false
    private closeDrainTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: CodexRunSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once Codex emits its first `thread.started` event. */
    public readonly ready: Promise<void>
    /** Resolves after stream close, or a bounded post-root-exit drain failure. */
    public readonly done: Promise<CodexRunSummary>

    private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024
    private static readonly CLOSE_DRAIN_TIMEOUT_MS = 7_500

    constructor(
        public readonly agentId: string,
        opts: CodexCliParticipantOptions,
    ) {
        super()
        // Nullish-coalesce so an explicit `undefined` can't clobber a default
        // (esp. codexBin → spawn crash).
        this.options = {
            ...opts,
            codexBin: opts.codexBin ?? "codex",
            bypassSandbox: opts.bypassSandbox ?? false,
            skipGitRepoCheck: opts.skipGitRepoCheck ?? false,
            closeDrainTimeoutMs:
                opts.closeDrainTimeoutMs ??
                CodexCliParticipant.CLOSE_DRAIN_TIMEOUT_MS,
        }
        if (
            !Number.isFinite(this.options.closeDrainTimeoutMs) ||
            this.options.closeDrainTimeoutMs < 1
        ) {
            throw new RangeError(
                "Codex closeDrainTimeoutMs must be positive",
            )
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        // Story agents await `done`, not `ready`. Keep an async spawn failure
        // observable to explicit ready-awaiters without creating an unhandled
        // rejection for the normal story lifecycle.
        this.ready.catch(() => {
            // suppressed — callers use `done`
        })
        this.done = new Promise<CodexRunSummary>((res) => {
            this.resolveDone = res
        })
    }

    /** Spawn/process errors settle immediately; a later close is a no-op. */
    private settleDone(
        summary: CodexRunSummary,
        waitForProcessTree = true,
    ): void {
        this.clearCloseDrainWatchdog()
        if (this.doneSettled) return
        this.doneSettled = true
        const releaseTreeOwnership = (): void => {
            CodexCliParticipant.active.delete(this)
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
                `codex streams remained open ${this.options.closeDrainTimeoutMs}ms after root exit`,
            )
            this.spawnError = error
            this.transition("failed", error.message)
            this.failReady(error)
            this.settleDone(
                {
                    threadId: this.threadId,
                    exitCode: this.exitCode,
                    error,
                    stderrTail: this.stderrTail || null,
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

    getThreadId(): string | null {
        return this.threadId
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
            proc = spawn(this.options.codexBin, args, {
                cwd: this.options.cwd,
                env: harnessChildEnvironment(),
                stdio: ["ignore", "pipe", "pipe"],
                detached: POSIX_PROCESS_GROUPS_SUPPORTED,
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.failReady(this.spawnError)
            this.settleDone({
                threadId: null,
                exitCode: null,
                error: this.spawnError,
                stderrTail: this.stderrTail || null,
            })
            return
        }

        this.proc = proc
        this.processTree = new ManagedProcessTree(proc, {
            ownsProcessGroup: POSIX_PROCESS_GROUPS_SUPPORTED,
        })
        CodexCliParticipant.active.add(this)
        this.transition("starting")

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")
        proc.stdout!.once("data", () => this.processTree?.refresh())
        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
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
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone({
                threadId: this.threadId,
                exitCode: this.exitCode,
                error: err,
                stderrTail: this.stderrTail || null,
            })
        })
        // `exit` can precede the final stdout/stderr data. `close` is the
        // terminal boundary for the normal path because it fires only after
        // those streams close; the `error` path above still settles directly.
        proc.on("close", (code) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            this.exitCode = code
            this.failReady(
                this.spawnError ??
                    new Error("codex exited before thread.started"),
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
                threadId: this.threadId,
                exitCode: code,
                error: this.spawnError,
                stderrTail: this.stderrTail || null,
            })
        })
    }

    /** Kill the Codex process, escalating if it ignores the soft signal. */
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
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        // Codex exec is one-shot — no stdin channel; targeted messages are
        // logged and dropped.
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
        const args = ["exec", "--json"]
        if (this.options.skipGitRepoCheck) args.push("--skip-git-repo-check")
        if (this.options.bypassSandbox) {
            // Full bypass, not workspace-write: `.git/` is read-only in
            // workspace-write mode (openai/codex#15505) and stories must commit.
            args.push("--dangerously-bypass-approvals-and-sandbox")
        }
        if (this.options.model) args.push("--model", this.options.model)
        if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)
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
        if (this.buffer.length > CodexCliParticipant.MAX_BUFFER_BYTES) {
            process.stderr.write(
                `[codex:${this.agentId}] stdout buffer exceeded ${CodexCliParticipant.MAX_BUFFER_BYTES} bytes without a newline — discarding partial line\n`,
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
                // Lifecycle mapping per docs/stream-protocols.md § Codex.
                // Gotcha: one-shot exec ends at turn.completed;
                // thread.completed appears only on multi-turn sessions.
                if (
                    CodexSystem.is(item) &&
                    item.data.subtype === "thread.started"
                ) {
                    this.transition("running", "codex thread started")
                    this.settleReady()
                }
                if (CodexTurnEvent.is(item)) {
                    const phase = item.data.phase
                    if (phase === "failed") {
                        this.transition("failed", "codex turn failed")
                    }
                }
                // Don't transition to "done" on thread.completed — the
                // process-close listener owns that, so the real exit code is
                // observed first.
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
