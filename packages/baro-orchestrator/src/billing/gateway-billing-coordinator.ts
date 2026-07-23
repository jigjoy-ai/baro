import { createHash, timingSafeEqual } from "node:crypto"

import type { TokenUsage } from "../runtime/mozaik.js"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type ModelInvocationMeasuredData,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
    type UnknownMetricReason,
} from "../model-telemetry.js"
import {
    BillingInvocationRegistry,
    createTrustedGatewayIdentity,
    type BillingInvocationContext,
    type BillingInvocationRecord,
} from "./invocation-registry.js"
import {
    BillingReceiptFeedClient,
    type BillingReceiptFeedClientOptions,
} from "./receipt-feed-client.js"
import { BillingReceiptLedger } from "./receipt-ledger.js"

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000
const MAX_DRAIN_TIMEOUT_MS = 60_000
const DRAIN_POLL_MS = 50

export type BillingMeasurementPublisher = (
    measurement: ModelInvocationMeasuredData,
) => void | Promise<void>

export interface GatewayBillingCoordinatorOptions {
    /** Exact local run identity; Cloud attribution is never trusted for this. */
    readonly runId: string
    /** Exact model-gateway base URL; arbitrary compatible endpoints are never trusted. */
    readonly gatewayBaseUrl: string
    readonly apiKey: string
    readonly publishMeasurement: BillingMeasurementPublisher
    readonly drainTimeoutMs?: number
    readonly initialCursor?: string | null
    readonly commitCursor?: BillingReceiptFeedClientOptions["commitCursor"]
    readonly feedTimeoutMs?: number
    readonly feedMaxRetries?: number
    readonly feedMaxPages?: number
    readonly feedPageSize?: number
    /** Provider-free test seam. */
    readonly fetchImpl?: typeof fetch
}

export interface GatewayBillingDispatch {
    readonly record: BillingInvocationRecord
    readonly requestExtension: {
        readonly _baro_billing: {
            readonly schema_version: 1
            readonly session_id: string
            readonly invocation_id: string
        }
    }
}

export interface GatewayBillingDrainResult {
    readonly registeredInvocations: number
    readonly settledInvocations: number
    readonly unresolvedInvocationIds: readonly string[]
    readonly complete: boolean
    readonly feedError: string | null
}

/**
 * Joins the pre-dispatch invocation registry to the authenticated Cloud feed.
 *
 * This class is intentionally not a second event bus. It accepts external
 * billing input, maps it through the exact local authority registry, and hands
 * one neutral measurement to the caller-provided Mozaik publisher.
 */
export class GatewayBillingCoordinator {
    readonly registry: BillingInvocationRegistry
    readonly feed: BillingReceiptFeedClient

    private readonly ledger: BillingReceiptLedger
    private readonly runId: string
    private readonly publishMeasurement: BillingMeasurementPublisher
    private readonly credentialFingerprint: Buffer
    private readonly drainTimeoutMs: number
    private readonly pendingInvocations = new Set<string>()
    private readonly settledInvocations = new Set<string>()
    private readonly runnerMeasurements = new Set<string>()
    private readonly measurementOutbox = new Map<
        string,
        {
            readonly measurement: ModelInvocationMeasuredData
            readonly invocationId: string
            readonly kind: "runner" | "receipt"
            readonly acknowledge?: () => void
        }
    >()
    private readonly activePublications = new Map<string, Promise<void>>()
    private activePull: Promise<void> | null = null
    private pullRequested = false
    private lastFeedError: Error | null = null
    private closed = false

