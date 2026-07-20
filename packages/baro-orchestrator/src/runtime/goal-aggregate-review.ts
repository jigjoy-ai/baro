import { createHash } from "node:crypto"

export type GoalAggregateReviewStatus = "passed" | "failed" | "inconclusive"
export type GoalAggregateProtocolIssueScope =
    | "mapping"
    | "challenge"
    | "aggregate_review"

export interface GoalAggregateInvariantReview {
    invariantId: string
    status: GoalAggregateReviewStatus
    reason: string
}

export interface GoalAggregateReviewEvidence {
    reviewId: string
    basisFingerprint: string
    verificationId: string
    /** Exact bounded repository delta evaluated by this review, or null before capture. */
    repositoryFingerprint: string | null
    status: GoalAggregateReviewStatus
    attempts: number
    modelUsed: string
    invariants: readonly GoalAggregateInvariantReview[]
}

export interface GoalAggregateInvariantBasis {
    invariantId: string
    text: string
    mappedStoryIds: readonly string[]
    contributions: readonly {
        storyId: string
        leaseId?: string
        evaluationId?: string
        qualityStatus?: GoalAggregateReviewStatus
        independentlyPassed: boolean
    }[]
}

export interface GoalAggregateChallengeBasis {
    challengeId: string
    invariantId: string
    raisedBy: string
    reason: string
    storyId?: string
    resolution?: {
        /** Present on GoalInvariantLedger records; retained for lossless review evidence. */
        challengeId?: string
        resolution: "resolved" | "rejected"
        reason: string
    }
    remediation?: {
        proposalId: string
        storyId: string
        status: "requested" | "admitted"
        graphVersion?: number
        revalidates?: readonly { storyId: string; leaseId?: string }[]
    }
}

export interface GoalAggregateReviewBasis {
    fingerprint: string
    contractId: string
    objective: string
    nonGoals: readonly string[]
    assumptions: readonly string[]
    verificationId: string
    storyIds: readonly string[]
    invariants: readonly GoalAggregateInvariantBasis[]
    challenges: readonly GoalAggregateChallengeBasis[]
    protocolIssues: readonly {
        scope: GoalAggregateProtocolIssueScope
        key: string
        reason: string
    }[]
}

export type GoalAggregateReviewBasisInput = Omit<
    GoalAggregateReviewBasis,
    "fingerprint"
>

export function createGoalAggregateReviewBasis(
    input: GoalAggregateReviewBasisInput,
): GoalAggregateReviewBasis {
    const content = structuredClone(input)
    const fingerprint = createHash("sha256")
        .update("baro-goal-aggregate-review-v1\0")
        .update(JSON.stringify(content))
        .digest("hex")
    return deepFreeze({ fingerprint, ...content })
}

/**
 * Identity of repository-affecting aggregate facts. Quality verdict metadata
 * is deliberately excluded so Guardian may refresh once when only an
 * independently-passing evaluation was superseded. Any contract, story,
 * integration lease, challenge/remediation, or protocol change requires a new
 * run-verification cycle instead of reusing the old verificationId.
 */
export function goalAggregateStableBasisFingerprint(
    basis: GoalAggregateReviewBasis,
): string {
    const stable = {
        contractId: basis.contractId,
        objective: basis.objective,
        nonGoals: basis.nonGoals,
        assumptions: basis.assumptions,
        verificationId: basis.verificationId,
        storyIds: basis.storyIds,
        invariants: basis.invariants.map((invariant) => ({
            invariantId: invariant.invariantId,
            text: invariant.text,
            mappedStoryIds: invariant.mappedStoryIds,
            contributions: invariant.contributions.map((contribution) => ({
                storyId: contribution.storyId,
                ...(contribution.leaseId
                    ? { leaseId: contribution.leaseId }
                    : {}),
            })),
        })),
        challenges: basis.challenges,
        protocolIssues: basis.protocolIssues,
    }
    return createHash("sha256")
        .update("baro-goal-aggregate-stable-basis-v1\0")
        .update(JSON.stringify(stable))
        .digest("hex")
}

export function normalizeGoalAggregateReviewEvidence(
    value: unknown,
    knownInvariantIds: ReadonlySet<string> | null,
): GoalAggregateReviewEvidence {
    if (
        !plainRecord(value) ||
        !boundedString(value.reviewId, 256) ||
        !boundedString(value.basisFingerprint, 128) ||
        !boundedString(value.verificationId, 256) ||
        !repositoryFingerprint(value.repositoryFingerprint) ||
        !reviewStatus(value.status) ||
        !Number.isSafeInteger(value.attempts) ||
        Number(value.attempts) < 0 ||
        Number(value.attempts) > 4 ||
        !boundedString(value.modelUsed, 256) ||
        !Array.isArray(value.invariants)
    ) throw new Error("aggregate review evidence is malformed")

    const invariants = value.invariants.map((item) => {
        if (
            !plainRecord(item) ||
            !boundedString(item.invariantId, 128) ||
            !reviewStatus(item.status) ||
            !boundedString(item.reason, 2_000) ||
            (knownInvariantIds && !knownInvariantIds.has(item.invariantId))
        ) throw new Error("aggregate invariant review is malformed")
        return {
            invariantId: item.invariantId,
            status: item.status,
            reason: item.reason,
        } as GoalAggregateInvariantReview
    })
    assertUnique(invariants.map(({ invariantId }) => invariantId))
    if (
        knownInvariantIds &&
        (invariants.length !== knownInvariantIds.size ||
            invariants.some(({ invariantId }) =>
                !knownInvariantIds.has(invariantId)))
    ) throw new Error("aggregate review does not cover the complete contract")

    const expected = aggregateReviewStatus(invariants)
    if (value.status !== expected) {
        throw new Error("aggregate review summary conflicts with invariant verdicts")
    }
    if (value.status === "passed" && value.repositoryFingerprint === null) {
        throw new Error("a passing aggregate review has no repository fingerprint")
    }
    return deepFreeze({
        reviewId: value.reviewId,
        basisFingerprint: value.basisFingerprint,
        verificationId: value.verificationId,
        repositoryFingerprint: value.repositoryFingerprint,
        status: value.status,
        attempts: Number(value.attempts),
        modelUsed: value.modelUsed,
        invariants,
    })
}

function repositoryFingerprint(value: unknown): value is string | null {
    return value === null ||
        (typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
}

export function aggregateReviewStatus(
    invariants: readonly GoalAggregateInvariantReview[],
): GoalAggregateReviewStatus {
    return invariants.some(({ status }) => status === "failed")
        ? "failed"
        : invariants.some(({ status }) => status === "inconclusive")
        ? "inconclusive"
        : "passed"
}

function reviewStatus(value: unknown): value is GoalAggregateReviewStatus {
    return value === "passed" || value === "failed" || value === "inconclusive"
}

function assertUnique(values: readonly string[]): void {
    if (new Set(values).size !== values.length) {
        throw new Error("aggregate invariant review ids must be unique")
    }
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function boundedString(value: unknown, maxLength: number): value is string {
    return nonBlank(value) && value.length <= maxLength
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested)
        }
    }
    return value
}
