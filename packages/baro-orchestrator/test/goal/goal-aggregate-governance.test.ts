import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import { GoalGuardian } from "../../src/goal/goal-guardian.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
    type GoalLedgerProjection,
} from "../../src/goal/goal-contract.js"
import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    GoalCompletionAttested,
    GoalCompletionCheckRequested,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    GoalLedgerProjectionUpdated,
    StoryMerged,
    StoryQualityCompleted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "../execution/helpers.js"

const envelope = {
    objective: "Keep cancellation lossless.",
    constraints: ["Preserve the public API."],
    acceptanceCriteria: ["All provider paths abort before returning."],
    nonGoals: [],
    assumptions: [],
} as const

describe("aggregate goal governance", () => {
    it("defers strict completion until a source-bound aggregate review passes", () => {
        const fixture = aggregateFixture("run-aggregate-goal")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-aggregate"),
        )
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)

        const completed = aggregateCompletion(request.payload, "passed")
        fixture.env.publish(source("forged-reviewer"), completed)
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)
        fixture.env.publish(
            fixture.reviewer,
            GoalAggregateReviewCompleted.create({
                ...completed.payload,
                verificationId: "forged-verification",
            }),
        )
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)

        fixture.env.publish(fixture.reviewer, completed)
        const attestation = fixture.env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.payload.status, "satisfied")
        assert.equal(
            attestation?.payload.invariants[0]?.aggregateReviewStatus,
            "passed",
        )
        assert.equal(
            fixture.env.events
                .filter(GoalLedgerProjectionUpdated.is)
                .at(-1)?.payload.projection.aggregateReviews.length,
            1,
        )
    })

    it("refreshes once when only independently-passing quality metadata changed", () => {
        const runId = "run-stale-aggregate"
        const contract = deriveGoalContract(envelope)!
        const board = source("board")
        const repository = source("repository")
        const acceptanceGate = source("acceptance-gate")
        const reviewer = source("goal-reviewer")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: [{
                storyId: "S1",
                invariantIds: contract.invariants.map(({ id }) => id),
            }],
            requireIndependentQuality: true,
            requireAggregateReview: true,
        })
        guardian.setRequestAuthority(board)
        guardian.setIntegrationAuthority(repository)
        guardian.setQualityAuthority(acceptanceGate)
        guardian.setAggregateReviewAuthority(reviewer)
        const env = joinWithCapture(guardian)
        env.publish(
            repository,
            StoryMerged.create({
                runId,
                storyId: "S1",
                leaseId: "lease-1",
                mode: "worktree",
            }),
        )
        env.publish(
            acceptanceGate,
            passedQuality(runId, "S1", "lease-1"),
        )
        env.publish(
            board,
            GoalCompletionCheckRequested.create({
                runId,
                checkId: "check-stale",
                contractId: contract.contractId,
                storyIds: ["S1"],
                verificationId: "check-stale:verification",
            }),
        )
        const request = env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)

        env.publish(
            acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(runId, "S1", "lease-1").payload,
                evaluationId: "S1:new-quality",
            }),
        )
        env.publish(
            reviewer,
            aggregateCompletion(request.payload, "passed"),
        )
        assert.equal(env.events.filter(GoalCompletionAttested.is).length, 0)
        const requests = env.events.filter(GoalAggregateReviewRequested.is)
        assert.equal(requests.length, 2)
        assert.notEqual(
            requests[1]!.payload.basis.fingerprint,
            requests[0]!.payload.basis.fingerprint,
        )
        assert.ok(requests[1]!.payload.goalRevision > requests[0]!.payload.goalRevision)

        env.publish(
            reviewer,
            aggregateCompletion(requests[1]!.payload, "passed"),
        )
        const attestation = env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.payload.status, "satisfied")
        assert.equal(
            env.events
                .filter(GoalLedgerProjectionUpdated.is)
                .at(-1)?.payload.projection.aggregateReviews.length,
            1,
        )
    })

    it("fails closed after a second quality-only basis change", () => {
        const fixture = singleStoryFixture("run-stale-twice")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-stale-twice"),
        )
        const first = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(first)
        fixture.env.publish(
            fixture.acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(fixture.runId, "S1", "lease-S1").payload,
                evaluationId: "quality-second",
            }),
        )
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(first.payload, "passed"),
        )
        const second = fixture.env.events
            .filter(GoalAggregateReviewRequested.is)
            .at(-1)
        assert.ok(second)
        fixture.env.publish(
            fixture.acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(fixture.runId, "S1", "lease-S1").payload,
                evaluationId: "quality-third",
            }),
        )
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(second.payload, "passed"),
        )
        assert.equal(
            fixture.env.events.find(GoalCompletionAttested.is)?.payload.status,
            "incomplete",
        )
        assert.equal(
            fixture.env.events.filter(GoalAggregateReviewRequested.is).length,
            2,
        )
    })

    it("does not reuse verification when the integrated lease changes", () => {
        const fixture = singleStoryFixture("run-stale-integration")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-stale-integration"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.publish(
            source("repository"),
            StoryMerged.create({
                runId: fixture.runId,
                storyId: "S1",
                leaseId: "lease-S1-new",
                mode: "worktree",
            }),
        )
        // The forged repository above is ignored; use the authority retained by
        // the fixture for the actual changed integration identity.
        fixture.env.publish(
            fixture.repository,
            StoryMerged.create({
                runId: fixture.runId,
                storyId: "S1",
                leaseId: "lease-S1-new",
                mode: "worktree",
            }),
        )
        fixture.env.publish(
            fixture.acceptanceGate,
            passedQuality(fixture.runId, "S1", "lease-S1-new"),
        )
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(request.payload, "passed"),
        )
        assert.equal(
            fixture.env.events.find(GoalCompletionAttested.is)?.payload.status,
            "incomplete",
        )
        assert.equal(
            fixture.env.events.filter(GoalAggregateReviewRequested.is).length,
            1,
        )
    })

    it("turns an aggregate semantic rejection into invariant-scoped remediation", () => {
        const fixture = aggregateFixture("run-aggregate-rejected")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-rejected"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(request.payload, "failed"),
        )

        assert.equal(
            fixture.env.events.some(GoalCompletionAttested.is),
            false,
            "actionable semantic failure reopens work instead of terminating completion",
        )
        const remediation = fixture.env.events.find(
            GoalInvariantRemediationProposed.is,
        )
        assert.ok(remediation)
        assert.equal(remediation.payload.invariantId, "G-A1")
        assert.deepEqual(remediation.payload.story.goalInvariantIds, ["G-A1"])
        assert.equal(
            remediation.payload.story.acceptance?.[0],
            `[G-A1] ${request.payload.basis.invariants[0]!.text}`,
        )
        assert.match(remediation.payload.reason, /run-level semantic review/i)
        assert.match(remediation.payload.reason, /does not prove the invariant/)
        assert.equal(
            fixture.env.events
                .filter(GoalLedgerProjectionUpdated.is)
                .at(-1)?.payload.projection.aggregateReviews.length,
            1,
        )
    })

    it("dispatches one story for a shared root cause and admits the challenge group atomically", () => {
        const fixture = singleStoryFixture("run-aggregate-grouped-remediation")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-grouped-remediation"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        const groupId = "goal-remediation-group-shared-root"
        const failed = aggregateCompletion(request.payload, "failed")
        fixture.env.publish(
            fixture.reviewer,
            GoalAggregateReviewCompleted.create({
                ...failed.payload,
                invariants: failed.payload.invariants.map((invariant) => ({
                    ...invariant,
                    remediationGroupId: groupId,
                })),
            }),
        )

        const proposals = fixture.env.events.filter(
            GoalInvariantRemediationProposed.is,
        )
        assert.equal(proposals.length, 1)
        const proposal = proposals[0]!
        assert.equal(proposal.payload.remediationGroupId, groupId)
        assert.deepEqual(proposal.payload.invariantIds, ["G-A1", "G-C1"])
        assert.equal(proposal.payload.challengeIds?.length, 2)
        assert.deepEqual(
            proposal.payload.story.goalInvariantIds,
            ["G-A1", "G-C1"],
        )

        fixture.env.publish(
            fixture.board,
            GoalInvariantRemediationAdmitted.create({
                runId: fixture.runId,
                contractId: fixture.contractId,
                challengeId: proposal.payload.challengeIds![0]!,
                challengeIds: [proposal.payload.challengeIds![0]!],
                invariantId: proposal.payload.invariantIds![0]!,
                invariantIds: [proposal.payload.invariantIds![0]!],
                remediationGroupId: groupId,
                proposalId: proposal.payload.proposalId,
                storyId: proposal.payload.story.id,
                graphVersion: 2,
                disposition: "applied",
            }),
        )
        let projection = fixture.env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)!.payload.projection
        assert.equal(
            projection.challenges.every(
                ({ remediation }) => remediation?.status === "requested",
            ),
            true,
            "a valid subset receipt admits none of the group",
        )

        fixture.env.publish(
            fixture.board,
            GoalInvariantRemediationAdmitted.create({
                runId: fixture.runId,
                contractId: fixture.contractId,
                challengeId: proposal.payload.challengeId,
                challengeIds: proposal.payload.challengeIds!,
                invariantId: "G-C1",
                invariantIds: ["G-C1", "G-A1"],
                remediationGroupId: groupId,
                proposalId: proposal.payload.proposalId,
                storyId: proposal.payload.story.id,
                graphVersion: 2,
                disposition: "applied",
            }),
        )
        projection = fixture.env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)!.payload.projection
        assert.equal(
            projection.challenges.every(
                ({ remediation }) => remediation?.status === "requested",
            ),
            true,
            "a misordered receipt admits none of the group",
        )

        fixture.env.publish(
            fixture.board,
            GoalInvariantRemediationAdmitted.create({
                runId: fixture.runId,
                contractId: fixture.contractId,
                challengeId: proposal.payload.challengeId,
                challengeIds: proposal.payload.challengeIds!,
                invariantId: proposal.payload.invariantId,
                invariantIds: proposal.payload.invariantIds!,
                remediationGroupId: groupId,
                proposalId: proposal.payload.proposalId,
                storyId: proposal.payload.story.id,
                graphVersion: 2,
                disposition: "applied",
            }),
        )
        projection = fixture.env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)!.payload.projection
        assert.equal(
            projection.challenges.every(
                ({ remediation }) =>
                    remediation?.status === "admitted" &&
                    remediation.storyId === proposal.payload.story.id,
            ),
            true,
        )
    })

    it("an inconclusive aggregate review completes on per-story evidence without coding remediation", () => {
        const fixture = aggregateFixture("run-aggregate-inconclusive")
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-inconclusive"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(request.payload, "inconclusive"),
        )

        assert.equal(
            fixture.env.events.some(GoalInvariantRemediationProposed.is),
            false,
        )
        const attestation = fixture.env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.payload.status, "satisfied")
        assert.deepEqual(attestation?.payload.openInvariantIds, [])
        assert.deepEqual(attestation?.payload.satisfiedInvariantIds, ["G-A1"])
        assert.match(attestation?.payload.reason ?? "", /inconclusive for 1 of them/)
    })

    it("bounds repeated semantic remediation and eventually returns the rejected attestation", () => {
        const contract = deriveGoalContract({
            objective: "Compose provider cancellation.",
            constraints: [],
            acceptanceCriteria: [
                "All four provider shards jointly preserve cooperative cancellation.",
            ],
            nonGoals: [],
            assumptions: [],
        })!
        const prior = new GoalInvariantLedger(contract)
        for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
            const challengeId = `aggregate-g-a1-prior-${ordinal}`
            prior.raiseChallenge({
                challengeId,
                invariantId: "G-A1",
                raisedBy: "goal-guardian",
                reason: `prior aggregate rejection ${ordinal}`,
            })
            prior.bindChallengeRemediation(challengeId, {
                proposalId: `aggregate-proposal-${ordinal}`,
                storyId: `GREM-prior-${ordinal}`,
                status: "requested",
            })
            prior.resolveChallenge({
                challengeId,
                resolution: "resolved",
                reason: `prior remediation ${ordinal} integrated`,
            })
        }
        const fixture = aggregateFixture(
            "run-aggregate-remediation-bounded",
            prior.snapshot(1),
        )
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-bounded"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(request.payload, "failed"),
        )

        assert.equal(
            fixture.env.events.some(GoalInvariantRemediationProposed.is),
            false,
        )
        const attestation = fixture.env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.payload.status, "incomplete")
        assert.deepEqual(attestation?.payload.rejectedInvariantIds, ["G-A1"])
    })

    it("does not let worker-controlled aggregate-like ids consume the remediation cap", () => {
        const contract = deriveGoalContract({
            objective: "Compose provider cancellation.",
            constraints: [],
            acceptanceCriteria: [
                "All four provider shards jointly preserve cooperative cancellation.",
            ],
            nonGoals: [],
            assumptions: [],
        })!
        const prior = new GoalInvariantLedger(contract)
        for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
            const challengeId = `aggregate-g-a1-worker-${ordinal}`
            prior.raiseChallenge({
                challengeId,
                invariantId: "G-A1",
                raisedBy: `worker-S${ordinal}`,
                reason: `worker-owned challenge ${ordinal}`,
            })
            prior.bindChallengeRemediation(challengeId, {
                proposalId: `worker-proposal-${ordinal}`,
                storyId: `GREM-worker-${ordinal}`,
                status: "requested",
            })
            prior.resolveChallenge({
                challengeId,
                resolution: "resolved",
                reason: `worker remediation ${ordinal} integrated`,
            })
        }
        const fixture = aggregateFixture(
            "run-aggregate-worker-prefix-spoof",
            prior.snapshot(1),
        )
        fixture.env.publish(
            fixture.board,
            completionRequest(fixture, "check-worker-prefix"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.publish(
            fixture.reviewer,
            aggregateCompletion(request.payload, "failed"),
        )

        const remediation = fixture.env.events.find(
            GoalInvariantRemediationProposed.is,
        )
        assert.ok(remediation)
        assert.equal(remediation.payload.invariantId, "G-A1")
        assert.match(remediation.payload.challengeId, /^aggregate-g-a1-/)
        assert.equal(fixture.env.events.some(GoalCompletionAttested.is), false)
    })
})