    constructor(options: GatewayBillingCoordinatorOptions) {
        if (typeof options.publishMeasurement !== "function") {
            throw new TypeError("publishMeasurement is required")
        }
        const trustedGateway = createTrustedGatewayIdentity(
            options.gatewayBaseUrl,
        )
        this.registry = new BillingInvocationRegistry({ trustedGateway })
        this.ledger = new BillingReceiptLedger(this.registry)
        this.feed = new BillingReceiptFeedClient({
            gatewayBaseUrl: trustedGateway.baseUrl,
            apiKey: options.apiKey,
            billingSessionId: this.registry.billingSessionId,
            initialCursor: options.initialCursor,
            timeoutMs: options.feedTimeoutMs,
            maxRetries: options.feedMaxRetries,
            maxPages: options.feedMaxPages,
            pageSize: options.feedPageSize,
            commitCursor: options.commitCursor,
            fetchImpl: options.fetchImpl,
        })
        this.publishMeasurement = options.publishMeasurement
        this.credentialFingerprint = credentialFingerprint(options.apiKey)
        this.runId = safeText(options.runId, "runId", 512)
        this.drainTimeoutMs = boundedInteger(
            options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
            "drainTimeoutMs",
            0,
            MAX_DRAIN_TIMEOUT_MS,
        )
    }

    get billingSessionId(): string {
        return this.registry.billingSessionId
    }

    /**
     * Allocate correlation only when the concrete model endpoint is the exact
     * gateway explicitly configured for this coordinator.
     */
    trustsEndpoint(
        endpointBaseUrl: string | undefined,
        endpointApiKey: string | undefined,
    ): boolean {
        if (this.closed || !endpointBaseUrl || !endpointApiKey) return false
        try {
            return (
                createTrustedGatewayIdentity(endpointBaseUrl).baseUrl ===
                    this.registry.trustedGateway.baseUrl &&
                sameCredential(
                    this.credentialFingerprint,
                    credentialFingerprint(endpointApiKey),
                )
            )
        } catch {
            return false
        }
    }

    prepareDispatch(
        endpointBaseUrl: string | undefined,
        endpointApiKey: string | undefined,
        context: BillingInvocationContext,
    ): GatewayBillingDispatch | null {
        if (!this.trustsEndpoint(endpointBaseUrl, endpointApiKey)) return null

        const record = this.registry.allocate({
            ...context,
            runId: this.runId,
        })
        this.pendingInvocations.add(record.invocationId)
        return deepFreeze({
            record,
            requestExtension: {
                _baro_billing: {
                    schema_version: 1 as const,
                    session_id: record.billingSessionId,
                    invocation_id: record.invocationId,
                },
            },
        })
    }

    /** Publish the runner side of the same invocation exactly once. */
    async observeRunner(
        dispatch: GatewayBillingDispatch,
        observation: {
            readonly status: ModelInvocationStatus
            readonly durationMs: number
            readonly usage?: TokenUsage
            readonly missingReason?: UnknownMetricReason
        },
    ): Promise<void> {
        const { record } = dispatch
        if (
            this.registry.get(record.invocationId) !== record ||
            record.trustedGateway.baseUrl !==
                this.registry.trustedGateway.baseUrl
        ) {
            throw new TypeError(
                "billing dispatch was not issued by this coordinator",
            )
        }
        if (this.runnerMeasurements.has(record.invocationId)) return
        this.runnerMeasurements.add(record.invocationId)
        const reason = observation.missingReason ?? "not_reported"
        const measurement = runnerMeasurement(record, observation, reason)
        this.measurementOutbox.set(measurement.measurementId, {
            measurement,
            invocationId: record.invocationId,
            kind: "runner",
        })
        try {
            await this.publishOutboxEntry(measurement.measurementId)
        } catch (error) {
            // Telemetry must never turn a completed inference into a provider
            // retry. Keep the evidence in the outbox and retry during pulls.
            this.lastFeedError = safeError(error)
        }
        this.requestPull()
    }

    /** Ask for a non-blocking receipt refresh after a request has settled. */
    requestPull(): void {
        if (this.closed) return
        this.pullRequested = true
        if (this.activePull) return
        this.activePull = this.runRequestedPulls().finally(() => {
            this.activePull = null
            if (this.pullRequested && !this.closed) this.requestPull()
        })
    }

