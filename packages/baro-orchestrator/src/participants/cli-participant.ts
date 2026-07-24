/**
 * Shared process skeleton for CLI harness participants (Claude, Codex,
 * OpenCode, Pi): spawn + managed process tree, exact-once done settlement
 * across racing `error`/`exit`/`close`, the bounded post-root-exit drain
 * watchdog, NDJSON stdout framing, stderr passthrough, and item dispatch.
 * A backend contributes its argv, per-line consumption (stream mapping,
 * completion counters, the ready trigger), and its run summary.
 *
 * Library-grade: knows agent IDs, cwds, and the CLI contract — nothing
 * about baro/PRD/stories.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "../runtime/mozaik.js"

import { harnessChildEnvironment } from "../harness-environment.js"
import {
    ManagedProcessTree,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "../process-tree.js"
import { AgentState, type AgentPhase } from "../semantic-events.js"
import { appendCliDiagnosticTail } from "./cli-story-failure.js"

export interface CliRunSummaryCore {
    exitCode: number | null
    error: Error | null
}

export interface CliParticipantSpec {
    /** Lowercase harness name used in log prefixes and watchdog errors. */
    name: string
    binary: string
    cwd: string
    /** Claude keeps a live stdin session; one-shot harnesses take none. */
    stdinMode: "ignore" | "pipe"
    /** Bound inherited-stdio drain after the direct CLI root exits. */
    closeDrainTimeoutMs: number
    /** Retain a bounded stderr tail for terminal failure classification. */
    captureStderrTail: boolean
}

export abstract class CliParticipant<
    TSummary extends CliRunSummaryCore,
