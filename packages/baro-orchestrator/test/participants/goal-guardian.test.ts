import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GoalGuardian } from "../../src/participants/goal-guardian.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/runtime/goal-contract.js"
import {
    GoalCompletionAttested,
    GoalCompletionCheckRequested,
    GoalInvariantChallengeRaised,
    GoalInvariantChallengeResolved,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    GoalLedgerProjectionUpdated,
    GoalStoryInvariantMapped,
    PlanningStreamClosed,
    RunPreparationRequested,
    RuntimeReplanApplied,
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

describe("GoalGuardian", () => {
    it("attests only source-bound integration, independent quality, and completion", () => {
        const runId = "run-goal"
        const contract = deriveGoalContract(envelope)!
        const board = source("board")
        const repository = source("repository")
        const acceptanceGate = source("acceptance-gate")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: [
                {
                    storyId: "S1",
                    invariantIds: contract.invariants.map(({ id }) => id),
                },
            ],
            requireIndependentQuality: true,
        })
        guardian.setRequestAuthority(board)
        guardian.setIntegrationAuthority(repository)
        guardian.setQualityAuthority(acceptanceGate)
        const env = joinWithCapture(guardian)

        const merged = StoryMerged.create({
            runId,
            storyId: "S1",
            leaseId: "lease-1",
            mode: "worktree",
        })
        env.deliverSemanticEvent(source("fake-repository"), merged)
        env.deliverSemanticEvent(repository, merged)
        env.deliverSemanticEvent(
            source("fake-gate"),
            passedQuality(runId, "S1", "lease-1"),
        )

        env.deliverSemanticEvent(
            source("fake-board"),
            completionRequest(runId, "ignored", contract.contractId),
        )
        assert.equal(env.events.filter(GoalCompletionAttested.is).length, 0)

        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "check-without-quality", contract.contractId),
        )
        const incomplete = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.equal(incomplete?.data.status, "incomplete")
        assert.deepEqual(
            incomplete?.data.openInvariantIds,
            contract.invariants.map(({ id }) => id),
        )

        env.deliverSemanticEvent(
            acceptanceGate,
            passedQuality(runId, "S1", "lease-1"),
        )
        const finalRequest = completionRequest(
            runId,
            "check-satisfied",
            contract.contractId,
        )
        env.deliverSemanticEvent(board, finalRequest)
        const satisfied = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.equal(satisfied?.data.status, "satisfied")
        assert.deepEqual(
            satisfied?.data.satisfiedInvariantIds,
            contract.invariants.map(({ id }) => id),
        )
        assert.equal(Object.isFrozen(satisfied?.data), true)
        assert.equal(Object.isFrozen(satisfied?.data.invariants), true)

        env.deliverSemanticEvent(board, finalRequest)
        assert.equal(
            env.events.filter(
                (event) =>
                    GoalCompletionAttested.is(event) &&
                    event.data.checkId === "check-satisfied",
            ).length,
            2,
            "an exact authority replay receives cached attestation",
        )
    })

    it("lets distributed challenges fail closed but binds their resolution", () => {
        const runId = "run-challenge"
        const contract = deriveGoalContract(envelope)!
        const invariantIds = contract.invariants.map(({ id }) => id)
        const board = source("board")
        const repository = source("repository")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: [{ storyId: "S1", invariantIds }],
        })
        guardian.setRequestAuthority(board)
        guardian.setIntegrationAuthority(repository)
        const env = joinWithCapture(guardian)
        env.deliverSemanticEvent(
            repository,
            StoryMerged.create({
                runId,
                storyId: "S1",
                leaseId: "lease-1",
                mode: "shared-tree",
            }),
        )
        env.deliverSemanticEvent(
            source("worker-S1"),
            GoalInvariantChallengeRaised.create({
                runId,
                challengeId: "challenge-1",
                invariantId: invariantIds[0]!,
                raisedBy: "worker-S1",
                reason: "provider cleanup still races",
                storyId: "S1",
            }),
        )

        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "check-open", contract.contractId),
        )
        let attestation = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.equal(attestation?.data.status, "incomplete")
        assert.deepEqual(attestation?.data.openInvariantIds, [invariantIds[0]])

        const resolved = GoalInvariantChallengeResolved.create({
            runId,
            challengeId: "challenge-1",
            resolution: "resolved",
            reason: "a new ordering test proves cleanup",
        })
        env.deliverSemanticEvent(source("fake-board"), resolved)
        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "check-still-open", contract.contractId),
        )
        attestation = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.deepEqual(attestation?.data.openInvariantIds, [invariantIds[0]])

        env.deliverSemanticEvent(board, resolved)
        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "check-resolved", contract.contractId),
        )
        attestation = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.equal(attestation?.data.status, "satisfied")
    })

    it("keeps no-envelope runs explicitly disabled instead of inventing a contract", () => {
        const runId = "legacy-run"
        const board = source("board")
        const guardian = new GoalGuardian({ runId, goalEnvelope: null })
        guardian.setRequestAuthority(board)
        const env = joinWithCapture(guardian)

        assert.equal(guardian.contract, null)
        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "legacy-check", null),
        )
        assert.equal(
            env.events.find(GoalCompletionAttested.is)?.data.status,
            "disabled",
        )

        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "forged-contract", "goal:invented"),
        )
        const forged = env.events.filter(GoalCompletionAttested.is).at(-1)
        assert.equal(forged?.data.status, "incomplete")
        assert.equal(forged?.data.contractId, null)
    })

    it("turns a challenge into durable autonomous remediation and restores its evidence", () => {
        const runId = "run-autonomous-remediation"
        const contract = deriveGoalContract(envelope)!
        const board = source("board")
        const repository = source("repository")
        const acceptanceGate = source("acceptance-gate")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: [{
                storyId: "S1",
                invariantIds: contract.invariants.map(({ id }) => id),
            }],
            requireIndependentQuality: true,
        })
        guardian.setRequestAuthority(board)
        guardian.setIntegrationAuthority(repository)
        guardian.setQualityAuthority(acceptanceGate)
        const env = joinWithCapture(guardian)

        env.deliverSemanticEvent(
            acceptanceGate,
            passedQuality(runId, "S1", "lease-S1"),
        )
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
            source("S1"),
            GoalInvariantChallengeRaised.create({
                runId,
                challengeId: "challenge-remediate",
                invariantId: "G-A1",
                raisedBy: "S1",
                storyId: "S1",
                reason: "the cancellation race remains possible under retry",
            }),
        )

        const proposal = env.events.find(GoalInvariantRemediationProposed.is)
        assert.ok(proposal)
        assert.deepEqual(proposal.data.story.goalInvariantIds, ["G-A1"])
        assert.equal(proposal.data.story.model, "heavy")
        env.deliverSemanticEvent(
            board,
            GoalInvariantRemediationAdmitted.create({
                runId,
                contractId: contract.contractId,
                challengeId: proposal.data.challengeId,
                invariantId: proposal.data.invariantId,
                proposalId: proposal.data.proposalId,
                storyId: proposal.data.story.id,
                graphVersion: 2,
                disposition: "applied",
            }),
        )
        env.deliverSemanticEvent(
            board,
            GoalStoryInvariantMapped.create({
                runId,
                mappingId: "goal-map-remediation",
                storyId: proposal.data.story.id,
                invariantIds: ["G-A1"],
            }),
        )
        env.deliverSemanticEvent(
            acceptanceGate,
            passedQuality(runId, proposal.data.story.id, "lease-remediation"),
        )
        env.deliverSemanticEvent(
            repository,
            StoryMerged.create({
                runId,
                storyId: proposal.data.story.id,
                leaseId: "lease-remediation",
                mode: "worktree",
            }),
        )

        const resolved = env.events
            .filter(GoalInvariantChallengeResolved.is)
            .at(-1)
        assert.equal(resolved?.data.challengeId, "challenge-remediate")
        assert.equal(resolved?.data.resolution, "resolved")
        env.deliverSemanticEvent(
            board,
            completionRequest(
                runId,
                "check-remediated",
                contract.contractId,
                ["S1", proposal.data.story.id],
            ),
        )
        assert.equal(
            env.events.filter(GoalCompletionAttested.is).at(-1)?.data.status,
            "satisfied",
        )

        const projection = env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.ok(projection)
        assert.equal(projection.challenges[0]?.remediation?.status, "admitted")
        assert.equal(
            projection.challenges[0]?.resolution?.resolution,
            "resolved",
        )

        const resumedRunId = "run-autonomous-remediation-resumed"
        const resumedBoard = source("resumed-board")
        const resumed = new GoalGuardian({
            runId: resumedRunId,
            goalEnvelope: envelope,
            projection,
            requireIndependentQuality: true,
        })
        resumed.setRequestAuthority(resumedBoard)
        const resumedEnv = joinWithCapture(resumed)
        resumedEnv.deliverSemanticEvent(
            resumedBoard,
            completionRequest(
                resumedRunId,
                "check-resumed",
                contract.contractId,
                ["S1", proposal.data.story.id],
            ),
        )
        assert.equal(
            resumedEnv.events.find(GoalCompletionAttested.is)?.data.status,
            "satisfied",
        )
    })

    it("does not let an agentId spoof bypass a bound challenge bridge", () => {
        const runId = "run-bound-challenge"
        const bridge = source("bridge")
        const guardian = new GoalGuardian({ runId, goalEnvelope: envelope })
        guardian.setChallengeAuthority(bridge)
        const env = joinWithCapture(guardian)
        const challenge = GoalInvariantChallengeRaised.create({
            runId,
            challengeId: "challenge-bound",
            invariantId: "G-A1",
            raisedBy: "S1",
            storyId: "S1",
            reason: "must come through the lease-validating bridge",
        })

        env.deliverSemanticEvent(source("S1"), challenge)
        assert.equal(env.events.some(GoalInvariantRemediationProposed.is), false)
        env.deliverSemanticEvent(bridge, challenge)
        assert.equal(
            env.events.filter(GoalInvariantRemediationProposed.is).length,
            1,
        )
    })

    it("retries a restored remediation when PRD integration cannot be correlated to its Critic lease", () => {
        const runId = "run-restored-remediation-integration"
        const contract = deriveGoalContract(envelope)!
        const mappings = [
            {
                storyId: "S1",
                invariantIds: contract.invariants.map(({ id }) => id),
            },
            { storyId: "R1", invariantIds: ["G-A1"] },
        ]
        const ledger = new GoalInvariantLedger(contract, mappings)
        ledger.recordIntegration({ storyId: "S1", leaseId: "lease-S1" })
        ledger.recordQuality({
            storyId: "S1",
            leaseId: "lease-S1",
            evaluationId: "quality-S1",
            status: "passed",
            independentlyPassed: true,
        })
        ledger.raiseChallenge({
            challengeId: "challenge-crash-after-merge",
            invariantId: "G-A1",
            raisedBy: "S1",
            storyId: "S1",
            reason: "the original path needs corrective evidence",
        })
        ledger.bindChallengeRemediation("challenge-crash-after-merge", {
            proposalId: "proposal-R1",
            storyId: "R1",
            status: "requested",
        })
        ledger.admitChallengeRemediation(
            "challenge-crash-after-merge",
            "proposal-R1",
            "R1",
            2,
        )
        ledger.recordQuality({
            storyId: "R1",
            leaseId: "lease-R1",
            evaluationId: "quality-R1",
            status: "passed",
            independentlyPassed: true,
        })
        const beforeCrash = ledger.snapshot(4)
        assert.equal(beforeCrash.integrations.some(({ storyId }) => storyId === "R1"), false)
        assert.equal(beforeCrash.challenges[0]?.resolution, undefined)

        const board = source("board")
        const resumed = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: mappings,
            integratedStoryIds: ["S1", "R1"],
            projection: beforeCrash,
            requireIndependentQuality: true,
        })
        resumed.setRequestAuthority(board)
        const env = joinWithCapture(resumed)
        env.deliverSemanticEvent(
            board,
            RunPreparationRequested.create({ runId }),
        )
        env.deliverSemanticEvent(
            board,
            completionRequest(
                runId,
                "check-restored-remediation",
                contract.contractId,
                ["S1", "R1"],
            ),
        )

        const retry = env.events.find(GoalInvariantRemediationProposed.is)
        assert.ok(retry)
        assert.equal(retry.data.challengeId, "challenge-crash-after-merge")
        assert.notEqual(retry.data.proposalId, "proposal-R1")
        assert.notEqual(retry.data.story.id, "R1")
        assert.equal(
            env.events.filter(GoalCompletionAttested.is).at(-1)?.data.status,
            "incomplete",
            "an old R1 critique cannot prove which restored R1 attempt passed",
        )
        const durableProjection = env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.equal(durableProjection?.challenges[0]?.resolution, undefined)
        assert.equal(
            durableProjection?.challenges[0]?.remediation?.proposalId,
            retry.data.proposalId,
        )
        assert.equal(
            durableProjection?.challenges[0]?.remediation?.status,
            "requested",
        )
    })

    it("retries passed remediation work when graph persistence won before its admission event", () => {
        const runId = "run-restored-requested-remediation"
        const contract = deriveGoalContract(envelope)!
        const mappings = [
            {
                storyId: "S1",
                invariantIds: contract.invariants.map(({ id }) => id),
            },
            { storyId: "R-PERSISTED", invariantIds: ["G-A1"] },
        ]
        const ledger = new GoalInvariantLedger(contract, mappings)
        ledger.recordIntegration({ storyId: "S1", leaseId: "lease-S1" })
        ledger.recordQuality({
            storyId: "S1",
            leaseId: "lease-S1",
            evaluationId: "quality-S1",
            status: "passed",
            independentlyPassed: true,
        })
        ledger.raiseChallenge({
            challengeId: "challenge-persisted-before-admission",
            invariantId: "G-A1",
            raisedBy: "S1",
            storyId: "S1",
            reason: "the correction persisted before Guardian saw admission",
        })
        ledger.bindChallengeRemediation(
            "challenge-persisted-before-admission",
            {
                proposalId: "proposal-persisted",
                storyId: "R-PERSISTED",
                status: "requested",
            },
        )
        ledger.recordQuality({
            storyId: "R-PERSISTED",
            leaseId: "old-lease-R",
            evaluationId: "old-quality-R",
            status: "passed",
            independentlyPassed: true,
        })

        const board = source("board")
        const resumed = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: mappings,
            integratedStoryIds: ["S1", "R-PERSISTED"],
            projection: ledger.snapshot(3),
            requireIndependentQuality: true,
        })
        resumed.setRequestAuthority(board)
        const env = joinWithCapture(resumed)
        env.deliverSemanticEvent(
            board,
            RunPreparationRequested.create({ runId }),
        )

        const retry = env.events.find(GoalInvariantRemediationProposed.is)
        assert.ok(retry)
        assert.equal(
            retry.data.challengeId,
            "challenge-persisted-before-admission",
        )
        assert.notEqual(retry.data.proposalId, "proposal-persisted")
        assert.notEqual(retry.data.story.id, "R-PERSISTED")
        const projection = env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.equal(
            projection?.challenges[0]?.remediation?.proposalId,
            retry.data.proposalId,
        )
        assert.deepEqual(projection?.protocolIssues, [])
    })

    it("defers uncovered-invariant remediation until progressive planning closes", () => {
        const runId = "run-progressive-coverage"
        const contract = deriveGoalContract(envelope)!
        const board = source("board")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            deferCoverageUntilPlanningClosed: true,
        })
        guardian.setRequestAuthority(board)
        const env = joinWithCapture(guardian)

        env.deliverSemanticEvent(
            board,
            RunPreparationRequested.create({ runId }),
        )
        assert.equal(env.events.some(GoalInvariantRemediationProposed.is), false)

        env.deliverSemanticEvent(
            source("spoofed-board"),
            PlanningStreamClosed.create({
                runId,
                planningId: "planning-1",
                status: "completed",
                graphVersion: 1,
            }),
        )
        env.deliverSemanticEvent(
            board,
            PlanningStreamClosed.create({
                runId,
                planningId: "planning-1",
                status: "failed",
                graphVersion: 1,
                reason: "planner disconnected",
            }),
        )
        assert.equal(env.events.some(GoalInvariantRemediationProposed.is), false)

        env.deliverSemanticEvent(
            board,
            PlanningStreamClosed.create({
                runId,
                planningId: "planning-1",
                status: "completed",
                graphVersion: 1,
            }),
        )
        const proposals = env.events.filter(GoalInvariantRemediationProposed.is)
        assert.deepEqual(
            proposals.map(({ data }) => data.invariantId).sort(),
            contract.invariants.map(({ id }) => id).sort(),
        )
        assert.equal(
            proposals.every(({ data }) =>
                data.story.goalInvariantIds?.length === 1 &&
                data.story.goalInvariantIds[0] === data.invariantId
            ),
            true,
        )
    })

    it("revalidates a passed PRD story when its restored projection lacks Critic evidence", () => {
        const runId = "run-revalidate-passed"
        const contract = deriveGoalContract(envelope)!
        const mappings = [{
            storyId: "S1",
            invariantIds: contract.invariants.map(({ id }) => id),
        }]
        const staleProjection = new GoalInvariantLedger(
            contract,
            mappings,
        ).snapshot(2)
        const board = source("board")
        const guardian = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: mappings,
            integratedStoryIds: ["S1"],
            projection: staleProjection,
            requireIndependentQuality: true,
        })
        guardian.setRequestAuthority(board)
        const env = joinWithCapture(guardian)

        env.deliverSemanticEvent(
            board,
            RunPreparationRequested.create({ runId }),
        )
        const proposals = env.events.filter(GoalInvariantRemediationProposed.is)
        assert.equal(proposals.length, contract.invariants.length)
        assert.equal(
            proposals.every(({ data }) =>
                data.challengeId.startsWith("revalidation-")
            ),
            true,
        )
        const projection = env.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.deepEqual(
            projection?.integrations.map(({ storyId }) => storyId),
            ["S1"],
            "PRD pass truth closes the crash window without inventing quality",
        )
        assert.deepEqual(projection?.qualities, [])
    })

    it("reconciles a removed remediation after restart with a fresh proposal identity", () => {
        const firstRunId = "run-remediation-before-crash"
        const contract = deriveGoalContract(envelope)!
        const mappings = [{
            storyId: "S1",
            invariantIds: contract.invariants.map(({ id }) => id),
        }]
        const firstBoard = source("board-first")
        const first = new GoalGuardian({
            runId: firstRunId,
            goalEnvelope: envelope,
            storyMappings: mappings,
        })
        first.setRequestAuthority(firstBoard)
        const firstEnv = joinWithCapture(first)
        firstEnv.deliverSemanticEvent(
            source("worker-S1"),
            GoalInvariantChallengeRaised.create({
                runId: firstRunId,
                challengeId: "challenge-removed-remediation",
                invariantId: "G-A1",
                raisedBy: "worker-S1",
                storyId: "S1",
                reason: "the admitted correction was removed before execution",
            }),
        )
        const original = firstEnv.events.find(GoalInvariantRemediationProposed.is)!
        firstEnv.deliverSemanticEvent(
            firstBoard,
            RuntimeReplanApplied.create({
                runId: firstRunId,
                proposalId: original.data.proposalId,
                sourceStoryId: `goal:${original.data.challengeId}`,
                leaseId: `${firstRunId}:goal-guardian`,
                generation: 0,
                baseGraphVersion: 1,
                previousGraphVersion: 1,
                graphVersion: 2,
                currentGraphVersion: 2,
                reason: "admit remediation",
                mutation: {
                    addedStories: [original.data.story],
                    removedStoryIds: [],
                    modifiedDeps: {},
                },
            }),
        )
        firstEnv.deliverSemanticEvent(
            firstBoard,
            GoalInvariantRemediationAdmitted.create({
                runId: firstRunId,
                contractId: contract.contractId,
                challengeId: original.data.challengeId,
                invariantId: original.data.invariantId,
                proposalId: original.data.proposalId,
                storyId: original.data.story.id,
                graphVersion: 2,
                disposition: "applied",
            }),
        )
        const beforeCrash = firstEnv.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.equal(
            beforeCrash?.challenges[0]?.remediation?.status,
            "admitted",
        )

        const resumedRunId = "run-remediation-after-crash"
        const resumedBoard = source("board-resumed")
        const resumed = new GoalGuardian({
            runId: resumedRunId,
            goalEnvelope: envelope,
            storyMappings: mappings,
            projection: beforeCrash,
        })
        resumed.setRequestAuthority(resumedBoard)
        const resumedEnv = joinWithCapture(resumed)
        resumedEnv.deliverSemanticEvent(
            source("worker-S1"),
            GoalInvariantChallengeRaised.create({
                runId: resumedRunId,
                challengeId: "challenge-removed-remediation",
                invariantId: "G-A1",
                raisedBy: "worker-S1",
                storyId: "S1",
                reason: "the admitted correction was removed before execution",
            }),
        )
        const preStartRetry = resumedEnv.events.find(
            GoalInvariantRemediationProposed.is,
        )
        assert.ok(preStartRetry)
        resumedEnv.deliverSemanticEvent(
            resumedBoard,
            RunPreparationRequested.create({ runId: resumedRunId }),
        )
        const retries = resumedEnv.events.filter(
            GoalInvariantRemediationProposed.is,
        )
        const retry = retries.at(-1)
        assert.ok(retry)
        assert.notEqual(retry.data.proposalId, original.data.proposalId)
        assert.notEqual(retry.data.story.id, original.data.story.id)
        assert.equal(retry.data.challengeId, original.data.challengeId)
        assert.equal(retries.length, 2)
        assert.equal(retry.data.proposalId, preStartRetry.data.proposalId)
        const replayProjection = resumedEnv.events
            .filter(GoalLedgerProjectionUpdated.is)
            .at(-1)?.data.projection
        assert.deepEqual(replayProjection?.protocolIssues, [])
    })

    it("restores integrated PRD stories without inventing durable quality evidence", () => {
        const runId = "run-resume"
        const contract = deriveGoalContract(envelope)!
        const board = source("board")
        const mapping = [{
            storyId: "S1",
            invariantIds: contract.invariants.map(({ id }) => id),
        }]
        const compatible = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: mapping,
            integratedStoryIds: ["S1"],
        })
        compatible.setRequestAuthority(board)
        const compatibleEnv = joinWithCapture(compatible)
        compatibleEnv.deliverSemanticEvent(
            board,
            completionRequest(runId, "resume-compatible", contract.contractId),
        )
        assert.equal(
            compatibleEnv.events.find(GoalCompletionAttested.is)?.data.status,
            "satisfied",
        )

        const strict = new GoalGuardian({
            runId,
            goalEnvelope: envelope,
            storyMappings: mapping,
            integratedStoryIds: ["S1"],
            requireIndependentQuality: true,
        })
        strict.setRequestAuthority(board)
        const strictEnv = joinWithCapture(strict)
        strictEnv.deliverSemanticEvent(
            board,
            completionRequest(runId, "resume-strict", contract.contractId),
        )
        assert.equal(
            strictEnv.events.find(GoalCompletionAttested.is)?.data.status,
            "incomplete",
        )
    })

    it("fails a completion check correlated to a different goal contract", () => {
        const runId = "run-mismatch"
        const board = source("board")
        const guardian = new GoalGuardian({ runId, goalEnvelope: envelope })
        guardian.setRequestAuthority(board)
        const env = joinWithCapture(guardian)

        env.deliverSemanticEvent(
            board,
            completionRequest(runId, "mismatch", "goal:stale"),
        )
        const attestation = env.events.find(GoalCompletionAttested.is)
        assert.equal(attestation?.data.status, "incomplete")
        assert.equal(
            attestation?.data.openInvariantIds.length,
            guardian.contract?.invariants.length,
        )
        assert.match(attestation?.data.reason ?? "", /correlation mismatch/)
    })
})

function completionRequest(
    runId: string,
    checkId: string,
    contractId: string | null,
    storyIds: readonly string[] = ["S1"],
) {
    return GoalCompletionCheckRequested.create({
        runId,
        checkId,
        contractId,
        storyIds,
        verificationId: `${checkId}:verification`,
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