    /**
     * Bounded final reconciliation. A missing receipt remains unresolved and
     * therefore unknown; it never becomes a zero-cost observation.
     */
    async drain(): Promise<GatewayBillingDrainResult> {
        const deadline = Date.now() + this.drainTimeoutMs
        do {
            if (Date.now() >= deadline) {
                this.feed.abort("billing reconciliation deadline reached")
                break
            }
            const outboxFinished = await this.waitBeforeDeadline(
                this.flushDetachedOutbox(),
                deadline,
            )
            if (!outboxFinished) break
            this.requestPull()
            const pull = this.activePull
            if (
                pull &&
                !(await this.waitBeforeDeadline(pull, deadline, () => {
                    this.feed.abort("billing reconciliation deadline reached")
                }))
            ) {
                break
            }
            if (
                this.pendingInvocations.size === 0 &&
                this.measurementOutbox.size === 0
            ) {
                break
            }
            if (Date.now() >= deadline) break
            await delay(Math.min(DRAIN_POLL_MS, Math.max(0, deadline - Date.now())))
        } while (!this.closed)

        const unresolved = new Set(this.pendingInvocations)
        for (const entry of this.measurementOutbox.values()) {
            unresolved.add(entry.invocationId)
        }

        return deepFreeze({
            registeredInvocations:
                this.pendingInvocations.size + this.settledInvocations.size,
            settledInvocations: this.settledInvocations.size,
            unresolvedInvocationIds: [...unresolved],
            complete:
                this.pendingInvocations.size === 0 &&
                this.measurementOutbox.size === 0,
            feedError: this.lastFeedError?.message ?? null,
        })
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.feed.close()
    }

    private async runRequestedPulls(): Promise<void> {
        while (this.pullRequested && !this.closed) {
            this.pullRequested = false
            try {
                await this.flushDetachedOutbox()
                await this.feed.drain(async (receipt) => {
                    const result = this.ledger.ingest(
                        receipt,
                        this.feed.trustedGateway,
                    )
                    const measurementId = `billing:${receipt.receiptId}`
                    if (result.state === "accepted") {
                        this.measurementOutbox.set(measurementId, {
                            measurement: result.measurement,
                            invocationId: receipt.invocationId,
                            kind: "receipt",
                            acknowledge: () => {
                                this.pendingInvocations.delete(
                                    receipt.invocationId,
                                )
                                this.settledInvocations.add(
                                    receipt.invocationId,
                                )
                            },
                        })
                    }
                    // If an earlier attempt ingested the receipt but publishing
                    // failed, ledger replay finds the same retained outbox item.
                    // Await its acknowledgement before the feed commits cursor.
                    await this.publishOutboxEntry(measurementId)
                })
                this.lastFeedError = null
            } catch (error) {
                this.lastFeedError = safeError(error)
                return
            }
        }
    }

    private async flushDetachedOutbox(): Promise<void> {
        for (const [measurementId, entry] of this.measurementOutbox) {
            if (entry.kind !== "runner") continue
            try {
                await this.publishOutboxEntry(measurementId)
            } catch (error) {
                this.lastFeedError = safeError(error)
            }
        }
    }

    private publishOutboxEntry(measurementId: string): Promise<void> {
        const active = this.activePublications.get(measurementId)
        if (active) return active
        const entry = this.measurementOutbox.get(measurementId)
        if (!entry) return Promise.resolve()
        const publication = (async () => {
            await this.publishMeasurement(entry.measurement)
            // Delete only after the consumer explicitly acknowledges by
            // returning/resolving. A rejection leaves the exact immutable
            // measurement retryable and prevents cursor advancement.
            if (this.measurementOutbox.get(measurementId) === entry) {
                this.measurementOutbox.delete(measurementId)
                entry.acknowledge?.()
            }
        })().finally(() => {
            if (this.activePublications.get(measurementId) === publication) {
                this.activePublications.delete(measurementId)
            }
        })
        this.activePublications.set(measurementId, publication)
        return publication
    }

    private async waitBeforeDeadline(
        operation: Promise<unknown>,
        deadline: number,
        onDeadline?: () => void,
    ): Promise<boolean> {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            onDeadline?.()
            return false
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                operation.then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => {
                        onDeadline?.()
                        resolve(false)
                    }, remaining)
                }),
            ])
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
    }
}

