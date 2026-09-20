import type { Participant, SemanticEvent } from "../runtime/mozaik.js"

import { StoryResult, StorySpawned } from "../events/execution.js"
import {
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationRetryClassified,
    RunVerificationTimedOut,
    type RunVerificationCompletedData,
    type RunVerificationRetryClassifiedData,
    type VerificationCommandEvidence,
} from "../semantic-events.js"
import { classifyFailureTail } from "./failure-classifier.js"
import {
    SerializedObserver,
    type SerializedEventContext,
} from "../runtime/serialized-observer.js"
import {
    createVerifyPlan,
    mergeVerifyPlans,
    verifyBuild,
    type VerifyCommandResult,
    type VerifyPlan,
    type VerifyResult,
} from "./verify.js"

export interface RunVerifierOptions {
    runId: string
    cwd: string
    /** The host checkout, not the run cwd. */
    hostRepoRoot: string
    /** Test seam and future custom-command policy hook. */
    verify?: (cwd: string, signal: AbortSignal) => Promise<VerifyResult>
    /** Optional externally trusted plan; defaults to a constructor-time snapshot. */
    plan?: VerifyPlan
    /**
     * Reads the authoritative repository/PRD state for each new request.
     * Runtime-added requirements enter here; removed requirements do not
     * survive merely because they existed before execution began.
     */
    createFinalPlan?: (cwd: string) => VerifyPlan
    /** Defaults to stories spawned on the bus without a StoryResult yet. */
    storyExecutorsActive?: () => boolean
}

/**
 * Objective run-level build/test/typecheck/lint quality gate.
 *
 * The coordinator requests verification only after every candidate change is
 * integrated. Results are correlated by runId + verificationId so replayed or
 * stale requests cannot complete a newer run phase.
 */
export class RunVerifier extends SerializedObserver {
    private readonly handled = new Set<string>()
    private readonly completed = new Map<string, RunVerificationCompletedData>()
    private readonly active = new Map<string, AbortController>()
    private readonly runningStories = new Set<string>()
    private readonly verify: (cwd: string, signal: AbortSignal) => Promise<VerifyResult>
    private requestAuthority: Participant | null = null

    constructor(private readonly opts: RunVerifierOptions) {
        super()
        const baselinePlan = opts.plan ?? createVerifyPlan(opts.cwd)
        const createFinalPlan = opts.createFinalPlan ?? createVerifyPlan
        const storyExecutorsActive =
            opts.storyExecutorsActive ?? (() => this.runningStories.size > 0)
        this.verify =
            opts.verify ??
            ((cwd, signal) =>
                verifyBuild(cwd, {
                    plan: mergeVerifyPlans(
                        baselinePlan,
                        createFinalPlan(cwd),
                    ),
                    hostRepoRoot: opts.hostRepoRoot,
                    signal,
                    storyExecutorsActive,
                }))
    }

    setRequestAuthority(authority: Participant): void {
        if (this.requestAuthority && this.requestAuthority !== authority) {
            throw new Error("run verifier request authority is already bound")
        }
        this.requestAuthority = authority
    }

    protected override async handleEvent(
        context: SerializedEventContext,
    ): Promise<void> {
        const { event, source } = context
        if (StorySpawned.is(event)) {
            this.runningStories.add(event.data.storyId)
            return
        }
        if (StoryResult.is(event)) {
            this.runningStories.delete(event.data.storyId)
            return
        }
        if (
            RunVerificationTimedOut.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (!this.requestAuthority || source !== this.requestAuthority) return
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
        // RunVerifier is collective-only. Before the concrete Board is bound,
        // requests must be ignored rather than cached under a predictable id.
        if (!this.requestAuthority || source !== this.requestAuthority) return

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
            const hasFailedCommand = result.commands.some(
                (command) => command.status === "failed",
            )
            const hasSkippedCommand = result.commands.some(
                (command) => command.status === "skipped",
            )
            const hasPassedCommand = result.commands.some(
                (command) => command.status === "passed",
            )
            const { commands, classified } = classifyCommands(result.commands)
            this.complete(
                {
                    runId: this.opts.runId,
                    verificationId,
                    status:
                        !result.ok || hasFailedCommand
                            ? "failed"
                            : !result.ran || hasSkippedCommand || !hasPassedCommand
                              ? "skipped"
                              : "passed",
                    commands,
                    durationMs: Date.now() - startedAt,
                },
                classified,
            )
        } catch (error) {
            if (controller.signal.aborted) return
            const { commands, classified } = classifyCommands([
                {
                    command: "baro run verifier",
                    status: "failed",
                    durationMs: Date.now() - startedAt,
                    tail: messageOf(error),
                },
            ])
            this.complete(
                {
                    runId: this.opts.runId,
                    verificationId,
                    status: "failed",
                    commands,
                    durationMs: Date.now() - startedAt,
                },
                classified,
            )
        } finally {
            if (this.active.get(verificationId) === controller) {
                this.active.delete(verificationId)
            }
        }
    }

    private complete(
        data: RunVerificationCompletedData,
        classified: readonly ClassifiedFailure[] = [],
    ): void {
        this.completed.set(data.verificationId, data)
        // Classifications precede the verdict so a subscriber reacting to the
        // verdict has already seen why each command failed. Replayed requests
        // re-emit only the cached verdict, keeping this exactly-once.
        for (const failure of classified) {
            this.emit(
                RunVerificationRetryClassified.create({
                    runId: data.runId,
                    verificationId: data.verificationId,
                    ...failure,
                }),
            )
        }
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

type ClassifiedFailure = Omit<
    RunVerificationRetryClassifiedData,
    "runId" | "verificationId"
>

/**
 * Stamps bucket + remedy on every command that failed at least once — a
 * command that passed on retry included, since its first failure is what the
 * classification explains. The judged tail is that first failure's, and the
 * runner's own observations (a vanished cwd, a kill at the ceiling) outrank
 * anything re-derived from the text.
 */
function classifyCommands(results: readonly VerifyCommandResult[]): {
    commands: VerificationCommandEvidence[]
    classified: ClassifiedFailure[]
} {
    const classified: ClassifiedFailure[] = []
    const commands = results.map((result): VerificationCommandEvidence => {
        const retried = result.retriedAfterFailure === true
        if (result.status !== "failed" && !retried) return result
        const tail = result.firstFailureTail ?? result.tail ?? ""
        const classification = classifyFailureTail(tail, {
            timedOut: result.timedOut,
            environment: result.environment,
        })
        classified.push({
            command: result.command,
            bucket: classification.bucket,
            remedy: classification.remedy,
            signalId: classification.signalId,
            retried,
            tail,
        })
        return {
            ...result,
            failureBucket: classification.bucket,
            remedy: classification.remedy,
        }
    })
    return { commands, classified }
}