function aggregateFixture(
    runId: string,
    projection?: GoalLedgerProjection,
) {
    const goalEnvelope = {
        objective: "Compose provider cancellation.",
        constraints: [],
        acceptanceCriteria: [
            "All four provider shards jointly preserve cooperative cancellation.",
        ],
        nonGoals: [],
        assumptions: [],
    } as const
    const contract = deriveGoalContract(goalEnvelope)!
    const storyIds = ["S5", "S6", "S7", "S8"]
    const board = source("board")
    const repository = source("repository")
    const acceptanceGate = source("acceptance-gate")
    const reviewer = source("goal-reviewer")
    const guardian = new GoalGuardian({
        runId,
        goalEnvelope,
        storyMappings: storyIds.map((storyId) => ({
            storyId,
            invariantIds: ["G-A1"],
        })),
        requireIndependentQuality: true,
        requireAggregateReview: true,
        ...(projection ? { projection } : {}),
    })
    guardian.setRequestAuthority(board)
    guardian.setIntegrationAuthority(repository)
    guardian.setQualityAuthority(acceptanceGate)
    guardian.setAggregateReviewAuthority(reviewer)
    const env = joinWithCapture(guardian)
    for (const storyId of storyIds) {
        env.publish(
            acceptanceGate,
            passedQuality(runId, storyId, `lease-${storyId}`),
        )
        env.publish(
            repository,
            StoryMerged.create({
                runId,
                storyId,
                leaseId: `lease-${storyId}`,
                mode: "worktree",
            }),
        )
    }
    return {
        runId,
        contractId: contract.contractId,
        storyIds,
        board,
        reviewer,
        env,
    }
}

