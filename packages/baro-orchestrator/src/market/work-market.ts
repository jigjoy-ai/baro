/**
 * Pure, deterministic work-bid selection.
 *
 * This module deliberately knows nothing about providers, routes, credentials,
 * the event bus, or participant lifecycle. Callers may extend
 * `WorkBidCandidate` with those fields; `selectWorkBid` returns the original
 * winning object unchanged.
 */

export interface WorkBidEstimate {
    /** Expected provider cost for one attempt. */
    expectedCostUsd: number
    /** Estimated probability that the attempt produces a verified result. */
    estimatedSuccessProbability: number
    /** Expected wall-clock latency for one attempt. */
    estimatedLatencyMs: number
}

export interface WorkBidCandidate {
    workerId: string
    bidId: string
    estimate: WorkBidEstimate
}

export interface WorkBidPolicy {
    /** Reject bids below this estimated success probability. */
    minSuccessProbability?: number
    /** Reject bids whose one-attempt estimate exceeds this amount. */
    maxCostUsd?: number
    /** Reject bids whose latency estimate exceeds this duration. */
    maxLatencyMs?: number
}

/** Runtime validation for estimates arriving across a process/event boundary. */
export function isValidWorkBidEstimate(
    estimate: Readonly<WorkBidEstimate>,
): boolean {
    return (
        isFiniteNonNegative(estimate.expectedCostUsd) &&
        Number.isFinite(estimate.estimatedSuccessProbability) &&
        estimate.estimatedSuccessProbability > 0 &&
        estimate.estimatedSuccessProbability <= 1 &&
        isFiniteNonNegative(estimate.estimatedLatencyMs)
    )
}

/** Expected spend to obtain one verified success under the bid's estimate. */
export function expectedVerifiedCostUsd(
    estimate: Readonly<WorkBidEstimate>,
): number {
    return estimate.expectedCostUsd / estimate.estimatedSuccessProbability
}

/**
 * Select the lowest expected cost per verified success, subject to policy.
 *
 * Tie-breakers are deliberately independent of delivery/array order:
 * lower latency, higher success probability, worker id, then bid id.
 * Invalid bids are ineligible rather than fatal; invalid policy is a caller
 * configuration error and throws.
 */
export function selectWorkBid<T extends WorkBidCandidate>(
    bids: readonly T[],
    policy: Readonly<WorkBidPolicy> = {},
): T | null {
    validatePolicy(policy)

    const eligible = bids.filter((bid) =>
        isValidWorkBidEstimate(bid.estimate) &&
        satisfiesPolicy(bid.estimate, policy),
    )
    eligible.sort(compareBids)
    return eligible[0] ?? null
}

function satisfiesPolicy(
    estimate: Readonly<WorkBidEstimate>,
    policy: Readonly<WorkBidPolicy>,
): boolean {
    return (
        estimate.estimatedSuccessProbability >=
            (policy.minSuccessProbability ?? 0) &&
        estimate.expectedCostUsd <=
            (policy.maxCostUsd ?? Number.POSITIVE_INFINITY) &&
        estimate.estimatedLatencyMs <=
            (policy.maxLatencyMs ?? Number.POSITIVE_INFINITY)
    )
}

function compareBids<T extends WorkBidCandidate>(a: T, b: T): number {
    const costA = expectedVerifiedCostUsd(a.estimate)
    const costB = expectedVerifiedCostUsd(b.estimate)
    if (costA !== costB) return costA < costB ? -1 : 1

    const latencyA = a.estimate.estimatedLatencyMs
    const latencyB = b.estimate.estimatedLatencyMs
    if (latencyA !== latencyB) return latencyA < latencyB ? -1 : 1

    const successA = a.estimate.estimatedSuccessProbability
    const successB = b.estimate.estimatedSuccessProbability
    if (successA !== successB) return successA > successB ? -1 : 1

    const workerOrder = compareText(a.workerId, b.workerId)
    return workerOrder !== 0 ? workerOrder : compareText(a.bidId, b.bidId)
}

function validatePolicy(policy: Readonly<WorkBidPolicy>): void {
    const { minSuccessProbability, maxCostUsd, maxLatencyMs } = policy
    if (
        minSuccessProbability !== undefined &&
        (!Number.isFinite(minSuccessProbability) ||
            minSuccessProbability < 0 ||
            minSuccessProbability > 1)
    ) {
        throw new RangeError("minSuccessProbability must be finite and between 0 and 1")
    }
    if (maxCostUsd !== undefined && !isFiniteNonNegative(maxCostUsd)) {
        throw new RangeError("maxCostUsd must be finite and non-negative")
    }
    if (maxLatencyMs !== undefined && !isFiniteNonNegative(maxLatencyMs)) {
        throw new RangeError("maxLatencyMs must be finite and non-negative")
    }
}

function isFiniteNonNegative(value: number): boolean {
    return Number.isFinite(value) && value >= 0
}

/** Locale-independent UTF-16 ordering, stable across supported runtimes. */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}
