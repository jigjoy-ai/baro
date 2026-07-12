/**
 * Backend-neutral model invocation telemetry.
 *
 * A metric is deliberately tagged instead of represented as a bare number:
 * `known(0)` means the provider reported a real zero, while `unknown(...)`
 * means no trustworthy value was available. Consumers must not coerce the
 * latter to zero when aggregating cost or token usage.
 */

export type MetricSource =
    | "provider_response"
    | "cli_result"
    | "gateway_rate_card"
    | "cloud_charge"
    | "derived"

export type UnknownMetricReason =
    | "not_reported"
    | "not_supported"
    | "parse_error"
    | "timed_out"
    | "pending_gateway_meter"
    | "conflicting_measurements"

export type Metric =
    | {
          readonly state: "known"
          readonly value: number
          readonly source: MetricSource
      }
    | {
          readonly state: "unknown"
          readonly reason: UnknownMetricReason
      }
    | {
          readonly state: "not_applicable"
      }

export function knownMetric(value: number, source: MetricSource): Metric {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`metric value must be a finite non-negative number, got ${value}`)
    }
    return { state: "known", value, source }
}

export function unknownMetric(reason: UnknownMetricReason): Metric {
    return { state: "unknown", reason }
}

export function notApplicableMetric(): Metric {
    return { state: "not_applicable" }
}

export type ModelInvocationPhase =
    | "intake"
    | "architect"
    | "planner"
    | "story"
    | "critic"
    | "surgeon"
    | "dialogue"
    | "verifier"

export type ModelInvocationStatus =
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"

export type ModelInvocationGranularity = "round" | "turn" | "process"
export type ModelTelemetryProducer = "runner" | "gateway" | "cloud"

export interface ModelTokenMetrics {
    /** Normalized total input, including cached input where the backend reports it. */
    readonly inputTotal: Metric
    /** Cached-input subset, not an amount to add to `inputTotal`. */
    readonly cachedInput: Metric
    /** Provider cache-write/create input, where separately reported. */
    readonly cacheWriteInput: Metric
    /** Total output. Reasoning is a subset unless a provider explicitly says otherwise. */
    readonly outputTotal: Metric
    readonly reasoningOutput: Metric
    readonly total: Metric
}

export interface ModelCostMetrics {
    /** Raw upstream cost before Baro markup; Cloud fills this when metered. */
    readonly providerUsd: Metric
    /** Amount billed to the customer/credit balance. */
    readonly customerUsd: Metric
    /** CLI/API-equivalent price when it is not an actual Baro provider charge. */
    readonly equivalentUsd: Metric
}

export interface ModelInvocationEvidence {
    readonly producer: ModelTelemetryProducer
    readonly providerRequestId: string | null
    readonly rateCardVersion: string | null
    readonly granularity: ModelInvocationGranularity
}

/**
 * One observation of a model invocation. Runner and gateway observations may
 * share an `invocationId`; their distinct `measurementId`s are merged by the
 * reducer below without double-counting a replayed measurement.
 */
export interface ModelInvocationMeasuredData {
    readonly schemaVersion: 1
    readonly measurementId: string
    readonly invocationId: string
    readonly runId: string | null
    readonly phase: ModelInvocationPhase
    readonly storyId: string | null
    readonly attempt: number | null
    readonly turn: number | null
    readonly round: number | null
    /** Harness/runtime backend, e.g. claude, openai, codex, opencode, pi. */
    readonly backend: string
    /** Actual upstream provider, when known independently from the backend. */
    readonly provider: string | null
    readonly requestedModel: string | null
    readonly resolvedModel: string | null
    readonly status: ModelInvocationStatus
    readonly durationMs: Metric
    readonly tokens: ModelTokenMetrics
    readonly cost: ModelCostMetrics
    readonly evidence: ModelInvocationEvidence
}

export interface ReducedModelInvocation {
    readonly invocationId: string
    readonly measurementIds: readonly string[]
    /** Deduplicated source observations, retained for dimensions/provenance. */
    readonly measurements: readonly ModelInvocationMeasuredData[]
    readonly durationMs: Metric
    readonly tokens: ModelTokenMetrics
    readonly cost: ModelCostMetrics
}

export interface ModelTelemetryReduction {
    readonly invocations: ReadonlyMap<string, ReducedModelInvocation>
    /** IDs encountered more than once; each duplicate ID is listed once. */
    readonly duplicateMeasurementIds: readonly string[]
}

