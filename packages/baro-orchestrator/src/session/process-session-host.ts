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
    private active: { run: ProcessIsolatedRun; controller: AbortController } | null = null

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
            await Promise.resolve(run.dispose()).catch(() => undefined)
            this.lifecycle.fail("run adapter did not provide process isolation")
            this.emitChanges()
            return {
                runId: run.runId,
                success: false,
                error: "run adapter did not provide process isolation",
            }
        }
        try {
            assertCorrelationId(run.runId, "runId")
        } catch (error) {
            await Promise.resolve(run.dispose()).catch(() => undefined)
            this.lifecycle.fail(`isolated run returned an invalid runId: ${messageOf(error)}`)
            this.emitChanges()
            return { runId: String(run.runId), success: false, error: messageOf(error) }
        }
        if (this.usedRunIds.has(run.runId)) {
            await Promise.resolve(run.dispose()).catch(() => undefined)
            this.lifecycle.fail("runId was reused across session runs")
            this.emitChanges()
            return { runId: run.runId, success: false, error: "runId was reused" }
        }
        this.usedRunIds.add(run.runId)
        const controller = new AbortController()
        this.active = { run, controller }
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
                await run.dispose()
            } catch (error) {
                disposeError = messageOf(error)
            }
            this.active = null
        }

        if (controller.signal.aborted) {
            this.lifecycle.fail("isolated run was aborted", run.runId)
            outcome = { success: false, error: "run aborted" }
        } else if (disposeError) {
            this.lifecycle.fail(`isolated run cleanup failed: ${disposeError}`, run.runId)
            outcome = { success: false, error: `cleanup failed: ${disposeError}` }
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
        this.active?.controller.abort()
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

/** Compile-time guard that keeps the host phase vocabulary caller-owned. */
export type HostedActivePhase = Extract<
    SessionPhase,
    "planning" | "reviewing" | "executing" | "verifying"
>
