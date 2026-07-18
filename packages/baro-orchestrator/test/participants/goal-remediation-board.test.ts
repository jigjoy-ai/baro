import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CollectiveBoard } from "../../src/participants/collective-board.js"
import { GoalGuardian } from "../../src/participants/goal-guardian.js"
import { savePrdAtomic, type PrdFile, type PrdStory } from "../../src/prd.js"
import { deriveGoalContract } from "../../src/runtime/goal-contract.js"
import {
    GoalInvariantChallengeRaised,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    PlanFragmentProposed,
    PlanningStreamClosed,
    PlanningStreamCompleted,
    RunPrepared,
    RunStartRequest,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    StoryIntegrationRequested,
    StoryMerged,
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