const SOURCE_PRIORITY: Readonly<Record<MetricSource, number>> = {
    provider_response: 6,
    cloud_charge: 5,
    gateway_rate_card: 4,
    cli_result: 3,
    derived: 2,
}

const UNKNOWN_PRIORITY: Readonly<Record<UnknownMetricReason, number>> = {
    conflicting_measurements: 6,
    parse_error: 5,
    timed_out: 4,
    pending_gateway_meter: 3,
    not_reported: 2,
    not_supported: 1,
}

/**
 * Merge two observations of the same metric. This operation never invents a
 * numeric zero: a known value beats missing data, and equal-authority numeric
 * disagreement becomes an explicit unknown conflict.
 */
export function mergeMetric(left: Metric, right: Metric): Metric {
    return resolveMetrics([left, right])
}

/** Resolve all observations together so reduction is independent of input order. */
function resolveMetrics(metrics: readonly Metric[]): Metric {
    const known = metrics.filter(
        (metric): metric is Extract<Metric, { state: "known" }> =>
            metric.state === "known",
    )
    if (known.length > 0) {
        const highestPriority = Math.max(
            ...known.map((metric) => SOURCE_PRIORITY[metric.source]),
        )
        const authoritative = known.filter(
            (metric) => SOURCE_PRIORITY[metric.source] === highestPriority,
        )
        const values = new Set(authoritative.map((metric) => metric.value))
        return values.size === 1
            ? authoritative[0]!
            : unknownMetric("conflicting_measurements")
    }

    const missing = metrics.filter(
        (metric): metric is Extract<Metric, { state: "unknown" }> =>
            metric.state === "unknown",
    )
    if (missing.length > 0) {
        return missing.reduce((selected, candidate) =>
            UNKNOWN_PRIORITY[candidate.reason] >
            UNKNOWN_PRIORITY[selected.reason]
                ? candidate
                : selected,
        )
    }
    return notApplicableMetric()
}

/**
 * Reduce an unordered telemetry stream into one record per invocation.
 *
 * Duplicate `measurementId`s are ignored globally (audit replay is therefore
 * idempotent). Measurements with different IDs but the same `invocationId` are
 * fused field-by-field; they are observations, not deltas, so token/cost values
 * are never summed here.
 */
export function reduceModelTelemetry(
    measurements: readonly ModelInvocationMeasuredData[],
): ModelTelemetryReduction {
    const seenMeasurementIds = new Set<string>()
    const duplicateMeasurementIds = new Set<string>()
    const mutable = new Map<
        string,
        {
            invocationId: string
            measurementIds: string[]
            measurements: ModelInvocationMeasuredData[]
        }
    >()

    for (const measurement of measurements) {
        if (!measurement.measurementId) {
            throw new Error("measurementId must not be empty")
        }
        if (!measurement.invocationId) {
            throw new Error("invocationId must not be empty")
        }
        if (seenMeasurementIds.has(measurement.measurementId)) {
            duplicateMeasurementIds.add(measurement.measurementId)
            continue
        }
        seenMeasurementIds.add(measurement.measurementId)

        const existing = mutable.get(measurement.invocationId)
        if (!existing) {
            mutable.set(measurement.invocationId, {
                invocationId: measurement.invocationId,
                measurementIds: [measurement.measurementId],
                measurements: [measurement],
            })
            continue
        }

        existing.measurementIds.push(measurement.measurementId)
        existing.measurements.push(measurement)
    }

    const invocations = new Map<string, ReducedModelInvocation>()
    for (const [invocationId, item] of mutable) {
        invocations.set(invocationId, {
            invocationId,
            measurementIds: [...item.measurementIds],
            measurements: [...item.measurements],
            durationMs: resolveMetrics(
                item.measurements.map((measurement) => measurement.durationMs),
            ),
            tokens: {
                inputTotal: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.inputTotal,
                    ),
                ),
                cachedInput: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.cachedInput,
                    ),
                ),
                cacheWriteInput: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.cacheWriteInput,
                    ),
                ),
                outputTotal: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.outputTotal,
                    ),
                ),
                reasoningOutput: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.reasoningOutput,
                    ),
                ),
                total: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.tokens.total,
                    ),
                ),
            },
            cost: {
                providerUsd: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.cost.providerUsd,
                    ),
                ),
                customerUsd: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.cost.customerUsd,
                    ),
                ),
                equivalentUsd: resolveMetrics(
                    item.measurements.map(
                        (measurement) => measurement.cost.equivalentUsd,
                    ),
                ),
            },
        })
    }

    return {
        invocations,
        duplicateMeasurementIds: [...duplicateMeasurementIds],
    }
}
