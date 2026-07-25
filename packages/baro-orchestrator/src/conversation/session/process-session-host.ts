import {
    assertCorrelationId,
    type ConversationResponse,
} from "./conversation-contract.js"
import {
    SessionLifecycle,
    type SessionPhase,
    type SessionPhaseChange,
} from "./session-lifecycle.js"

export interface ProcessRunOutcome {
    success: boolean
    error?: string
}

export interface ProcessRunContext {
    sessionId: string
    runId: string
    goal: NonNullable<ConversationResponse["goalEnvelope"]>
    signal: AbortSignal
    reportPhase(
        phase: "reviewing" | "executing" | "verifying",
        reason: string,
    ): void
}

/**
 * One child-process-backed run. A real adapter owns and kills its child in
 * dispose(); it must not expose or reuse an in-process Mozaik environment.
 */
export interface ProcessIsolatedRun {
    readonly isolation: "process"
    readonly runId: string
    execute(context: ProcessRunContext): Promise<ProcessRunOutcome>
    dispose(): Promise<void> | void
}

export interface ProcessRunFactory {
    create(
        response: ConversationResponse & { goalEnvelope: NonNullable<ConversationResponse["goalEnvelope"]> },
    ): Promise<ProcessIsolatedRun> | ProcessIsolatedRun
}

export interface ProcessSessionHostOptions {
    sessionId: string
    factory: ProcessRunFactory
    onPhaseChange?: (change: SessionPhaseChange) => void
}

export interface HostedRunResult extends ProcessRunOutcome {
    runId: string
}

/**
 * Minimal multi-run host: the conversation/session state stays in this process,
 * while every planning+execution run is a fresh disposable child process. This
 * avoids reusing the current orchestration's unscoped Mozaik participants,
 * timers and ONNX handles across follow-ups.
 */
export class ProcessSessionHost {
    readonly lifecycle: SessionLifecycle
    private readonly usedRunIds = new Set<string>()
    private active: {
        run: ProcessIsolatedRun
        controller: AbortController
        dispose: () => Promise<void>
    } | null = null

    constructor(private readonly options: ProcessSessionHostOptions) {
        this.lifecycle = new SessionLifecycle(options.sessionId)
    }

    async runReadyResponse(
        response: ConversationResponse,
        expectedRequestId: string,
    ): Promise<HostedRunResult> {
        if (this.active) throw new Error("a session run is already active")
        this.lifecycle.acceptConversationResponse(response, expectedRequestId)
        if (response.kind !== "ready" || response.goalEnvelope === null) {
            throw new Error("process run requires a ready conversation response")
        }

        let run: ProcessIsolatedRun
        try {
            run = await this.options.factory.create(
                response as ConversationResponse & {
                    goalEnvelope: NonNullable<ConversationResponse["goalEnvelope"]>
                },
            )
        } catch (error) {
            this.lifecycle.fail(`could not create isolated run: ${messageOf(error)}`)
            this.emitChanges()
            return { runId: "unavailable", success: false, error: messageOf(error) }
        }
        if (run.isolation !== "process") {
            const error = withCleanupFailure(
                "run adapter did not provide process isolation",
                await rejectedRunCleanupFailure(run),
            )
            this.lifecycle.fail(error)
            this.emitChanges()
            return {
                runId: run.runId,
                success: false,
                error,
            }
        }
        try {
            assertCorrelationId(run.runId, "runId")
        } catch (error) {
            const failure = withCleanupFailure(
                `isolated run returned an invalid runId: ${messageOf(error)}`,
                await rejectedRunCleanupFailure(run),
            )
            this.lifecycle.fail(failure)
            this.emitChanges()
            return { runId: String(run.runId), success: false, error: failure }
        }
        if (this.usedRunIds.has(run.runId)) {
            const error = withCleanupFailure(
                "runId was reused across session runs",
                await rejectedRunCleanupFailure(run),
            )
            this.lifecycle.fail(error)
            this.emitChanges()
            return { runId: run.runId, success: false, error }
        }
        this.usedRunIds.add(run.runId)
        const controller = new AbortController()
        let disposePromise: Promise<void> | null = null
        const dispose = (): Promise<void> => {
            disposePromise ??= Promise.resolve().then(() => run.dispose())
            return disposePromise
        }
        this.active = { run, controller, dispose }
        this.lifecycle.startRun(run.runId)
        this.emitChanges()

        let outcome: ProcessRunOutcome
        let disposeError: string | null = null
        try {
            outcome = await run.execute({
                sessionId: this.lifecycle.sessionId,
                runId: run.runId,
                goal: response.goalEnvelope,
                signal: controller.signal,
                reportPhase: (phase, reason) => {
                    this.lifecycle.advanceRun(run.runId, phase, reason)
                    this.emitChanges()
                },
            })
        } catch (error) {
            outcome = { success: false, error: messageOf(error) }
        } finally {
            try {
                await dispose()
            } catch (error) {
                disposeError = messageOf(error)
            }
            this.active = null
        }

        if (disposeError) {
            const aborted = controller.signal.aborted
            this.lifecycle.fail(
                `isolated run cleanup failed${aborted ? " after abort" : ""}: ${disposeError}`,
                run.runId,
            )
            outcome = {
                success: false,
                error: aborted
                    ? `run aborted; cleanup failed: ${disposeError}`
                    : `cleanup failed: ${disposeError}`,
            }
        } else if (controller.signal.aborted) {
            this.lifecycle.fail("isolated run was aborted", run.runId)
            outcome = { success: false, error: "run aborted" }
        } else if (!outcome.success) {
            this.lifecycle.fail(outcome.error || "isolated run failed", run.runId)
        } else if (this.lifecycle.phase !== "verifying") {
            this.lifecycle.fail(
                "isolated run reported success without verification phase",
                run.runId,
            )
            outcome = {
                success: false,
                error: "run reported success without verification",
            }
        } else {
            this.lifecycle.advanceRun(run.runId, "completed", "verified run completed")
        }
        this.emitChanges()
        return { runId: run.runId, ...outcome }
    }

    abort(): void {
        const active = this.active
        if (!active) return
        active.controller.abort()
        // A non-cooperative child may ignore the signal and keep execute()
        // pending. Disposal owns process-tree termination, so start it now;
        // runReadyResponse awaits the same idempotent promise in its finally.
        void active.dispose().catch(() => undefined)
    }

    beginFollowUp(): void {
        if (this.active) throw new Error("cannot begin follow-up during an active run")
        this.lifecycle.beginFollowUp()
        this.emitChanges()
    }

    close(): void {
        if (this.active) {
            throw new Error("abort and await the active run before closing the session")
        }
        this.lifecycle.close()
        this.emitChanges()
    }

    private emittedChanges = 0

    private emitChanges(): void {
        const changes = this.lifecycle.phaseChanges()
        for (; this.emittedChanges < changes.length; this.emittedChanges += 1) {
            this.options.onPhaseChange?.(changes[this.emittedChanges]!)
        }
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function rejectedRunCleanupFailure(
    run: ProcessIsolatedRun,
): Promise<string | null> {
    try {
        await run.dispose()
        return null
    } catch (error) {
        return messageOf(error)
    }
}

function withCleanupFailure(reason: string, cleanupError: string | null): string {
    return cleanupError ? `${reason}; cleanup failed: ${cleanupError}` : reason
}

/** Compile-time guard that keeps the host phase vocabulary caller-owned. */
export type HostedActivePhase = Extract<
    SessionPhase,
    "planning" | "reviewing" | "executing" | "verifying"
>