function runnerMeasurement(
    record: BillingInvocationRecord,
    observation: {
        readonly status: ModelInvocationStatus
        readonly durationMs: number
        readonly usage?: TokenUsage
    },
    missingReason: UnknownMetricReason,
): ModelInvocationMeasuredData {
    const metric = (value: number | undefined, structurallyValid = true): Metric =>
        value === undefined
            ? unknownMetric(missingReason)
            : structurallyValid && validTokenCount(value)
              ? knownMetric(value, "provider_response")
              : unknownMetric("parse_error")
    const usage = observation.usage
    const input = usage?.inputTokens
    const cached = usage?.inputTokenDetails?.cached_tokens
    const output = usage?.outputTokens
    const reasoning = usage?.outputTokenDetails?.reasoning_tokens
    const total = usage?.totalTokens
    const inputValid = input === undefined || validTokenCount(input)
    const outputValid = output === undefined || validTokenCount(output)
    const tokens: ModelTokenMetrics = usage
        ? {
              inputTotal: metric(input),
              cachedInput: metric(
                  cached,
                  cached === undefined ||
                      (validTokenCount(cached) &&
                          (!inputValid || input === undefined || cached <= input)),
              ),
              cacheWriteInput: notApplicableMetric(),
              outputTotal: metric(output),
              reasoningOutput: metric(
                  reasoning,
                  reasoning === undefined ||
                      (validTokenCount(reasoning) &&
                          (!outputValid ||
                              output === undefined ||
                              reasoning <= output)),
              ),
              total: metric(
                  total,
                  total === undefined ||
                      (validTokenCount(total) &&
                          (!inputValid || input === undefined || total >= input) &&
                          (!outputValid || output === undefined || total >= output)),
              ),
          }
        : unknownTokens(missingReason)

    return deepFreeze({
        schemaVersion: 1 as const,
        measurementId: `${record.invocationId}:runner`,
        invocationId: record.invocationId,
        runId: record.runId,
        phase: record.phase,
        storyId: record.storyId,
        leaseId: record.leaseId,
        generation: record.generation,
        attempt: record.attempt,
        turn: record.turn,
        round: record.round,
        backend: record.backend,
        provider: null,
        requestedModel: record.requestedModel,
        resolvedModel: record.requestedModel,
        status: observation.status,
        durationMs:
            Number.isFinite(observation.durationMs) && observation.durationMs >= 0
                ? knownMetric(observation.durationMs, "derived")
                : unknownMetric("parse_error"),
        tokens,
        cost: {
            providerUsd: unknownMetric("pending_gateway_meter"),
            customerUsd: unknownMetric("pending_gateway_meter"),
            equivalentUsd: notApplicableMetric(),
        },
        evidence: {
            producer: "runner" as const,
            providerRequestId: null,
            rateCardVersion: null,
            granularity:
                record.round !== null
                    ? ("round" as const)
                    : record.turn !== null
                      ? ("turn" as const)
                      : ("process" as const),
        },
    })
}

function validTokenCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function credentialFingerprint(secret: string): Buffer {
    if (
        typeof secret !== "string" ||
        secret.length === 0 ||
        secret.length > 16_384 ||
        secret !== secret.trim() ||
        /[\u0000-\u001f\u007f]/.test(secret)
    ) {
        throw new TypeError("billing gateway credential must be safe non-empty text")
    }
    return createHash("sha256").update(secret, "utf8").digest()
}

function sameCredential(left: Buffer, right: Buffer): boolean {
    return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function unknownTokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: unknownMetric(reason),
        reasoningOutput: unknownMetric(reason),
        total: unknownMetric(reason),
    }
}

function boundedInteger(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
): number {
    if (
        !Number.isSafeInteger(value) ||
        (value as number) < minimum ||
        (value as number) > maximum
    ) {
        throw new RangeError(
            `${name} must be a safe integer from ${minimum} to ${maximum}`,
        )
    }
    return value as number
}

function safeText(value: unknown, name: string, maximum: number): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new TypeError(`${name} must be safe non-empty text`)
    }
    return value
}

function safeError(error: unknown): Error {
    if (error instanceof Error) return new Error(error.message)
    return new Error("billing feed failed")
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child)
    }
    return Object.freeze(value)
}
