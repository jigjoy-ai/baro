import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    DialogueResponderInvocationError,
    DialogueResponderNotDispatchedError,
    type DialogueResponder,
    type DialogueResponderInvocation,
} from "./dialogue-agent.js"
import {
    VERDICT_SYSTEM_PROMPT,
    extractVerdictJson,
} from "./critic.js"
import {
    prepareGoalInvariantReview,
    verifyGoalInvariantReviewRepositoryFingerprint,
} from "./goal-invariant-review-evidence.js"
import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    ModelInvocationMeasured,
    RunCompleted,
    RunPrepared,
    RunVerificationCompleted,
    type GoalAggregateReviewCompletedData,
    type GoalAggregateReviewRequestedData,
    type RunVerificationCompletedData,
} from "../semantic-events.js"
import { runnerMeasurement } from "../runner-measurement.js"
import type { Metric } from "../model-telemetry.js"
import { providerCallTimeoutError } from "../planning/openai-runtime.js"
import {
    SerializedObserver,
    type SerializedEventContext,
} from "../runtime/serialized-observer.js"
import type {
    GoalAggregateInvariantReview,
    GoalAggregateReviewStatus,
} from "../runtime/goal-aggregate-review.js"
import { createGoalAggregateReviewBasis } from "../runtime/goal-aggregate-review.js"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10_000
const MAX_REVIEWER_CACHE_ENTRIES = 16

export const GOAL_AGGREGATE_REVIEW_SYSTEM_PROMPT = `${VERDICT_SYSTEM_PROMPT}

This is a run-level composition review, not a review of one worker. Evaluate every exact
[G-*] criterion against the complete merged-run repository and verification evidence. A local
story pass is evidence about that shard only; independently check the interaction of all mapped
contributions. violated_criteria must contain only exact criterion strings from the prompt.`

export interface GoalInvariantReviewerOptions {
    runId: string
    cwd: string
    responder: DialogueResponder
    modelUsed: string
    timeoutMs?: number
    maxAttempts?: number
    /** TERM/abort-to-settled budget after the outer evaluator watchdog wins. */
    settlementTimeoutMs?: number
}

interface CachedReview {
    requestKey: string
    data: GoalAggregateReviewCompletedData
}

/** Read-only, provider-neutral semantic evaluator for the fully merged run. */
export class GoalInvariantReviewer extends SerializedObserver {
    private readonly timeoutMs: number
    private readonly maxAttempts: number
    private readonly settlementTimeoutMs: number
    private readonly verifications = new Map<string, RunVerificationCompletedData>()
    private readonly completed = new Map<string, CachedReview>()
    private readonly active = new Map<string, AbortController>()
    private requestAuthority: Participant | null = null
    private verificationAuthority: Participant | null = null
    private repositoryAuthority: Participant | null = null
    private completionAuthority: Participant | null = null
    private baseSha: string | null = null
    private baseShaIssue: string | null = null
    private verificationReplayIssue: string | null = null
    private providerSettlementCertified = true

    constructor(private readonly opts: GoalInvariantReviewerOptions) {
        super()
        this.timeoutMs = nonNegativeInteger(
            opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            "goal reviewer timeoutMs",
        )
        if (this.timeoutMs > 2_147_483_647) {
            throw new RangeError("goal reviewer timeoutMs exceeds timer range")
        }
        this.maxAttempts = positiveInteger(
            opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            "goal reviewer maxAttempts",
        )
        if (this.maxAttempts > 4) {
            throw new RangeError("goal reviewer maxAttempts cannot exceed 4")
        }
        this.settlementTimeoutMs = positiveInteger(
            opts.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
            "goal reviewer settlementTimeoutMs",
        )
        if (this.settlementTimeoutMs > 2_147_483_647) {
            throw new RangeError("goal reviewer settlementTimeoutMs exceeds timer range")
        }
    }