> extends BaseObserver {
    /**
     * Process-wide registry for the orchestrator's SIGINT/SIGTERM handlers,
     * so a killed baro doesn't leave orphaned agents burning quota.
     */
    private static readonly active = new Set<CliParticipant<never>>()

    /** Signal every active instance of `ctor`'s class. Idempotent. */
    protected static killAllInstances(
        ctor: abstract new (...args: never[]) => unknown,
        signal: NodeJS.Signals,
    ): void {
        for (const participant of CliParticipant.active) {
            if (participant instanceof ctor) participant.abort(signal)
        }
    }

    private proc: ChildProcess | null = null
    private processTree: ManagedProcessTree | null = null
    private buffer = ""
    private stderrTailValue = ""
    protected envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    protected exitCode: number | null = null
    protected spawnError: Error | null = null
    private doneSettled = false
    private readySettled = false
    private closeDrainTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: (summary: TSummary) => void
    private resolveReady!: () => void
    private rejectReady!: (e: Error) => void

    /** Resolves once the harness emits its backend-specific ready signal. */
    public readonly ready: Promise<void>
    /** Resolves after stream close, or a bounded post-root-exit drain failure. */
    public readonly done: Promise<TSummary>

    private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024

    protected constructor(
        public readonly agentId: string,
        private readonly spec: CliParticipantSpec,
    ) {
        super()
        if (
            !Number.isFinite(spec.closeDrainTimeoutMs) ||
            spec.closeDrainTimeoutMs < 1
        ) {
            throw new RangeError(
                `${capitalized(spec.name)} closeDrainTimeoutMs must be positive`,
            )
        }
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res
            this.rejectReady = rej
        })
        // No-op catch prevents UnhandledPromiseRejection when callers only
        // await `done`; awaiting `ready` still observes the rejection.
        this.ready.catch(() => { /* suppressed — callers use `done` */ })
        this.done = new Promise<TSummary>((res) => {
            this.resolveDone = res
        })
    }

    /** Complete argv for one spawn of `spec.binary`. */
    protected abstract buildArgs(): string[]

    /** Consume one parsed NDJSON stdout record: map, count, signal ready. */
    protected abstract consumeLine(parsed: Record<string, unknown>): void

    /** Snapshot the backend run summary from current participant state. */
    protected abstract summarize(): TSummary

    /** Ready rejection when the process exits before its ready signal. */
    protected abstract readyFailureMessage(code: number | null): string

    protected get stderrTail(): string | null {
        return this.stderrTailValue || null
    }

    protected get processStdin(): NodeJS.WritableStream | null {
        return this.proc?.stdin ?? null
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    /**
     * `close` and `error` can fire in either order, or one without the other;
     * every resolution path goes through here so `done` settles exactly once
     * (an async spawn error must not leave `done` pending for a later close).
     */
    private settleDone(summary: TSummary, waitForProcessTree = true): void {
        this.clearCloseDrainWatchdog()
        if (this.doneSettled) return
        this.doneSettled = true
        const releaseTreeOwnership = (): void => {
            CliParticipant.active.delete(this as unknown as CliParticipant<never>)
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
                `${this.spec.name} streams remained open ${this.spec.closeDrainTimeoutMs}ms after root exit`,
            )
            this.spawnError = error
            this.transition("failed", error.message)
            this.failReady(error)
            this.settleDone(this.summarize(), false)
            this.destroyLocalStdio()
        }, this.spec.closeDrainTimeoutMs)
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

    protected settleReady(): void {
        if (this.readySettled) return
        this.readySettled = true
        this.resolveReady()
    }

    private failReady(error: Error): void {
        if (this.readySettled) return
        this.readySettled = true
        this.rejectReady(error)
    }

    /** Idempotent: subsequent calls are a no-op. */
    start(environment: AgenticEnvironment): void {
        if (this.proc) return
        this.envRef = environment

        const args = this.buildArgs()
        let proc: ChildProcess
        try {
            proc = spawn(this.spec.binary, args, {
                cwd: this.spec.cwd,
                env: harnessChildEnvironment(),
                stdio: [this.spec.stdinMode, "pipe", "pipe"],
                detached: POSIX_PROCESS_GROUPS_SUPPORTED,
            })
        } catch (e) {
            this.spawnError = e instanceof Error ? e : new Error(String(e))
            this.transition("failed", this.spawnError.message)
            this.failReady(this.spawnError)
            this.settleDone(this.summarize())
            return
        }

        this.proc = proc
        this.processTree = new ManagedProcessTree(proc, {
            ownsProcessGroup: POSIX_PROCESS_GROUPS_SUPPORTED,
        })
        CliParticipant.active.add(this as unknown as CliParticipant<never>)
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
            // Settle async process errors directly; a later `close` is safely
            // ignored by settleDone's exact-once guard.
            this.spawnError = err
            this.transition("failed", err.message)
            this.failReady(err)
            this.settleDone(this.summarize())
        })
        // `exit` can precede the final stdout/stderr data. `close` is the
        // terminal boundary for the normal path because it fires only after
        // those streams close; the `error` path above still settles directly.
        proc.on("close", (code) => {
            this.clearCloseDrainWatchdog()
            if (this.doneSettled) return
            this.exitCode = code
            this.failReady(
                this.spawnError ?? new Error(this.readyFailureMessage(code)),
            )
            const finalPhase: AgentPhase =
                this.spawnError != null || (code != null && code !== 0)
                    ? "failed"
                    : "done"
            this.transition(
                finalPhase,
                code != null ? `exit code ${code}` : "no exit code",
            )
            this.settleDone(this.summarize())
        })
    }

    /** Kill the harness process, escalating if it ignores the soft signal. */
    abort(signal: NodeJS.Signals = "SIGTERM"): void {
        if (!this.doneSettled) this.transition("aborted")
        this.processTree?.terminate(signal)
    }

    /** Whether this invocation actually acquired an owned POSIX process group. */
    hasOwnedProcessGroup(): boolean {
        return this.processTree?.requiresOwnershipManifestEntry() ?? false
    }

    /** Whether spawn returned a concrete provider PID on this platform. */
    hasSpawnedProcess(): boolean {
        return this.processTree?.hasSpawnedRootProcess() ?? false
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

    private handleStdout(chunk: string): void {
        this.buffer += chunk
        let nl: number
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl).trim()
            this.buffer = this.buffer.slice(nl + 1)
            if (!line) continue
            this.processLine(line)
        }
        if (this.buffer.length > CliParticipant.MAX_BUFFER_BYTES) {
            process.stderr.write(
                `[${this.spec.name}:${this.agentId}] stdout buffer exceeded ${CliParticipant.MAX_BUFFER_BYTES} bytes without a newline — discarding partial line\n`,
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
        if (this.spec.captureStderrTail) {
            this.stderrTailValue = appendCliDiagnosticTail(
                this.stderrTailValue,
                chunk,
            )
        }
        const trimmed = chunk.trimEnd()
        if (!trimmed) return
        process.stderr.write(
            `[${this.spec.name}:${this.agentId}/stderr] ${trimmed}\n`,
        )
    }

    private processLine(line: string): void {
        let parsed: Record<string, unknown>
        try {
            parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
            process.stderr.write(
                `[${this.spec.name}:${this.agentId}] non-JSON stdout: ${line.slice(0, 200)}\n`,
            )
            return
        }
        this.consumeLine(parsed)
    }

    protected dispatch(
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

    protected transition(next: AgentPhase, detail?: string): void {
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

function capitalized(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1)
}
