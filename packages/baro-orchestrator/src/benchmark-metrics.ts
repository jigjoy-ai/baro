import type { Metric } from "./model-telemetry.js"

export interface CompleteMetricTotal {
    /** Present only when every applicable observation is known. */
    value: number | null
    known: number
    unknown: number
    notApplicable: number
    total: number
}

export interface ReplanEventSummary {
    /** Legacy Surgeon/Conductor `replan` semantic events. */
    legacyEvents: number
    runtimeProposed: number
    runtimeApplied: number
    runtimeRejected: number
    /** Backward-compatible activity total: legacy events + committed runtime mutations. */
    total: number
}

export function runtimeReplanAuditKey(
    type: string,
    payload: Readonly<Record<string, unknown>>,
): string | null {
    if (
        ![
            "runtime_replan_proposed",
            "runtime_replan_applied",
            "runtime_replan_rejected",
        ].includes(type) ||
        typeof payload.runId !== "string" ||
        !payload.runId ||
        typeof payload.proposalId !== "string" ||
        !payload.proposalId
    ) return null
    if (type === "runtime_replan_applied") {
        if (!Number.isSafeInteger(payload.graphVersion)) return null
        return `${type}\0${payload.runId}\0${payload.proposalId}\0${payload.graphVersion}`
    }
    return `${type}\0${payload.runId}\0${payload.proposalId}`
}

/**
 * Summarize semantic events from the durable audit stream.
 *
 * Runtime `Applied` is also projected to stdout as a protocol-v2 `replan` so
 * the TUI can update its DAG. That UI projection must not be supplied here or
 * the same committed mutation would be counted twice.
 */
export function summarizeReplanEvents(
    auditCounts: Readonly<Record<string, number>>,
): ReplanEventSummary {
    const count = (type: string): number => {
        const value = auditCounts[type]
        return typeof value === "number" && Number.isFinite(value) && value > 0
            ? Math.floor(value)
            : 0
    }
    const legacyEvents = count("replan")
    const runtimeApplied = count("runtime_replan_applied")
    return {
        legacyEvents,
        runtimeProposed: count("runtime_replan_proposed"),
        runtimeApplied,
        runtimeRejected: count("runtime_replan_rejected"),
        total: legacyEvents + runtimeApplied,
    }
}

/** Aggregate deltas without ever converting unknown/not-applicable into zero. */
export function totalCompleteMetrics(
    metrics: readonly Metric[],
): CompleteMetricTotal {
    let value = 0
    let known = 0
    let unknown = 0
    let notApplicable = 0
    for (const metric of metrics) {
        if (metric.state === "known") {
            value += metric.value
            known += 1
        } else if (metric.state === "unknown") {
            unknown += 1
        } else {
            notApplicable += 1
        }
    }
    return {
        value:
            metrics.length > 0 && unknown === 0 && notApplicable === 0
                ? value
                : null,
        known,
        unknown,
        notApplicable,
        total: metrics.length,
    }
}

/** A mean is complete only when every trial has a known value. */
export function meanComplete(values: readonly (number | null)[]): number | null {
    if (values.length === 0) return null
    let sum = 0
    for (const value of values) {
        if (value === null) return null
        sum += value
    }
    return sum / values.length
}

export function metricCoverageLabel(total: CompleteMetricTotal): string {
    return `${total.known}/${total.total}`
}
