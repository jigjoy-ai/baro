import type { SemanticEvent } from "@mozaik-ai/core"

import {
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    type RunVerificationCompletedData,
} from "../semantic-events.js"
import {
    SerializedObserver,
    type SerializedEventContext,
} from "../runtime/serialized-observer.js"
import {
    createVerifyPlan,
    mergeVerifyPlans,
    verifyBuild,
    type VerifyPlan,
    type VerifyResult,
} from "../verify.js"

export interface RunVerifierOptions {
    runId: string
    cwd: string
    /** Test seam and future custom-command policy hook. */
    verify?: (cwd: string, signal: AbortSignal) => Promise<VerifyResult>
    /** Optional externally trusted plan; defaults to a constructor-time snapshot. */
    plan?: VerifyPlan
}

/**
 * Objective run-level quality gate.
 *
 * The coordinator requests verification only after every candidate change is
 * integrated. Results are correlated by runId + verificationId so replayed or
 * stale requests cannot complete a newer run phase.
 */
export class RunVerifier extends SerializedObserver {
    private readonly handled = new Set<string>()
    private readonly completed = new Map<string, RunVerificationCompletedData>()
    private readonly active = new Map<string, AbortController>()
    private readonly verify: (cwd: string, signal: AbortSignal) => Promise<VerifyResult>

    constructor(private readonly opts: RunVerifierOptions) {
        super()
        const baselinePlan = opts.plan ?? createVerifyPlan(opts.cwd)
        this.verify =
            opts.verify ??
            ((cwd, signal) =>
                verifyBuild(cwd, {
                    plan: mergeVerifyPlans(
                        baselinePlan,
                        createVerifyPlan(cwd),
                    ),
                    signal,
                }))
    }

    protected override async handleEvent(
        context: SerializedEventContext,
    ): Promise<void> {
        const { event } = context
        if (
            RunVerificationTimedOut.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            this.active.get(event.data.verificationId)?.abort(
                new Error(
                    `verification timed out after ${Math.ceil(event.data.timeoutMs / 1_000)}s`,
                ),
            )
            return
        }
        if (
            !RunVerificationRequested.is(event) ||
            event.data.runId !== this.opts.runId
        ) {
            return
        }

        const cached = this.completed.get(event.data.verificationId)
        if (cached) {
            this.emit(RunVerificationCompleted.create(cached))
            return
        }
        if (this.handled.has(event.data.verificationId)) return

        const { verificationId } = event.data
        this.handled.add(verificationId)
        const controller = new AbortController()
        this.active.set(verificationId, controller)
        context.spawnTask(
            { label: `verify ${verificationId}`, key: verificationId },
            async () => {
                // Drain replay requests already queued in the semantic mailbox
                // before a very fast verifier can populate the replay cache.
                // A request delivered after idle still receives cached evidence.
                await new Promise<void>((resolve) => setImmediate(resolve))
                if (controller.signal.aborted) return
                await this.execute(verificationId, controller)
            },
        )
    }

    private async execute(
        verificationId: string,
        controller: AbortController,
    ): Promise<void> {
        const startedAt = Date.now()
        try {
            const result = await this.verify(this.opts.cwd, controller.signal)
            if (controller.signal.aborted) return
            this.complete({
                runId: this.opts.runId,
                verificationId,
                status: !result.ran
                    ? "skipped"
                    : result.ok
                      ? "passed"
                      : "failed",
                commands: result.commands,
                durationMs: Date.now() - startedAt,
            })
        } catch (error) {
            if (controller.signal.aborted) return
            this.complete({
                runId: this.opts.runId,
                verificationId,
                status: "failed",
                commands: [
                    {
                        command: "baro run verifier",
                        status: "failed",
                        durationMs: Date.now() - startedAt,
                        tail: messageOf(error),
                    },
                ],
                durationMs: Date.now() - startedAt,
            })
        } finally {
            if (this.active.get(verificationId) === controller) {
                this.active.delete(verificationId)
            }
        }
    }

    private complete(data: RunVerificationCompletedData): void {
        this.completed.set(data.verificationId, data)
        this.emit(RunVerificationCompleted.create(data))
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}