    setRequestAuthority(authority: Participant): void {
        this.requestAuthority = bindAuthority(
            this.requestAuthority,
            authority,
            "goal reviewer request authority",
        )
    }

    setVerificationAuthority(authority: Participant): void {
        this.verificationAuthority = bindAuthority(
            this.verificationAuthority,
            authority,
            "goal reviewer verification authority",
        )
    }

    setRepositoryAuthority(authority: Participant): void {
        this.repositoryAuthority = bindAuthority(
            this.repositoryAuthority,
            authority,
            "goal reviewer repository authority",
        )
    }

    setCompletionAuthority(authority: Participant): void {
        this.completionAuthority = bindAuthority(
            this.completionAuthority,
            authority,
            "goal reviewer completion authority",
        )
    }

    /** Abort and drain every provider call before billing/temp cleanup. */
    async shutdown(): Promise<boolean> {
        for (const controller of this.active.values()) {
            controller.abort(new Error("aggregate reviewer shutdown"))
        }
        await this.idle()
        return this.providerSettlementCertified
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event, source } = context
        if (RunPrepared.is(event) && event.data.runId === this.opts.runId) {
            if (source !== this.repositoryAuthority) return
            if (this.baseSha === null) {
                this.baseSha = event.data.baseSha
            } else if (this.baseSha !== event.data.baseSha) {
                this.baseShaIssue =
                    "trusted RunPrepared replayed the run identity with a conflicting base SHA"
            }
            return
        }
        if (
            RunVerificationCompleted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (source !== this.verificationAuthority) return
            const existing = this.verifications.get(event.data.verificationId)
            if (existing) {
                if (JSON.stringify(existing) !== JSON.stringify(event.data)) {
                    this.verificationReplayIssue =
                        "trusted final verification replayed an id with conflicting evidence"
                }
                return
            }
            setBounded(
                this.verifications,
                event.data.verificationId,
                structuredClone(event.data),
            )
            return
        }
        if (RunCompleted.is(event)) {
            if (!this.completionAuthority || source !== this.completionAuthority) {
                return
            }
            if (event.data.runId && event.data.runId !== this.opts.runId) return
            for (const controller of this.active.values()) {
                controller.abort(new Error("aggregate review cancelled by run completion"))
            }
            return
        }
        if (
            !GoalAggregateReviewRequested.is(event) ||
            event.data.runId !== this.opts.runId ||
            source !== this.requestAuthority
        ) return

        const requestKey = JSON.stringify(event.data)
        const cached = this.completed.get(event.data.reviewId)
        if (cached) {
            if (cached.requestKey !== requestKey) {
                this.emit(
                    GoalAggregateReviewCompleted.create(
                        this.inconclusive(
                            event.data,
                            0,
                            "aggregate review id replayed with conflicting request correlation",
                        ),
                    ),
                )
                return
            }
            if (cached.data.repositoryFingerprint === null) {
                this.emit(GoalAggregateReviewCompleted.create(cached.data))
                return
            }
            if (this.active.has(event.data.reviewId)) return
            this.replayCachedReview(context, event.data, cached)
            return
        }
        if (this.active.has(event.data.reviewId)) return