function singleStoryFixture(runId: string) {
    const contract = deriveGoalContract(envelope)!
    const board = source("board")
    const repository = source("repository")
    const acceptanceGate = source("acceptance-gate")
    const reviewer = source("goal-reviewer")
    const guardian = new GoalGuardian({
        runId,
        goalEnvelope: envelope,
        storyMappings: [{
            storyId: "S1",
            invariantIds: contract.invariants.map(({ id }) => id),
        }],
        requireIndependentQuality: true,
        requireAggregateReview: true,
    })
    guardian.setRequestAuthority(board)
    guardian.setIntegrationAuthority(repository)
    guardian.setQualityAuthority(acceptanceGate)
    guardian.setAggregateReviewAuthority(reviewer)
    const env = joinWithCapture(guardian)
    env.publish(
        repository,
        StoryMerged.create({
            runId,
            storyId: "S1",
            leaseId: "lease-S1",
            mode: "worktree",
        }),
    )
    env.publish(
        acceptanceGate,
        passedQuality(runId, "S1", "lease-S1"),
    )
    return {
        runId,
        contractId: contract.contractId,
        storyIds: ["S1"],
        board,
        repository,
        acceptanceGate,
        reviewer,
        env,
    }
}

function completionRequest(
    fixture: ReturnType<typeof aggregateFixture>,
    checkId: string,
) {
    return GoalCompletionCheckRequested.create({
        runId: fixture.runId,
        checkId,
        contractId: fixture.contractId,
        storyIds: fixture.storyIds,
        verificationId: `${checkId}:verification`,
    })
}

