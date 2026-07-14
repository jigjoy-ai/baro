import type {
    Metric,
    ModelInvocationMeasuredData,
} from "../model-telemetry.js"
import type {
    WorkBidEstimateData,
    WorkLeaseReleasedData,
} from "../semantic-events.js"

export interface RouteLearningSnapshot {
    verifiedSuccesses: number
    workFailures: number
    observations: number
    estimate: WorkBidEstimateData
}

/**
 * Stateful estimator for one configured worker route.
 *
 * Bus authority and run/story correlation remain StoryFactory concerns. This
 * class only owns the observations that survive between auctions: elapsed
 * lease time, one preferred cost per invocation, and the Bayesian priors used
 * to turn those observations into the next advisory bid.
 */
export class RouteLearner {
    private readonly leaseStartedAt = new Map<string, number>()
    private readonly leaseCosts = new Map<string, {
        storyId: string
        completed: boolean
        appliedCost?: number
        invocations: Map<
            string,
            { value: number; priority: number; usable: boolean }
        >
    }>()
    private readonly learning = {
        verifiedSuccesses: 0,
        workFailures: 0,
        observations: 0,
        totalCostUsd: 0,
        costObservations: 0,
        totalLatencyMs: 0,
        latencyObservations: 0,
    }

    constructor(private readonly configured: WorkBidEstimateData) {}

    beginLease(
        leaseId: string,
        storyId: string,
        startedAt = Date.now(),
    ): void {
        this.leaseStartedAt.set(leaseId, startedAt)
        const existing = this.leaseCosts.get(leaseId)
        if (existing && existing.storyId !== storyId) {
            throw new Error(`route learner lease ${leaseId} changed stories`)
        }
        if (!existing) {
            this.leaseCosts.set(leaseId, {
                storyId,
                completed: false,
                invocations: new Map(),
            })
        }
    }

    observeInvocation(
        leaseId: string,
        data: ModelInvocationMeasuredData,
    ): RouteLearningSnapshot | null {
        const cost = preferredKnownCost(data)
        const ledger = this.leaseCosts.get(leaseId)
        if (!cost || !ledger || ledger.storyId !== data.storyId) return null
        const previous = ledger.invocations.get(data.invocationId)
        let changed = false
        if (!previous || cost.priority > previous.priority) {
            ledger.invocations.set(data.invocationId, {
                ...cost,
                usable: true,
            })
            changed = true
        } else if (
            cost.priority === previous.priority &&
            previous.usable &&
            cost.value !== previous.value
        ) {
            // Equal-authority disagreement is not a price observation. This
            // mirrors reduceModelTelemetry instead of keeping whichever
            // event happened to arrive first.
            ledger.invocations.set(data.invocationId, {
                value: 0,
                priority: cost.priority,
                usable: false,
            })
            changed = true
        }
        if (!changed || !ledger.completed || !this.applyLedgerCost(ledger)) {
            return null
        }
        return this.snapshot()
    }

    completeLease(
        storyId: string,
        leaseId: string,
        reason: WorkLeaseReleasedData["reason"],
        finishedAt?: number,
    ): RouteLearningSnapshot {
        const startedAt = this.leaseStartedAt.get(leaseId)
        if (startedAt !== undefined) {
            this.learning.totalLatencyMs += Math.max(
                0,
                (finishedAt ?? Date.now()) - startedAt,
            )
            this.learning.latencyObservations += 1
        }
        const ledger = this.leaseCosts.get(leaseId)
        if (ledger && ledger.storyId === storyId) {
            ledger.completed = true
            this.applyLedgerCost(ledger)
        }
        if (reason === "integrated") this.learning.verifiedSuccesses += 1
        else if (reason === "execution_failed" || reason === "quality_failed") {
            this.learning.workFailures += 1
        }
        this.learning.observations += 1

        return this.snapshot()
    }

    forgetLease(storyId: string, leaseId: string): void {
        this.leaseStartedAt.delete(leaseId)
        const ledger = this.leaseCosts.get(leaseId)
        if (ledger && ledger.storyId !== storyId) {
            throw new Error(`route learner lease ${leaseId} changed stories`)
        }
    }

    currentEstimate(): WorkBidEstimateData {
        const qualityObservations =
            this.learning.verifiedSuccesses + this.learning.workFailures
        const qualityPrior = 4
        const costPrior = 2
        const latencyPrior = 2
        return {
            expectedCostUsd:
                this.learning.costObservations > 0
                    ? (this.configured.expectedCostUsd * costPrior +
                          this.learning.totalCostUsd) /
                      (costPrior + this.learning.costObservations)
                    : this.configured.expectedCostUsd,
            estimatedSuccessProbability:
                qualityObservations > 0
                    ? (this.configured.estimatedSuccessProbability *
                          qualityPrior +
                          this.learning.verifiedSuccesses) /
                      (qualityPrior + qualityObservations)
                    : this.configured.estimatedSuccessProbability,
            estimatedLatencyMs:
                this.learning.latencyObservations > 0
                    ? (this.configured.estimatedLatencyMs * latencyPrior +
                          this.learning.totalLatencyMs) /
                      (latencyPrior + this.learning.latencyObservations)
                    : this.configured.estimatedLatencyMs,
            estimateSource:
                this.learning.observations > 0
                    ? "historical"
                    : this.configured.estimateSource,
        }
    }

    /** Clear run-local in-flight observations without discarding history. */
    clearPending(): void {
        this.leaseStartedAt.clear()
        this.leaseCosts.clear()
    }

    private applyLedgerCost(ledger: {
        appliedCost?: number
        invocations: Map<
            string,
            { value: number; priority: number; usable: boolean }
        >
    }): boolean {
        const usable = [...ledger.invocations.values()].filter(
            (item) => item.usable,
        )
        if (usable.length === 0) {
            if (ledger.appliedCost === undefined) return false
            this.learning.totalCostUsd = Math.max(
                0,
                this.learning.totalCostUsd - ledger.appliedCost,
            )
            this.learning.costObservations = Math.max(
                0,
                this.learning.costObservations - 1,
            )
            delete ledger.appliedCost
            return true
        }
        const total = usable.reduce((sum, item) => sum + item.value, 0)
        if (ledger.appliedCost === undefined) {
            this.learning.totalCostUsd += total
            this.learning.costObservations += 1
            ledger.appliedCost = total
            return true
        }
        if (ledger.appliedCost === total) return false
        this.learning.totalCostUsd = Math.max(
            0,
            this.learning.totalCostUsd + total - ledger.appliedCost,
        )
        ledger.appliedCost = total
        return true
    }

    private snapshot(): RouteLearningSnapshot {
        return {
            verifiedSuccesses: this.learning.verifiedSuccesses,
            workFailures: this.learning.workFailures,
            observations: this.learning.observations,
            estimate: this.currentEstimate(),
        }
    }
}

function preferredKnownCost(
    data: ModelInvocationMeasuredData,
): { value: number; priority: number } | null {
    const producerPriority =
        data.evidence.producer === "cloud"
            ? 30
            : data.evidence.producer === "gateway"
              ? 20
              : 10
    return (
        knownCost(data.cost.customerUsd, 300 + producerPriority) ??
        knownCost(data.cost.providerUsd, 200 + producerPriority) ??
        knownCost(data.cost.equivalentUsd, 100 + producerPriority)
    )
}

function knownCost(
    metric: Metric,
    priority: number,
): { value: number; priority: number } | null {
    return metric.state === "known"
        ? { value: metric.value, priority }
        : null
}
