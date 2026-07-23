/** GoalGuardian semantic goal contract: invariants, ledger, attestation. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"
import type {
    GoalAggregateReviewBasis,
    GoalAggregateReviewEvidence,
} from "../runtime/goal-aggregate-review.js"
import type { ReplanStoryAdd } from "./runtime-graph.js"

// Goal-contract governance

/**
 * The coordinator's accepted story-to-goal coverage declaration.  This is a
 * projection input, not proof that the story has been integrated or reviewed.
 */
export interface GoalStoryInvariantMappedData {
    runId: string
    mappingId: string
    storyId: string
    invariantIds: readonly string[]
}

export const GoalStoryInvariantMapped =
    defineSemanticEvent<GoalStoryInvariantMappedData>(
        "goal_story_invariant_mapped",
    )

/** Any joined collective participant may fail closed by challenging a goal invariant. */
export interface GoalInvariantChallengeRaisedData {
    runId: string
    challengeId: string
    invariantId: string
    raisedBy: string
    reason: string
    storyId?: string
}

export const GoalInvariantChallengeRaised =
    defineSemanticEvent<GoalInvariantChallengeRaisedData>(
        "goal_invariant_challenge_raised",
    )

/** Only the bound goal-governance authority may settle a challenge. */
export interface GoalInvariantChallengeResolvedData {
    runId: string
    challengeId: string
    /** `resolved` clears the challenge; `rejected` records an upheld failure. */
    resolution: "resolved" | "rejected"
    reason: string
}

export const GoalInvariantChallengeResolved =
    defineSemanticEvent<GoalInvariantChallengeResolvedData>(
        "goal_invariant_challenge_resolved",
    )

/** Guardian-authored add-only work proposal for an unresolved invariant. */
export interface GoalInvariantRemediationProposedData {
    runId: string
    contractId: string
    /** Canonical first target retained for legacy consumers. */
    challengeId: string
    /** Complete root-cause group. Missing means the legacy singleton above. */
    challengeIds?: readonly string[]
    /** Canonical first target retained for legacy consumers. */
    invariantId: string
    /** Complete invariant target set. Missing means the legacy singleton above. */
    invariantIds?: readonly string[]
    /** Reviewer-derived root-cause identity, when aggregate review grouped it. */
    remediationGroupId?: string
    proposalId: string
    reason: string
    story: ReplanStoryAdd
}

export const GoalInvariantRemediationProposed =
    defineSemanticEvent<GoalInvariantRemediationProposedData>(
        "goal_invariant_remediation_proposed",
    )

/** Board's durable graph admission receipt for Guardian remediation work. */
export interface GoalInvariantRemediationAdmittedData {
    runId: string
    contractId: string
    /** Canonical first target retained for legacy consumers. */
    challengeId: string
    /** Atomically admitted challenge set; missing means legacy singleton. */
    challengeIds?: readonly string[]
    /** Canonical first target retained for legacy consumers. */
    invariantId: string
    /** Exact story target set; missing means legacy singleton. */
    invariantIds?: readonly string[]
    remediationGroupId?: string
    proposalId: string
    storyId: string
    graphVersion: number
    disposition: "applied" | "existing"
}

export const GoalInvariantRemediationAdmitted =
    defineSemanticEvent<GoalInvariantRemediationAdmittedData>(
        "goal_invariant_remediation_admitted",
    )

/**
 * Guardian-owned complete ledger snapshot.  The coordinator may persist this
 * projection, but cannot manufacture or edit its semantic contents.
 */
export interface GoalLedgerProjectionUpdatedData {
    runId: string
    contractId: string
    revision: number
    projection: import("../runtime/goal-contract.js").GoalLedgerProjection
}

export const GoalLedgerProjectionUpdated =
    defineSemanticEvent<GoalLedgerProjectionUpdatedData>(
        "goal_ledger_projection_updated",
    )

/**
 * Board-authored receipt emitted only after the exact Guardian projection has
 * crossed the atomic PRD persistence boundary. Consumers may use this to
 * retire durable transport records; ProjectionUpdated alone is not an ack.
 */
export interface GoalLedgerProjectionPersistedData
    extends GoalLedgerProjectionUpdatedData {}

export const GoalLedgerProjectionPersisted =
    defineSemanticEvent<GoalLedgerProjectionPersistedData>(
        "goal_ledger_projection_persisted",
    )

/**
 * Authority-bound request to attest the event-projected goal ledger.  The
 * caller supplies the exact integrated story set so removed/stale work cannot
 * satisfy a later DAG projection.
 */
export interface GoalCompletionCheckRequestedData {
    runId: string
    checkId: string
    contractId: string | null
    storyIds: readonly string[]
    verificationId: string
}

export const GoalCompletionCheckRequested =
    defineSemanticEvent<GoalCompletionCheckRequestedData>(
        "goal_completion_check_requested",
    )

/** Guardian-authored request for one semantic review of the exact run basis. */
export interface GoalAggregateReviewRequestedData {
    runId: string
    reviewId: string
    checkId: string
    goalRevision: number
    basis: GoalAggregateReviewBasis
}

export const GoalAggregateReviewRequested =
    defineSemanticEvent<GoalAggregateReviewRequestedData>(
        "goal_aggregate_review_requested",
    )

/** Read-only review evidence correlated to the immutable requested basis. */
export interface GoalAggregateReviewCompletedData
    extends GoalAggregateReviewEvidence {
    runId: string
    checkId: string
    contractId: string
    goalRevision: number
}

export const GoalAggregateReviewCompleted =
    defineSemanticEvent<GoalAggregateReviewCompletedData>(
        "goal_aggregate_review_completed",
    )

export type GoalInvariantAttestationStatus =
    | "satisfied"
    | "open"
    | "rejected"

export interface GoalInvariantAttestationEvidence {
    invariantId: string
    status: GoalInvariantAttestationStatus
    mappedStoryIds: readonly string[]
    integratedStoryIds: readonly string[]
    independentlyReviewedStoryIds: readonly string[]
    aggregateReviewId?: string
    aggregateReviewStatus?: import("../runtime/goal-aggregate-review.js").GoalAggregateReviewStatus
    reason: string
}

/** GoalGuardian's correlated, replay-safe completion decision. */
export interface GoalCompletionAttestedData {
    runId: string
    checkId: string
    contractId: string | null
    /** Exact Guardian projection revision from which this decision was derived. */
    goalRevision: number | null
    verificationId: string
    status: "satisfied" | "incomplete" | "disabled"
    satisfiedInvariantIds: readonly string[]
    openInvariantIds: readonly string[]
    rejectedInvariantIds: readonly string[]
    invariants: readonly GoalInvariantAttestationEvidence[]
    reason: string
}

export const GoalCompletionAttested =
    defineSemanticEvent<GoalCompletionAttestedData>(
        "goal_completion_attested",
    )
