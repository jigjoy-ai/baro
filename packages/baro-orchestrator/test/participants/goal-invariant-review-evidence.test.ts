import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    GOAL_REVIEW_MAX_BASIS_AND_VERIFICATION_CHARS,
    normalizeGoalInvariantReviewBasisEvidence,
} from "../../src/participants/goal-invariant-review-evidence.js"
import { createGoalAggregateReviewBasis } from "../../src/runtime/goal-aggregate-review.js"

describe("goal invariant review evidence", () => {
    it("deduplicates repeated contributions without changing or losing protocol basis fields", () => {
        const shared = {
            storyId: "S1",
            leaseId: "lease-S1",
            evaluationId: "quality-S1",
            qualityStatus: "passed" as const,
            independentlyPassed: true,
        }
        const distinct = {
            ...shared,
            evaluationId: "quality-S1-recheck",
        }
        const basis = createGoalAggregateReviewBasis({
            contractId: "goal:normalized-evidence",
            objective: "Review the complete merged result.",
            nonGoals: ["Do not omit evidence."],
            assumptions: ["Story evidence is source-bound."],
            verificationId: "verification-1",
            storyIds: ["S1"],
            invariants: [
                {
                    invariantId: "G-A1",
                    text: "The merged behavior is correct.",
                    mappedStoryIds: ["S1"],
                    contributions: [shared],
                },
                {
                    invariantId: "G-C1",
                    text: "Every review remains independently sourced.",
                    mappedStoryIds: ["S1"],
                    contributions: [shared, distinct],
                },
            ],
            challenges: [{
                challengeId: "challenge-1",
                invariantId: "G-C1",
                raisedBy: "worker-S1",
                reason: "Recheck the exact quality receipt.",
            }],
            protocolIssues: [{
                scope: "mapping",
                key: "mapping-1",
                reason: "Preserve this exact protocol issue.",
            }],
        })
        const originalFingerprint = basis.fingerprint

        const normalized = normalizeGoalInvariantReviewBasisEvidence(basis)

        assert.equal(normalized.fingerprint, originalFingerprint)
        assert.equal(basis.fingerprint, originalFingerprint)
        assert.equal(normalized.contributionTable.length, 2)
        assert.deepEqual(normalized.invariants[0]!.contributionRefs, [0])
        assert.deepEqual(normalized.invariants[1]!.contributionRefs, [0, 1])

        assert.deepEqual(reconstructNormalizedBasis(normalized), basis)
    })

    it("keeps a maximal 64-invariant three-cycle shared review history lossless and within budget", () => {
        const invariantIds = Array.from({ length: 64 }, (_, index) =>
            index < 32 ? `G-A${index + 1}` : `G-C${index - 31}`)
        const sharedContribution = {
            storyId: "S-root",
            leaseId: "lease-root",
            evaluationId: "quality-root",
            qualityStatus: "passed" as const,
            independentlyPassed: true,
        }
        const reasoning = "R".repeat(2_000)
        const challenges = [1, 2, 3].flatMap((cycle) =>
            invariantIds.map((invariantId) => ({
                challengeId:
                    `aggregate-${invariantId.toLowerCase()}-cycle-${cycle}`,
                invariantId,
                raisedBy: "goal-guardian",
                reason:
                    `Run-level semantic review goal-review:cycle-${cycle} ` +
                    `rejected the invariant: ${reasoning}`,
                resolution: {
                    challengeId:
                        `aggregate-${invariantId.toLowerCase()}-cycle-${cycle}`,
                    resolution: "resolved" as const,
                    reason: "remediation integrated with an independent passing critique",
                },
                remediation: {
                    proposalId: `proposal-${cycle}-${invariantId}`,
                    storyId: `GREM-${cycle}-${invariantId}`,
                    status: "admitted" as const,
                    graphVersion: cycle,
                },
            })))
        const basis = createGoalAggregateReviewBasis({
            contractId: "goal:maximal-review-history",
            objective: "Review the complete merged result.",
            nonGoals: [],
            assumptions: [],
            verificationId: "verification-maximal",
            storyIds: ["S-root"],
            invariants: invariantIds.map((invariantId) => ({
                invariantId,
                text: "T".repeat(2_000),
                mappedStoryIds: ["S-root"],
                contributions: [sharedContribution],
            })),
            challenges,
            protocolIssues: [],
        })

        const normalized = normalizeGoalInvariantReviewBasisEvidence(basis)
        const encoded = JSON.stringify(normalized)
        const verificationEvidence = JSON.stringify({
            verificationId: "verification-maximal",
            status: "passed",
            commands: [{
                command: "npm test",
                status: "passed",
                durationMs: 1,
                tail: "V".repeat(2_000),
            }],
            durationMs: 1,
        })

        assert.ok(
            encoded.length + verificationEvidence.length <
                GOAL_REVIEW_MAX_BASIS_AND_VERIFICATION_CHARS,
            `normalized basis and verification used ${
                encoded.length + verificationEvidence.length
            } chars`,
        )
        assert.equal(normalized.reasonTable.length, 4)
        assert.deepEqual(reconstructNormalizedBasis(normalized), basis)
    })
})

type NormalizedBasis = ReturnType<
    typeof normalizeGoalInvariantReviewBasisEvidence
>

function reconstructNormalizedBasis(normalized: NormalizedBasis) {
    const {
        encoding: _encoding,
        contributionTable,
        reasonTable,
        invariants,
        challenges,
        ...topLevel
    } = normalized
    return {
        ...topLevel,
        invariants: invariants.map(({ contributionRefs, ...invariant }) => ({
            ...invariant,
            contributions: contributionRefs.map((reference) => {
                const contribution = contributionTable[reference]
                assert.ok(contribution)
                return contribution
            }),
        })),
        challenges: challenges.map((challenge) => {
            const { reasonRef, resolution, ...rest } = challenge
            const reason = reasonTable[reasonRef]
            assert.ok(reason)
            return {
                ...rest,
                reason,
                ...(resolution
                    ? {
                          resolution: {
                              ...withoutReasonRef(resolution),
                              reason: reasonTable[resolution.reasonRef],
                          },
                      }
                    : {}),
            }
        }),
    }
}

function withoutReasonRef<T extends { reasonRef: number }>(
    value: T,
): Omit<T, "reasonRef"> {
    const { reasonRef: _reasonRef, ...rest } = value
    return rest
}
