import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CollectiveBoard } from "../../src/participants/collective-board.js"
import { GoalGuardian } from "../../src/participants/goal-guardian.js"
import { savePrdAtomic, type PrdFile, type PrdStory } from "../../src/prd.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/runtime/goal-contract.js"
import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    GoalInvariantChallengeRaised,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    PlanFragmentProposed,
    PlanningStreamClosed,
    PlanningStreamCompleted,
    RunPrepared,
    RunPushed,
    RunPushRequested,
    RunStartRequest,
    RunVerificationCompleted,
    RunVerificationRequested,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    StoryIntegrationRequested,
    StoryMerged,
    StoryQualityCompleted,
    StoryResult,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkOffered,
} from "../../src/semantic-events.js"
import { captureEnv, source, withTempDir } from "./helpers.js"

const envelope = {
    objective: "Keep cancellation lossless.",
    constraints: ["Preserve the public API."],
    acceptanceCriteria: ["All provider paths abort before returning."],
    nonGoals: [],
    assumptions: [],
} as const

describe("goal remediation graph admission", () => {
    it("closes an A13-shaped semantic gap through a fresh distributed quorum", async () => {
        await withTempDir("goal-remediation-a13-closure-", async (dir) => {
            const runId = "run-goal-remediation-a13-closure"
            const path = join(dir, "prd.json")
            const goalEnvelope = {
                objective: "Preserve cancellation across the provider collective.",
                constraints: [],
                acceptanceCriteria: [
                    "All provider paths close their streams exactly once on cancellation.",
                ],
                nonGoals: [],
                assumptions: [],
            }
            const contract = deriveGoalContract(goalEnvelope)!
            const storyIds = ["S2", "S4", "S5", "S6", "S7"]
            const mappings = storyIds.map((storyId) => ({
                storyId,
                invariantIds: storyId === "S2"
                    ? contract.invariants.map(({ id }) => id)
                    : [],
            }))
            const completedAt = "2026-01-01T00:00:00.000Z"
            const prd: PrdFile = {
                project: "goal-remediation-a13-closure",
                branchName: "baro/goal-remediation-a13-closure",
                description: "Exercise cross-shard semantic closure.",
                goalEnvelope,
                userStories: storyIds.map((storyId, index) => ({
                    id: storyId,
                    priority: index + 1,
                    title: `Completed shard ${storyId}`,
                    description: `Implement provider shard ${storyId}.`,
                    dependsOn: [],
                    retries: 1,
                    acceptance: [`Local behavior for ${storyId} passes.`],
                    tests: [],
                    goalInvariantIds: mappings[index]!.invariantIds,
                    passes: true,
                    completedAt,
                    durationSecs: 1,
                    model: "standard",
                })),
            }
            writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")

            const ledger = new GoalInvariantLedger(contract, mappings)
            for (const storyId of storyIds) {
                const leaseId = `lease-${storyId}`
                ledger.recordIntegration({ storyId, leaseId })
                ledger.recordQuality({
                    storyId,
                    leaseId,
                    evaluationId: `quality-${storyId}`,
                    status: "passed",
                    independentlyPassed: true,
                })
            }
            const repository = source("repository")
            const qualityGate = source("quality-gate")
            const verifier = source("verifier")
            const reviewer = source("goal-reviewer")
            const guardian = new GoalGuardian({
                runId,
                goalEnvelope,
                storyMappings: mappings,
                projection: ledger.snapshot(1),
                requireIndependentQuality: true,
                requireAggregateReview: true,
            })
            const board = new CollectiveBoard({
                runId,
                prdPath: path,
                cwd: dir,
                timeoutSecs: 60,
                verifyBeforePush: true,
                expectQualityDecisions: true,
                integrationAuthority: repository,
                qualityAuthority: qualityGate,
                verifierAuthority: verifier,
                goalCompletionAuthority: guardian,
            })
            guardian.setRequestAuthority(board)
            guardian.setIntegrationAuthority(repository)
            guardian.setQualityAuthority(qualityGate)
            guardian.setAggregateReviewAuthority(reviewer)
            const env = captureEnv()
            guardian.join(env)
            board.join(env)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            const firstVerification = await waitFor(
                env.events,
                RunVerificationRequested.is,
            )
            env.deliverSemanticEvent(
                verifier,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: firstVerification.data.verificationId,
                    status: "skipped",
                    commands: [
                        {
                            command: "npm run typecheck",
                            status: "passed",
                            durationMs: 10,
                        },
                        {
                            command: "npm run test",
                            status: "skipped",
                            durationMs: 1,
                            tail: "declared command budget exceeded",
                        },
                    ],
                    durationMs: 11,
                }),
            )
            const firstReview = await waitFor(
                env.events,
                GoalAggregateReviewRequested.is,
            )
            assert.deepEqual(firstReview.data.basis.storyIds, [...storyIds].sort())
            assert.deepEqual(
                firstReview.data.basis.invariants.find(
                    ({ invariantId }) => invariantId === "G-A1",
                )?.mappedStoryIds,
                ["S2"],
            )

            env.deliverSemanticEvent(
                reviewer,
                aggregateReviewCompletion(firstReview.data, "failed", "G-A1"),
            )
            const admission = await waitFor(
                env.events,
                GoalInvariantRemediationAdmitted.is,
            )
            assert.equal(env.events.some(RuntimeReplanApplied.is), true)
            assert.equal(env.events.some(RunPushRequested.is), false)

            const context = await waitFor(
                env.events,
                (event) =>
                    WorkContextRequested.is(event) &&
                    event.data.storyId === admission.data.storyId,
            )
            env.deliverSemanticEvent(
                source("context"),
                WorkContextProvided.create({
                    runId,
                    requestId: context.data.requestId,
                    storyId: admission.data.storyId,
                    context: null,
                }),
            )
            const offer = await waitFor(
                env.events,
                (event) =>
                    WorkOffered.is(event) &&
                    event.data.request.storyId === admission.data.storyId,
            )
            const leaseId = `lease-${admission.data.storyId}`
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.data.offerId,
                    leaseId,
                    workerId: "remediation-worker",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("remediation-worker"),
                StoryResult.create({
                    runId,
                    storyId: admission.data.storyId,
                    leaseId,
                    generation: offer.data.generation,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                }),
            )
            env.deliverSemanticEvent(
                qualityGate,
                StoryQualityCompleted.create({
                    runId,
                    evaluationId: `${admission.data.storyId}:quality`,
                    storyId: admission.data.storyId,
                    leaseId,
                    generation: offer.data.generation,
                    status: "passed",
                    targetTurn: 1,
                    reason: "independent Critic passed the remediation",
                    critique: {
                        status: "evaluated",
                        verdict: "pass",
                        reasoning: "the cancellation regression passes",
                        violatedCriteria: [],
                        turn: 1,
                        modelUsed: "critic-model",
                        repositoryFingerprint: "a".repeat(64),
                    },
                }),
            )
            await waitFor(
                env.events,
                (event) =>
                    StoryIntegrationRequested.is(event) &&
                    event.data.storyId === admission.data.storyId,
            )
            env.deliverSemanticEvent(
                repository,
                StoryMerged.create({
                    runId,
                    storyId: admission.data.storyId,
                    leaseId,
                    mode: "worktree",
                }),
            )

            const secondVerification = await waitFor(
                env.events,
                (event) =>
                    RunVerificationRequested.is(event) &&
                    event.data.verificationId !==
                        firstVerification.data.verificationId,
            )
            const reviewCountBeforeReplay = env.events.filter(
                GoalAggregateReviewRequested.is,
            ).length
            env.deliverSemanticEvent(
                verifier,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: firstVerification.data.verificationId,
                    status: "passed",
                    commands: [{
                        command: "npm run test",
                        status: "passed",
                        durationMs: 1,
                    }],
                    durationMs: 1,
                }),
            )
            await board.idle()
            assert.equal(
                env.events.filter(GoalAggregateReviewRequested.is).length,
                reviewCountBeforeReplay,
            )

            env.deliverSemanticEvent(
                verifier,
                RunVerificationCompleted.create({
                    runId,
                    verificationId: secondVerification.data.verificationId,
                    status: "passed",
                    commands: [{
                        command: "npm run test",
                        status: "passed",
                        durationMs: 1,
                    }],
                    durationMs: 1,
                }),
            )
            const secondReview = await waitFor(
                env.events,
                (event) =>
                    GoalAggregateReviewRequested.is(event) &&
                    event.data.basis.verificationId ===
                        secondVerification.data.verificationId,
            )
            assert.deepEqual(
                secondReview.data.basis.invariants.find(
                    ({ invariantId }) => invariantId === "G-A1",
                )?.mappedStoryIds,
                [admission.data.storyId, "S2"].sort(),
            )
            env.deliverSemanticEvent(
                reviewer,
                aggregateReviewCompletion(secondReview.data, "passed"),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                repository,
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, true)
            assert.equal(summary.verificationStatus, "passed")
            assert.notEqual(
                firstVerification.data.verificationId,
                secondVerification.data.verificationId,
            )
        })
    })

    it("reopens an early verification snapshot and retries transient admission without another merge", async () => {
        await withTempDir("goal-remediation-finalization-race-", async (dir) => {
            const runId = "run-goal-remediation-finalization-race"
            const path = join(dir, "prd.json")
            const contract = deriveGoalContract(envelope)!
            const prd: PrdFile = {
                project: "goal-remediation-finalization-race",
                branchName: "baro/goal-remediation-finalization-race",
                description: "Exercise remediation versus finalization ordering.",
                goalEnvelope: envelope,
                userStories: [{
                    id: "S1",
                    priority: 1,
                    title: "Completed narrow implementation",
                    description: "Only the acceptance invariant was implemented.",
                    dependsOn: [],
                    retries: 1,
                    acceptance: ["All provider paths abort before returning."],
                    tests: [],
                    goalInvariantIds: ["G-A1"],
                    passes: true,
                    completedAt: "2026-01-01T00:00:00.000Z",
                    durationSecs: 1,
                    model: "standard",
                }],
            }
            writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")
            const guardian = new GoalGuardian({
                runId,
                goalEnvelope: envelope,
                storyMappings: [{ storyId: "S1", invariantIds: ["G-A1"] }],
                integratedStoryIds: ["S1"],
            })
            let persistAttempts = 0
            const board = new CollectiveBoard({
                runId,
                prdPath: path,
                cwd: dir,
                timeoutSecs: 60,
                goalCompletionAuthority: guardian,
                runtimeReplanPersist: (prdPath, candidate) => {
                    persistAttempts += 1
                    if (persistAttempts === 1) {
                        throw new Error("transient durability outage")
                    }
                    savePrdAtomic(prdPath, candidate)
                },
            })
            guardian.setRequestAuthority(board)
            const env = captureEnv()
            guardian.join(env)
            board.join(env)

            // Deliver preparation immediately: RunPrepared can already be in
            // Board's mailbox when Guardian reacts to RunPreparationRequested.
            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repository"),
                RunPrepared.create({ runId, baseSha: null }),
            )

            const admission = await waitFor(
                env.events,
                GoalInvariantRemediationAdmitted.is,
            )
            await board.idle()
            assert.equal(admission.data.invariantId, "G-C1")
            assert.equal(persistAttempts, 2)
            assert.equal(
                env.events.some(
                    (event) =>
                        RuntimeReplanRejected.is(event) &&
                        event.data.code === "persistence_failed",
                ),
                true,
            )
            assert.equal(env.events.some(RuntimeReplanApplied.is), true)
            const durable = JSON.parse(readFileSync(path, "utf8")) as PrdFile
            assert.equal(
                durable.userStories.some(
                    ({ id }) => id === admission.data.storyId,
                ),
                true,
            )
        })
    })

    it("admits uncovered contract work emitted during progressive close", async () => {
        await withTempDir("goal-remediation-progressive-close-", async (dir) => {
            const runId = "run-goal-remediation-progressive-close"
            const planningId = "planning-goal-remediation-close"
            const path = join(dir, "prd.json")
            const repository = source("repository")
            const initial: PrdFile = {
                project: "goal-remediation-progressive-close",
                branchName: "baro/goal-remediation-progressive-close",
                description: "Exercise progressive-close goal coverage.",
                goalEnvelope: envelope,
                userStories: [],
            }
            const s1: PrdStory = {
                id: "S1",
                priority: 1,
                title: "Implement cancellation",
                description: "Implement only the acceptance behavior.",
                dependsOn: [],
                retries: 1,
                acceptance: ["All provider paths abort before returning."],
                tests: ["npm test -- cancellation"],
                goalInvariantIds: ["G-A1"],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: "standard",
            }
            writeFileSync(path, JSON.stringify(initial, null, 2) + "\n")
            const guardian = new GoalGuardian({
                runId,
                goalEnvelope: envelope,
                storyMappings: [],
                deferCoverageUntilPlanningClosed: true,
            })
            const board = new CollectiveBoard({
                runId,
                prdPath: path,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                unsafeAllowUnboundPlanningAuthority: true,
                integrationAuthority: repository,
                goalCompletionAuthority: guardian,
            })
            guardian.setRequestAuthority(board)
            guardian.setIntegrationAuthority(repository)
            const env = captureEnv()
            guardian.join(env)
            board.join(env)
            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                repository,
                RunPrepared.create({ runId, baseSha: null }),
            )
            env.deliverSemanticEvent(
                source("planner"),
                PlanFragmentProposed.create({
                    runId,
                    planningId,
                    fragmentId: "safe-prefix",
                    ordinal: 1,
                    stories: [s1],
                }),
            )

            const context = await waitFor(
                env.events,
                (event) =>
                    WorkContextRequested.is(event) &&
                    event.data.storyId === "S1",
            )
            env.deliverSemanticEvent(
                source("context"),
                WorkContextProvided.create({
                    runId,
                    requestId: context.data.requestId,
                    storyId: "S1",
                    context: null,
                }),
            )
            const offer = await waitFor(
                env.events,
                (event) =>
                    WorkOffered.is(event) &&
                    event.data.request.storyId === "S1",
            )
            const leaseId = "lease-progressive-S1"
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.data.offerId,
                    leaseId,
                    workerId: "worker-S1",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S1"),
                StoryResult.create({
                    runId,
                    storyId: "S1",
                    leaseId,
                    generation: offer.data.generation,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                }),
            )
            await waitFor(
                env.events,
                (event) =>
                    StoryIntegrationRequested.is(event) &&
                    event.data.storyId === "S1",
            )
            env.deliverSemanticEvent(
                repository,
                StoryMerged.create({
                    runId,
                    storyId: "S1",
                    leaseId,
                    mode: "worktree",
                }),
            )
            await board.idle()
            assert.equal(
                env.events.some(GoalInvariantRemediationProposed.is),
                false,
                "coverage stays deferred while the planner stream is open",
            )

            env.deliverSemanticEvent(
                source("planner"),
                PlanningStreamCompleted.create({
                    runId,
                    planningId,
                    finalPrd: { ...initial, userStories: [s1] },
                }),
            )
            await waitFor(env.events, PlanningStreamClosed.is)
            const admission = await waitFor(
                env.events,
                GoalInvariantRemediationAdmitted.is,
            )
            await board.idle()
            assert.equal(admission.data.invariantId, "G-C1")
            const durable = JSON.parse(readFileSync(path, "utf8")) as PrdFile
            assert.equal(
                durable.userStories.some(
                    ({ id }) => id === admission.data.storyId,
                ),
                true,
            )
        })
    })

    it("lets Guardian add durable corrective work without owning the DAG", async () => {
        await withTempDir("goal-remediation-board-", async (dir) => {
            const runId = "run-goal-remediation-board"
            const path = join(dir, "prd.json")
            const contract = deriveGoalContract(envelope)!
            const prd: PrdFile = {
                project: "goal-remediation",
                branchName: "baro/goal-remediation",
                description: "Exercise autonomous challenge remediation.",
                goalEnvelope: envelope,
                userStories: [{
                    id: "S1",
                    priority: 1,
                    title: "Implement cancellation",
                    description: "Implement the original cancellation path.",
                    dependsOn: [],
                    retries: 2,
                    acceptance: ["Cancellation is lossless."],
                    tests: [],
                    goalInvariantIds: contract.invariants.map(({ id }) => id),
                    passes: false,
                    completedAt: null,
                    durationSecs: null,
                    model: "standard",
                }],
            }
            writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")

            const guardian = new GoalGuardian({
                runId,
                goalEnvelope: envelope,
                storyMappings: prd.userStories.map((story) => ({
                    storyId: story.id,
                    invariantIds: story.goalInvariantIds ?? [],
                })),
            })
            const bridge = source("bridge")
            guardian.setChallengeAuthority(bridge)
            const board = new CollectiveBoard({
                runId,
                prdPath: path,
                cwd: dir,
                timeoutSecs: 60,
                goalCompletionAuthority: guardian,
            })
            guardian.setRequestAuthority(board)
            const env = captureEnv()
            guardian.join(env)
            board.join(env)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repository"),
                RunPrepared.create({ runId, baseSha: null }),
            )
            env.deliverSemanticEvent(
                bridge,
                GoalInvariantChallengeRaised.create({
                    runId,
                    challengeId: "challenge-runtime-race",
                    invariantId: "G-A1",
                    raisedBy: "S1",
                    storyId: "S1",
                    reason: "a retry can return before cancellation cleanup",
                }),
            )
            await board.idle()

            assert.ok(env.events.find(GoalInvariantRemediationProposed.is))
            const applied = env.events.find(RuntimeReplanApplied.is)
            assert.ok(
                applied,
                JSON.stringify(
                    env.events.map((event) => ({
                        type: event.type,
                        data: event.data,
                    })),
                ),
            )
            assert.equal(applied.data.mutation.addedStories.length, 1)
            const remediation = applied.data.mutation.addedStories[0]!
            assert.match(remediation.id, /^GREM-/u)
            assert.deepEqual(remediation.goalInvariantIds, ["G-A1"])
            assert.equal(remediation.model, "heavy")
            const admission = env.events.find(GoalInvariantRemediationAdmitted.is)
            assert.equal(admission?.data.storyId, remediation.id)

            const durable = JSON.parse(readFileSync(path, "utf8")) as PrdFile
            assert.equal(
                durable.userStories.some(({ id }) => id === remediation.id),
                true,
            )
            assert.equal(
                durable.runtimeGraph?.protocol?.goal.challenges[0]
                    ?.remediation?.status,
                "admitted",
            )
        })
    })

    it("defers invariant work above the healing budget and admits it after progress", async () => {
        await withTempDir("goal-remediation-backpressure-", async (dir) => {
            const runId = "run-goal-remediation-backpressure"
            const path = join(dir, "prd.json")
            const wideEnvelope = {
                objective: "Preserve every required provider behavior.",
                constraints: [],
                acceptanceCriteria: [
                    "Provider A is lossless.",
                    "Provider B is lossless.",
                    "Provider C is lossless.",
                    "Provider D is lossless.",
                ],
                nonGoals: [],
                assumptions: [],
            }
            const contract = deriveGoalContract(wideEnvelope)!
            const prd: PrdFile = {
                project: "goal-remediation-backpressure",
                branchName: "baro/goal-remediation-backpressure",
                description: "Exercise bounded remediation admission.",
                goalEnvelope: wideEnvelope,
                userStories: [{
                    id: "S1",
                    priority: 1,
                    title: "Foundation",
                    description: "Implement the shared foundation.",
                    dependsOn: [],
                    retries: 1,
                    acceptance: ["The foundation is integrated."],
                    tests: [],
                    goalInvariantIds: contract.invariants.map(({ id }) => id),
                    passes: false,
                    completedAt: null,
                    durationSecs: null,
                    model: "standard",
                }],
            }
            writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")
            const guardian = new GoalGuardian({
                runId,
                goalEnvelope: wideEnvelope,
                storyMappings: prd.userStories.map((story) => ({
                    storyId: story.id,
                    invariantIds: story.goalInvariantIds ?? [],
                })),
            })
            const bridge = source("bridge")
            guardian.setChallengeAuthority(bridge)
            const board = new CollectiveBoard({
                runId,
                prdPath: path,
                cwd: dir,
                timeoutSecs: 60,
                replanProgressBudget: 3,
                goalCompletionAuthority: guardian,
            })
            guardian.setRequestAuthority(board)
            const env = captureEnv()
            guardian.join(env)
            board.join(env)
            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repository"),
                RunPrepared.create({ runId, baseSha: null }),
            )

            for (const invariant of contract.invariants) {
                env.deliverSemanticEvent(
                    bridge,
                    GoalInvariantChallengeRaised.create({
                        runId,
                        challengeId: `challenge-${invariant.id}`,
                        invariantId: invariant.id,
                        raisedBy: "S1",
                        storyId: "S1",
                        reason: `${invariant.id} needs independent corrective work`,
                    }),
                )
            }
            await board.idle()
            assert.equal(
                env.events.filter(
                    (event) =>
                        GoalInvariantRemediationAdmitted.is(event) &&
                        event.data.disposition === "applied",
                ).length,
                3,
            )

            const contextRequest = await waitFor(
                env.events,
                (event) =>
                    WorkContextRequested.is(event) &&
                    event.data.storyId === "S1",
            )
            env.deliverSemanticEvent(
                source("context"),
                WorkContextProvided.create({
                    runId,
                    requestId: contextRequest.data.requestId,
                    storyId: "S1",
                    context: null,
                }),
            )
            const offer = await waitFor(
                env.events,
                (event) =>
                    WorkOffered.is(event) &&
                    event.data.request.storyId === "S1",
            )
            const leaseId = "lease-S1-progress"
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.data.offerId,
                    leaseId,
                    workerId: "worker-S1",
                    generation: offer.data.generation,
                    request: offer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S1"),
                StoryResult.create({
                    runId,
                    storyId: "S1",
                    leaseId,
                    generation: offer.data.generation,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                }),
            )
            await waitFor(
                env.events,
                (event) =>
                    StoryIntegrationRequested.is(event) &&
                    event.data.storyId === "S1",
            )
            env.deliverSemanticEvent(
                source("repository"),
                StoryMerged.create({
                    runId,
                    storyId: "S1",
                    leaseId,
                    mode: "worktree",
                }),
            )
            await board.idle()

            assert.equal(
                env.events.filter(
                    (event) =>
                        GoalInvariantRemediationAdmitted.is(event) &&
                        event.data.disposition === "applied",
                ).length,
                4,
            )
            const durable = JSON.parse(readFileSync(path, "utf8")) as PrdFile
            assert.equal(
                durable.userStories.filter(({ id }) => id.startsWith("GREM-"))
                    .length,
                4,
            )
        })
    })
})

function aggregateReviewCompletion(
    request: ReturnType<typeof GoalAggregateReviewRequested.create>["data"],
    status: "passed" | "failed",
    failedInvariantId?: string,
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
        invariants: request.basis.invariants.map(({ invariantId }) => {
            const invariantStatus =
                status === "failed" && invariantId === failedInvariantId
                    ? "failed"
                    : "passed"
            return {
                invariantId,
                status: invariantStatus,
                reason: invariantStatus === "passed"
                    ? "the merged run satisfies the invariant"
                    : "provider streams do not close exactly once",
            }
        }),
    })
}

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = events.find(guard)
        if (found) return found
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail("timed out waiting for event")
}
