import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GoalGuardian } from "../../src/participants/goal-guardian.js"
import { deriveGoalContract } from "../../src/runtime/goal-contract.js"
import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    GoalCompletionAttested,
    GoalCompletionCheckRequested,
    GoalLedgerProjectionUpdated,
    StoryMerged,
    StoryQualityCompleted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

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
        fixture.env.deliverSemanticEvent(
            fixture.board,
            completionRequest(fixture, "check-aggregate"),
        )
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)

        const completed = aggregateCompletion(request.data, "passed")
        fixture.env.deliverSemanticEvent(source("forged-reviewer"), completed)
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)
        fixture.env.deliverSemanticEvent(
            fixture.reviewer,
            GoalAggregateReviewCompleted.create({
                ...completed.data,
                verificationId: "forged-verification",
            }),
        )
        assert.equal(fixture.env.events.filter(GoalCompletionAttested.is).length, 0)

        fixture.env.deliverSemanticEvent(fixture.reviewer, completed)
        const attestation = fixture.env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.data.status, "satisfied")
        assert.equal(
            attestation?.data.invariants[0]?.aggregateReviewStatus,
            "passed",
        )
        assert.equal(
            fixture.env.events
                .filter(GoalLedgerProjectionUpdated.is)
                .at(-1)?.data.projection.aggregateReviews.length,
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
        env.deliverSemanticEvent(
            repository,
            StoryMerged.create({
                runId,
                storyId: "S1",
                leaseId: "lease-1",
                mode: "worktree",
            }),
        )
        env.deliverSemanticEvent(
            acceptanceGate,
            passedQuality(runId, "S1", "lease-1"),
        )
        env.deliverSemanticEvent(
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

        env.deliverSemanticEvent(
            acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(runId, "S1", "lease-1").data,
                evaluationId: "S1:new-quality",
            }),
        )
        env.deliverSemanticEvent(
            reviewer,
            aggregateCompletion(request.data, "passed"),
        )
        assert.equal(env.events.filter(GoalCompletionAttested.is).length, 0)
        const requests = env.events.filter(GoalAggregateReviewRequested.is)
        assert.equal(requests.length, 2)
        assert.notEqual(
            requests[1]!.data.basis.fingerprint,
            requests[0]!.data.basis.fingerprint,
        )
        assert.ok(requests[1]!.data.goalRevision > requests[0]!.data.goalRevision)

        env.deliverSemanticEvent(
            reviewer,
            aggregateCompletion(requests[1]!.data, "passed"),
        )
        const attestation = env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.data.status, "satisfied")
        assert.equal(
            env.events
                .filter(GoalLedgerProjectionUpdated.is)
                .at(-1)?.data.projection.aggregateReviews.length,
            1,
        )
    })

    it("fails closed after a second quality-only basis change", () => {
        const fixture = singleStoryFixture("run-stale-twice")
        fixture.env.deliverSemanticEvent(
            fixture.board,
            completionRequest(fixture, "check-stale-twice"),
        )
        const first = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(first)
        fixture.env.deliverSemanticEvent(
            fixture.acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(fixture.runId, "S1", "lease-S1").data,
                evaluationId: "quality-second",
            }),
        )
        fixture.env.deliverSemanticEvent(
            fixture.reviewer,
            aggregateCompletion(first.data, "passed"),
        )
        const second = fixture.env.events
            .filter(GoalAggregateReviewRequested.is)
            .at(-1)
        assert.ok(second)
        fixture.env.deliverSemanticEvent(
            fixture.acceptanceGate,
            StoryQualityCompleted.create({
                ...passedQuality(fixture.runId, "S1", "lease-S1").data,
                evaluationId: "quality-third",
            }),
        )
        fixture.env.deliverSemanticEvent(
            fixture.reviewer,
            aggregateCompletion(second.data, "passed"),
        )
        assert.equal(
            fixture.env.events.find(GoalCompletionAttested.is)?.data.status,
            "incomplete",
        )
        assert.equal(
            fixture.env.events.filter(GoalAggregateReviewRequested.is).length,
            2,
        )
    })

    it("does not reuse verification when the integrated lease changes", () => {
        const fixture = singleStoryFixture("run-stale-integration")
        fixture.env.deliverSemanticEvent(
            fixture.board,
            completionRequest(fixture, "check-stale-integration"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.deliverSemanticEvent(
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
        fixture.env.deliverSemanticEvent(
            fixture.repository,
            StoryMerged.create({
                runId: fixture.runId,
                storyId: "S1",
                leaseId: "lease-S1-new",
                mode: "worktree",
            }),
        )
        fixture.env.deliverSemanticEvent(
            fixture.acceptanceGate,
            passedQuality(fixture.runId, "S1", "lease-S1-new"),
        )
        fixture.env.deliverSemanticEvent(
            fixture.reviewer,
            aggregateCompletion(request.data, "passed"),
        )
        assert.equal(
            fixture.env.events.find(GoalCompletionAttested.is)?.data.status,
            "incomplete",
        )
        assert.equal(
            fixture.env.events.filter(GoalAggregateReviewRequested.is).length,
            1,
        )
    })

    it("fails an A8-shaped completion when aggregate composition is rejected", () => {
        const fixture = aggregateFixture("run-aggregate-rejected")
        fixture.env.deliverSemanticEvent(
            fixture.board,
            completionRequest(fixture, "check-rejected"),
        )
        const request = fixture.env.events.find(GoalAggregateReviewRequested.is)
        assert.ok(request)
        fixture.env.deliverSemanticEvent(
            fixture.reviewer,
            aggregateCompletion(request.data, "failed"),
        )

        const attestation = fixture.env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.data.status, "incomplete")
        assert.deepEqual(attestation?.data.rejectedInvariantIds, ["G-A1"])
        assert.equal(
            attestation?.data.invariants[0]?.aggregateReviewStatus,
            "failed",
        )
    })
})

function aggregateFixture(runId: string) {
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
    })
    guardian.setRequestAuthority(board)
    guardian.setIntegrationAuthority(repository)
    guardian.setQualityAuthority(acceptanceGate)
    guardian.setAggregateReviewAuthority(reviewer)
    const env = joinWithCapture(guardian)
    for (const storyId of storyIds) {
        env.deliverSemanticEvent(
            acceptanceGate,
            passedQuality(runId, storyId, `lease-${storyId}`),
        )
        env.deliverSemanticEvent(
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
    env.deliverSemanticEvent(
        repository,
        StoryMerged.create({
            runId,
            storyId: "S1",
            leaseId: "lease-S1",
            mode: "worktree",
        }),
    )
    env.deliverSemanticEvent(
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
    request: ReturnType<typeof GoalAggregateReviewRequested.create>["data"],
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