function aggregateCompletion(
    request: ReturnType<typeof GoalAggregateReviewRequested.create>["payload"],
    status: "passed" | "failed" | "inconclusive",
) {
    return GoalAggregateReviewCompleted.create({
        runId: request.runId,
        checkId: request.checkId,
        contractId: request.basis.contractId,
        goalRevision: request.goalRevision,
        reviewId: request.reviewId,
        basisFingerprint: request.basis.fingerprint,
        verificationId: request.basis.verificationId,
        repositoryFingerprint: "a".repeat(64),
        status,
        attempts: 1,
        modelUsed: "fake-goal-reviewer",
        invariants: request.basis.invariants.map(({ invariantId }) => ({
            invariantId,
            status,
            reason: status === "passed"
                ? "the full merged run satisfies the invariant"
                : "the full merged run does not prove the invariant",
        })),
    })
}

function passedQuality(runId: string, storyId: string, leaseId: string) {
    return StoryQualityCompleted.create({
        runId,
        evaluationId: `${storyId}:quality`,
        storyId,
        leaseId,
        generation: 1,
        status: "passed",
        targetTurn: 1,
        reason: "independent Critic passed",
        critique: {
            status: "evaluated",
            verdict: "pass",
            reasoning: "criteria are satisfied",
            violatedCriteria: [],
            turn: 1,
            modelUsed: "critic-model",
        },
    })
}
