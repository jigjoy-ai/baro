import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createGoalAggregateReviewBasis,
    normalizeGoalAggregateReviewEvidence,
} from "../../src/runtime/goal-aggregate-review.js"

const repositoryFingerprint = "a".repeat(64)

describe("goal aggregate review contract", () => {
    it("fingerprints the full remediation witness identity", () => {
        const base = {
            contractId: "goal:a8",
            objective: "Compose provider cancellation.",
            nonGoals: [],
            assumptions: [],
            verificationId: "verification-a8",
            storyIds: ["S5"],
            invariants: [{
                invariantId: "G-A1",
                text: "Every provider composes.",
                mappedStoryIds: ["S5"],
                contributions: [{
                    storyId: "S5",
                    leaseId: "lease-S5",
                    evaluationId: "quality-S5",
                    qualityStatus: "passed" as const,
                    independentlyPassed: true,
                }],
            }],
            protocolIssues: [],
        }
        const first = createGoalAggregateReviewBasis({
            ...base,
            challenges: [{
                challengeId: "challenge-1",
                invariantId: "G-A1",
                raisedBy: "goal-guardian",
                reason: "revalidate a restored contribution",
                resolution: { resolution: "resolved" as const, reason: "reviewed" },
                remediation: {
                    proposalId: "proposal-1",
                    storyId: "GREM-1",
                    status: "admitted" as const,
                    graphVersion: 2,
                    revalidates: [{ storyId: "S5", leaseId: "lease-old" }],
                },
            }],
        })
        const changedWitness = createGoalAggregateReviewBasis({
            ...base,
            challenges: [{
                ...first.challenges[0]!,
                remediation: {
                    ...first.challenges[0]!.remediation!,
                    revalidates: [{ storyId: "S5", leaseId: "lease-new" }],
                },
            }],
        })
        assert.notEqual(first.fingerprint, changedWitness.fingerprint)
    })

    it("normalizes only complete, internally consistent invariant verdicts", () => {
        const known = new Set(["G-A1", "G-C1"])
        const value = {
            reviewId: "review-1",
            basisFingerprint: "basis-1",
            verificationId: "verification-1",
            repositoryFingerprint,
            status: "failed" as const,
            attempts: 1,
            modelUsed: "fake",
            invariants: [
                { invariantId: "G-A1", status: "passed" as const, reason: "ok" },
                { invariantId: "G-C1", status: "failed" as const, reason: "bad" },
            ],
        }
        assert.deepEqual(
            normalizeGoalAggregateReviewEvidence(value, known),
            value,
        )
        assert.throws(
            () => normalizeGoalAggregateReviewEvidence({
                ...value,
                status: "passed",
            }, known),
            /summary conflicts/,
        )
        assert.throws(
            () => normalizeGoalAggregateReviewEvidence({
                ...value,
                invariants: value.invariants.slice(0, 1),
            }, known),
            /complete contract/,
        )
        for (const malformed of [undefined, "not-a-sha256"]) {
            assert.throws(
                () => normalizeGoalAggregateReviewEvidence({
                    ...value,
                    repositoryFingerprint: malformed,
                }, known),
                /malformed/,
            )
        }
        assert.throws(
            () => normalizeGoalAggregateReviewEvidence({
                ...value,
                repositoryFingerprint: null,
                status: "passed",
                invariants: value.invariants.map((invariant) => ({
                    ...invariant,
                    status: "passed",
                })),
            }, known),
            /no repository fingerprint/,
        )
    })
})