        const controller = new AbortController()
        this.active.set(event.data.reviewId, controller)
        context.spawnTask(
            {
                label: `review global goal ${event.data.reviewId}`,
                key: event.data.reviewId,
            },
            async () => {
                try {
                    const data = await this.evaluate(event.data, controller.signal)
                    if (controller.signal.aborted) return
                    setBounded(
                        this.completed,
                        event.data.reviewId,
                        { requestKey, data },
                    )
                    this.emit(GoalAggregateReviewCompleted.create(data))
                } catch (error) {
                    if (error instanceof GoalReviewProviderUnsettled) {
                        this.providerSettlementCertified = false
                    }
                    throw error
                } finally {
                    if (this.active.get(event.data.reviewId) === controller) {
                        this.active.delete(event.data.reviewId)
                    }
                }
            },
        )
    }

    private replayCachedReview(
        context: SerializedEventContext,
        request: GoalAggregateReviewRequestedData,
        cached: CachedReview,
    ): void {
        const controller = new AbortController()
        this.active.set(request.reviewId, controller)
        context.spawnTask(
            {
                label: `revalidate cached goal review ${request.reviewId}`,
                key: request.reviewId,
            },
            async () => {
                try {
                    let issue = this.currentEvidenceIssue(request)
                    if (!issue) {
                        issue = await verifyGoalInvariantReviewRepositoryFingerprint(
                            this.opts.cwd,
                            this.baseSha!,
                            cached.data.repositoryFingerprint!,
                        )
                    }
                    issue ??= this.currentEvidenceIssue(request)
                    if (controller.signal.aborted) return
                    this.emit(
                        GoalAggregateReviewCompleted.create(
                            issue
                                ? this.inconclusive(
                                      request,
                                      cached.data.attempts,
                                      issue,
                                  )
                                : cached.data,
                        ),
                    )
                } finally {
                    if (this.active.get(request.reviewId) === controller) {
                        this.active.delete(request.reviewId)
                    }
                }
            },
        )
    }

    private async evaluate(
        request: GoalAggregateReviewRequestedData,
        signal: AbortSignal,
    ): Promise<GoalAggregateReviewCompletedData> {
        const { fingerprint: _claimedFingerprint, ...basisInput } = request.basis
        let calculatedFingerprint: string
        try {
            calculatedFingerprint = createGoalAggregateReviewBasis(
                basisInput,
            ).fingerprint
        } catch (error) {
            return this.inconclusive(
                request,
                0,
                `aggregate review basis could not be fingerprinted: ${messageOf(error)}`,
            )
        }
        if (calculatedFingerprint !== request.basis.fingerprint) {
            return this.inconclusive(
                request,
                0,
                "aggregate review basis fingerprint does not match its exact content",
            )
        }
        if (request.reviewId !== `goal-review:${request.basis.fingerprint}`) {
            return this.inconclusive(
                request,
                0,
                "aggregate review id does not match its exact basis",
            )
        }
        const verification = this.verifications.get(request.basis.verificationId)
        const evidenceIssue = this.currentEvidenceIssue(request)
        if (evidenceIssue) {
            return this.inconclusive(request, 0, evidenceIssue)
        }
        const criteria = request.basis.invariants.map(
            ({ invariantId, text }) => `[${invariantId}] ${text}`,
        )
        let preparation: Awaited<ReturnType<typeof prepareGoalInvariantReview>>
        try {
            preparation = await prepareGoalInvariantReview(
                this.opts.cwd,
                this.baseSha!,
                request,
                verification!,
            )
        } catch (error) {
            return this.inconclusive(
                request,
                0,
                `aggregate evidence preparation failed closed: ${messageOf(error)}`,
            )
        }
        if (preparation.status !== "ready") {
            return this.inconclusive(
                request,
                0,
                preparation.issues.join("; ") || "aggregate evidence unavailable",
            )
        }
        const preparationRaceIssue = this.currentEvidenceIssue(request)
        if (preparationRaceIssue) {
            return this.inconclusive(request, 0, preparationRaceIssue)
        }

        let lastError = "aggregate evaluator did not complete"
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            const attemptEvidenceIssue = this.currentEvidenceIssue(request)
            if (attemptEvidenceIssue) {
                return this.inconclusive(
                    request,
                    attempt - 1,
                    attemptEvidenceIssue,
                )
            }
            if (signal.aborted) {
                return this.inconclusive(
                    request,
                    attempt - 1,
                    "aggregate review cancelled",
                )
            }
            const preInvocationRepositoryIssue =
                await verifyGoalInvariantReviewRepositoryFingerprint(
                    this.opts.cwd,
                    this.baseSha!,
                    preparation.repositoryFingerprint,
                )
            if (preInvocationRepositoryIssue) {
                return this.inconclusive(
                    request,
                    attempt - 1,
                    preInvocationRepositoryIssue,
                )
            }
            const preInvocationRaceIssue = this.currentEvidenceIssue(request)
            if (preInvocationRaceIssue) {
                return this.inconclusive(
                    request,
                    attempt - 1,
                    preInvocationRaceIssue,
                )
            }
            if (signal.aborted) {
                return this.inconclusive(
                    request,
                    attempt - 1,
                    "aggregate review cancelled",
                )
            }
            let attemptMeasured = false
            let repositoryFreshnessChecked = false
            try {
                const result = await invokeResponder(
                    this.opts.responder,
                    {
                        runId: this.opts.runId,
                        messageId: `${request.reviewId}:${attempt}`,
                        billingPhase: "verifier",
                        billingAttempt: attempt,
                        systemPrompt: GOAL_AGGREGATE_REVIEW_SYSTEM_PROMPT,
                        userPrompt: preparation.prompt,
                    },
                    signal,
                    this.timeoutMs,
                    this.settlementTimeoutMs,
                )
                if (result.invocation) {
                    this.publishInvocation(
                        request.reviewId,
                        attempt,
                        result.invocation,
                    )
                    attemptMeasured = true
                }
                const completionRaceIssue = this.currentEvidenceIssue(request)
                if (completionRaceIssue) {
                    return this.inconclusive(
                        request,
                        attempt,
                        completionRaceIssue,
                    )
                }
                const repositoryIssue =
                    await verifyGoalInvariantReviewRepositoryFingerprint(
                        this.opts.cwd,
                        this.baseSha!,
                        preparation.repositoryFingerprint,
                    )
                repositoryFreshnessChecked = true
                if (repositoryIssue) {
                    return this.inconclusive(request, attempt, repositoryIssue)
                }
                const repositoryCheckRaceIssue =
                    this.currentEvidenceIssue(request)
                if (repositoryCheckRaceIssue) {
                    return this.inconclusive(
                        request,
                        attempt,
                        repositoryCheckRaceIssue,
                    )
                }
                const invariants = parseInvariantReviews(
                    result.text,
                    criteria,
                    request.basis.invariants.map(({ invariantId }) => invariantId),
                )
                const status = aggregateStatus(invariants)
                return {
                    runId: this.opts.runId,
                    checkId: request.checkId,
                    contractId: request.basis.contractId,
                    goalRevision: request.goalRevision,
                    reviewId: request.reviewId,
                    basisFingerprint: request.basis.fingerprint,
                    verificationId: request.basis.verificationId,
                    repositoryFingerprint: preparation.repositoryFingerprint,
                    status,
                    attempts: attempt,
                    modelUsed: this.opts.modelUsed,
                    invariants,
                }
            } catch (error) {
                lastError = messageOf(error)
                const invocation = invocationFromError(error) ??
                    (!attemptMeasured &&
                    !(error instanceof DialogueResponderNotDispatchedError)
                        ? this.opts.responder.telemetry?.failureInvocation(
                              error instanceof GoalReviewInvocationTimeout
                                  || (error instanceof GoalReviewProviderUnsettled &&
                                      error.interruption === "timeout")
                                  ? "timed_out"
                                  : error instanceof GoalReviewProviderUnsettled &&
                                      error.interruption === "cancelled"
                                    ? "cancelled"
                                  : signal.aborted
                                    ? "cancelled"
                                    : "failed",
                              error instanceof GoalReviewInvocationTimeout
                                  || (error instanceof GoalReviewProviderUnsettled &&
                                      error.interruption === "timeout")
                                  ? "timed_out"
                                  : "not_reported",
                          )
                        : undefined)
                if (!attemptMeasured && invocation) {
                    this.publishInvocation(
                        request.reviewId,
                        attempt,
                        invocation,
                    )
                }
                if (error instanceof GoalReviewProviderUnsettled) {
                    this.providerSettlementCertified = false
                    return this.inconclusive(request, attempt, lastError)
                }
                // A timed-out adapter may ignore AbortSignal. Never overlap a
                // retry with a process whose cleanup cannot be certified.
                if (error instanceof GoalReviewInvocationTimeout) {
                    return this.inconclusive(request, attempt, lastError)
                }
                if (!repositoryFreshnessChecked) {
                    const repositoryIssue =
                        await verifyGoalInvariantReviewRepositoryFingerprint(
                            this.opts.cwd,
                            this.baseSha!,
                            preparation.repositoryFingerprint,
                        )
                    if (repositoryIssue) {
                        return this.inconclusive(
                            request,
                            attempt,
                            repositoryIssue,
                        )
                    }
                }
                const retryRaceIssue = this.currentEvidenceIssue(request)
                if (retryRaceIssue) {
                    return this.inconclusive(request, attempt, retryRaceIssue)
                }
            }
        }
        return this.inconclusive(request, this.maxAttempts, lastError)
    }

    private currentEvidenceIssue(
        request: GoalAggregateReviewRequestedData,
    ): string | null {
        return this.baseShaIssue ??
            this.verificationReplayIssue ??
            verificationIssue(
                this.verifications.get(request.basis.verificationId),
                this.baseSha,
            )
    }

    private inconclusive(
        request: GoalAggregateReviewRequestedData,
        attempts: number,
        reason: string,
    ): GoalAggregateReviewCompletedData {
        const bounded = boundedReviewerReason(reason)
        return {
            runId: this.opts.runId,
            checkId: request.checkId,
            contractId: request.basis.contractId,
            goalRevision: request.goalRevision,
            reviewId: request.reviewId,
            basisFingerprint: request.basis.fingerprint,
            verificationId: request.basis.verificationId,
            repositoryFingerprint: null,
            status: "inconclusive",
            attempts,
            modelUsed: this.opts.modelUsed,
            invariants: request.basis.invariants.map(({ invariantId }) => ({
                invariantId,
                status: "inconclusive",
                reason: bounded,
            })),
        }
    }

    private publishInvocation(
        reviewId: string,
        attempt: number,
        invocation: DialogueResponderInvocation,
    ): void {
        if (invocation.measurementPublished) return
        this.emit(
            ModelInvocationMeasured.create(
                runnerMeasurement(
                    {
                        invocationBaseId:
                            `${this.opts.runId}:goal-review:${reviewId}:${attempt}`,
                        runId: this.opts.runId,
                        phase: "verifier",
                        storyId: null,
                        attempt,
                        backend: invocation.backend,
                        requestedModel: invocation.requestedModel,
                    },
                    invocation.observation,
                ),
            ),
        )
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

function verificationIssue(
    verification: RunVerificationCompletedData | undefined,
    baseSha: string | null,
): string | null {
    if (!baseSha) return "the immutable run base SHA is unavailable"
    if (!verification) return "source-bound final verification evidence is unavailable"
    if (verification.status !== "passed") {
        return `final verification status is ${verification.status}`
    }
    if (
        verification.commands.length === 0 ||
        verification.commands.some(({ status }) => status !== "passed")
    ) {
        return "final verification lacks a complete set of passing commands"
    }
    return null
}

async function invokeResponder(
    responder: DialogueResponder,
    input: Parameters<DialogueResponder>[0],
    outerSignal: AbortSignal,
    timeoutMs: number,
    settlementTimeoutMs: number,
): Promise<{ text: string; invocation?: DialogueResponderInvocation }> {
    const controller = new AbortController()
    let notifyAbort: (() => void) | null = null
    const abort = () => {
        controller.abort(
            outerSignal.reason ?? new Error("aggregate review cancelled"),
        )
        notifyAbort?.()
    }
    outerSignal.addEventListener("abort", abort, { once: true })
    type Settlement =
        | {
              kind: "fulfilled"
              value: string | Awaited<ReturnType<DialogueResponder>>
          }
        | { kind: "rejected"; error: unknown }
    const responderSettlement: Promise<Settlement> = Promise.resolve()
        .then(() => responder(input, controller.signal))
        .then(
            (value) => ({ kind: "fulfilled" as const, value }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
        )

    let watchdog: ReturnType<typeof setTimeout> | null = null
    let settlementTimer: ReturnType<typeof setTimeout> | null = null
    try {
        const timeout = new Promise<"timeout">((resolveTimeout) => {
            watchdog = setTimeout(() => {
                // Preserve timeout attribution through the responder and the
                // Mozaik inference interceptor before Gateway telemetry lands.
                controller.abort(providerCallTimeoutError(timeoutMs))
                resolveTimeout("timeout")
            }, Math.max(1, timeoutMs))
        })
        const cancelled = new Promise<"cancelled">((resolveCancelled) => {
            notifyAbort = () => resolveCancelled("cancelled")
            if (outerSignal.aborted) abort()
        })
        const first = await Promise.race([
            responderSettlement,
            timeout,
            cancelled,
        ])
        if (first !== "timeout" && first !== "cancelled") {
            if (first.kind === "rejected") throw first.error
            return normalizeResponderValue(first.value)
        }

        const settled = await Promise.race([
            responderSettlement,
            new Promise<"unsettled">((resolveUnsettled) => {
                settlementTimer = setTimeout(
                    () => resolveUnsettled("unsettled"),
                    settlementTimeoutMs,
                )
            }),
        ])
        if (settled === "unsettled") {
            throw new GoalReviewProviderUnsettled(
                `aggregate evaluator did not certify provider settlement within ${settlementTimeoutMs}ms after ${first}`,
                first,
            )
        }
        if (
            settled.kind === "rejected" &&
            settled.error instanceof DialogueResponderNotDispatchedError
        ) {
            // Preserve the zero-dispatch marker even if the watchdog won the
            // same race; otherwise fallback telemetry invents a model call.
            throw settled.error
        }
        const invocation = settled.kind === "fulfilled"
            ? normalizeResponderValue(settled.value).invocation
            : invocationFromError(settled.error) ?? undefined
        if (first === "timeout") {
            throw new GoalReviewInvocationTimeout(
                `aggregate evaluator timed out after ${timeoutMs}ms and then settled`,
                invocation ? attributeInvocationTimeout(invocation) : undefined,
            )
        }
        throw new GoalReviewInvocationCancelled(
            "aggregate review cancelled after provider settlement",
            invocation,
        )
    } finally {
        if (watchdog) clearTimeout(watchdog)
        if (settlementTimer) clearTimeout(settlementTimer)
        outerSignal.removeEventListener("abort", abort)
        notifyAbort = null
    }
}

function attributeInvocationTimeout(
    invocation: DialogueResponderInvocation,
): DialogueResponderInvocation {
    const observation = invocation.observation
    return {
        ...invocation,
        observation: {
            ...observation,
            status: "timed_out",
            durationMs: timeoutUnknownMetric(observation.durationMs),
            tokens: {
                inputTotal: timeoutUnknownMetric(observation.tokens.inputTotal),
                cachedInput: timeoutUnknownMetric(observation.tokens.cachedInput),
                cacheWriteInput: timeoutUnknownMetric(
                    observation.tokens.cacheWriteInput,
                ),
                outputTotal: timeoutUnknownMetric(observation.tokens.outputTotal),
                reasoningOutput: timeoutUnknownMetric(
                    observation.tokens.reasoningOutput,
                ),
                total: timeoutUnknownMetric(observation.tokens.total),
            },
            cost: {
                providerUsd: timeoutUnknownMetric(observation.cost.providerUsd),
                customerUsd: timeoutUnknownMetric(observation.cost.customerUsd),
                equivalentUsd: timeoutUnknownMetric(
                    observation.cost.equivalentUsd,
                ),
            },
        },
    }
}

function timeoutUnknownMetric(metric: Metric): Metric {
    return metric.state === "unknown" && metric.reason === "not_reported"
        ? { state: "unknown", reason: "timed_out" }
        : metric
}

function normalizeResponderValue(
    value: string | Awaited<ReturnType<DialogueResponder>>,
): { text: string; invocation?: DialogueResponderInvocation } {
    return typeof value === "string"
        ? { text: value }
        : { text: value.text, invocation: value.invocation }
}

class GoalReviewInvocationTimeout extends Error {
    constructor(
        message: string,
        readonly invocation?: DialogueResponderInvocation,
    ) {
        super(message)
    }
}

class GoalReviewInvocationCancelled extends Error {
    constructor(
        message: string,
        readonly invocation?: DialogueResponderInvocation,
    ) {
        super(message)
    }
}

class GoalReviewProviderUnsettled extends Error {
    constructor(
        message: string,
        readonly interruption: "timeout" | "cancelled",
    ) {
        super(message)
    }
}

function parseInvariantReviews(
    text: string,
    criteria: readonly string[],
    invariantIds: readonly string[],
): readonly GoalAggregateInvariantReview[] {
    const parsed: unknown = JSON.parse(extractVerdictJson(text.trim()))
    if (!plainRecord(parsed)) throw new Error("aggregate evaluator returned no verdict object")
    const verdict = parsed.verdict
    const reasoning = parsed.reasoning
    const violated = parsed.violated_criteria
    if (
        (verdict !== "pass" && verdict !== "fail") ||
        typeof reasoning !== "string" ||
        reasoning.trim().length === 0 ||
        reasoning.length > 2_000 ||
        !Array.isArray(violated) ||
        violated.some((item) => typeof item !== "string")
    ) {
        throw new Error("aggregate evaluator returned an invalid verdict object")
    }
    const violatedCriteria = violated as string[]
    if (
        new Set(violatedCriteria).size !== violatedCriteria.length ||
        violatedCriteria.some((criterion) => !criteria.includes(criterion)) ||
        (verdict === "pass" && violatedCriteria.length > 0) ||
        (verdict === "fail" && violatedCriteria.length === 0)
    ) {
        throw new Error("aggregate evaluator violated the exact criterion contract")
    }
    const failed = new Set(violatedCriteria)
    return criteria.map((criterion, index) => ({
        invariantId: invariantIds[index]!,
        status: failed.has(criterion) ? "failed" : "passed",
        reason: failed.has(criterion)
            ? reasoning.trim()
            : "run-level evaluator found no violation for this invariant",
    }))
}

function aggregateStatus(
    invariants: readonly GoalAggregateInvariantReview[],
): GoalAggregateReviewStatus {
    return invariants.some(({ status }) => status === "failed")
        ? "failed"
        : invariants.some(({ status }) => status === "inconclusive")
        ? "inconclusive"
        : "passed"
}

function invocationFromError(error: unknown): DialogueResponderInvocation | null {
    if (error instanceof DialogueResponderInvocationError) return error.invocation
    if (
        error instanceof GoalReviewInvocationTimeout ||
        error instanceof GoalReviewInvocationCancelled
    ) return error.invocation ?? null
    return null
}

function bindAuthority(
    current: Participant | null,
    authority: Participant,
    label: string,
): Participant {
    if (current && current !== authority) throw new Error(`${label} is already bound`)
    return authority
}

function nonNegativeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`)
    }
    return value
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${label} must be a positive safe integer`)
    }
    return value
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function boundedReviewerReason(value: unknown): string {
    const text = messageOf(value).trim() || "aggregate review was inconclusive"
    return text.length <= 1_500 ? text : `${text.slice(0, 1_497)}...`
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (!map.has(key) && map.size >= MAX_REVIEWER_CACHE_ENTRIES) {
        const oldest = map.keys().next().value as K | undefined
        if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
}
