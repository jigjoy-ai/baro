import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { SemanticEvent } from "@mozaik-ai/core"

import { CollectiveBoard } from "../../src/participants/collective-board.js"
import { ProgressivePlanningCoordinator } from "../../src/participants/progressive-planning-coordinator.js"
import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/runtime/goal-contract.js"
import {
    PlanFragmentAdmitted,
    PlanFragmentProposed,
    PlanFragmentRejected,
    PlanningStreamClosed,
    PlanningStreamCompleted,
    PlanningStreamFailed,
    RecoveryStarted,
    Replan,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RunPrepared,
    RunPushed,
    RunPushRequested,
    RunStartRequest,
    RunVerificationRequested,
    StoryIntegrationRequested,
    StoryMerged,
    StoryResult,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkOffered,
} from "../../src/semantic-events.js"
import {
    joinWithCapture,
    source,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

describe("CollectiveBoard progressive planning", () => {
    it("preserves durable goal evidence while bootstrapping the planning latch", () => {
        const runId = "run-progressive-protocol"
        const goalEnvelope = {
            objective: "Keep cancellation lossless.",
            constraints: [],
            acceptanceCriteria: ["All provider paths abort before returning."],
            nonGoals: [],
            assumptions: [],
        }
        const contract = deriveGoalContract(goalEnvelope)!
        const goal = new GoalInvariantLedger(contract).snapshot(3)
        const prd: PrdFile = {
            ...bootstrapPrd(),
            goalEnvelope,
            runtimeGraph: {
                runId: "prior-run",
                version: 4,
                dynamicStories: 0,
                policyStories: 0,
                appliedDecisions: [],
                protocol: {
                    schemaVersion: 1,
                    goal,
                    completion: {
                        runId: "prior-run",
                        checkId: "prior-check",
                        contractId: contract.contractId,
                        goalRevision: goal.revision,
                        verificationId: "prior-verification",
                        status: "incomplete",
                        satisfiedInvariantIds: [],
                        openInvariantIds: ["G-A1"],
                        rejectedInvariantIds: [],
                        invariants: [{
                            invariantId: "G-A1",
                            status: "open",
                            mappedStoryIds: [],
                            integratedStoryIds: [],
                            independentlyReviewedStoryIds: [],
                            reason: "no mapped story",
                        }],
                        reason: "goal remains incomplete",
                    },
                },
            },
        }
        let committed: PrdFile | undefined
        const coordinator = new ProgressivePlanningCoordinator({
            runId,
            planningId: "planning-protocol",
            host: {
                snapshot: () => ({
                    phase: "idle",
                    prd: null,
                    graphVersion: 1,
                    wave: null,
                }),
                commitPrd: (value) => {
                    committed = value
                },
                admitGraph: () => {
                    throw new Error("not used")
                },
                emit: () => undefined,
                afterAdmission: () => undefined,
                afterClose: () => undefined,
                terminate: () => undefined,
            },
        })

        const initialized = coordinator.initialize(prd)
        assert.equal(committed, initialized)
        assert.deepEqual(initialized.runtimeGraph?.protocol?.goal, goal)
        assert.notEqual(initialized.runtimeGraph?.protocol?.goal, goal)
        assert.equal(
            initialized.runtimeGraph?.protocol?.completion,
            undefined,
        )
        assert.equal(initialized.runtimeGraph?.planning?.status, "open")
    })

    it("accepts planning events only from the exact bound feed object", async () => {
        await withTempDir("progressive-authority-", async (dir) => {
            const runId = "run-progressive-authority"
            const planningId = "planning-authority"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const planningAuthority = source("planning-feed")
            const lookalike = source("planning-feed")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                planningAuthority,
            })
            const env = joinWithCapture(board)
            await start(env, runId)
            const proposal = fragment(
                runId,
                planningId,
                "identity-bound",
                1,
                [story("S1")],
            )

            env.deliverSemanticEvent(lookalike, proposal)
            await flush()
            assert.equal(env.events.filter(PlanFragmentAdmitted.is).length, 0)
            assert.deepEqual(readPrd(prdPath).userStories, [])

            env.deliverSemanticEvent(planningAuthority, proposal)
            const admitted = await waitFor(env.events, PlanFragmentAdmitted.is)
            assert.deepEqual(admitted.data.storyIds, ["S1"])
            assert.deepEqual(
                readPrd(prdPath).userStories.map((entry) => entry.id),
                ["S1"],
            )
        })
    })

    it("fails closed at the soft deadline when an empty planning stream stays open", async () => {
        await withTempDir("progressive-soft-deadline-", async (dir) => {
            const runId = "run-progressive-soft-deadline"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: "planning-never-closes",
                unsafeAllowUnboundPlanningAuthority: true,
                softDeadlineSecs: 0.01,
            })
            const env = joinWithCapture(board)
            await start(env, runId)

            await waitFor(env.events, RunPushRequested.is)
            assert.equal(env.events.some(WorkOffered.is), false)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId, pushed: false }),
            )

            const summary = await board.done
            assert.equal(summary.success, false)
            assert.match(summary.abortReason ?? "", /soft deadline reached/)
        })
    })

    it("dispatches a safe prefix before Planner completion, admits the final tail, and finishes normally", async () => {
        await withTempDir("progressive-board-", async (dir) => {
            const runId = "run-progressive"
            const planningId = "planning-progressive"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                unsafeAllowUnboundPlanningAuthority: true,
            })
            const env = joinWithCapture(board)
            await start(env, runId)

            await flush()
            assert.equal(env.events.some(RunVerificationRequested.is), false)
            assert.equal(env.events.some(RunPushRequested.is), false)

            env.deliverSemanticEvent(
                source("planner"),
                fragment(runId, planningId, "prefix", 1, [story("S1")]),
            )
            const admittedPrefix = await waitFor(env.events, PlanFragmentAdmitted.is)
            assert.deepEqual(admittedPrefix.data.storyIds, ["S1"])
            assert.equal(admittedPrefix.data.graphVersion, 2)

            const s1Offer = await offerFor(env, runId, "S1")
            const duringPlanning = readPrd(prdPath)
            assert.equal(duringPlanning.runtimeGraph?.planning?.status, "open")
            assert.equal(
                env.events.some(PlanningStreamClosed.is),
                false,
                "S1 was offered while Planner was still open",
            )

            env.deliverSemanticEvent(
                source("planner"),
                PlanningStreamCompleted.create({
                    runId,
                    planningId,
                    finalPrd: bootstrapPrd([story("S1"), story("S2", ["S1"])]),
                }),
            )
            const closed = await waitFor(env.events, PlanningStreamClosed.is)
            assert.equal(closed.data.status, "completed")
            assert.deepEqual(
                readPrd(prdPath).runtimeGraph?.planning?.admittedStoryIds,
                ["S1", "S2"],
            )
            assert.equal(
                env.events.filter(PlanFragmentAdmitted.is).length,
                2,
                "the final-only suffix crossed the same admission boundary",
            )

            await completeStory(env, runId, s1Offer, "lease-s1")
            const s2Offer = await offerFor(env, runId, "S2")
            await completeStory(env, runId, s2Offer, "lease-s2")

            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, true)
            assert.deepEqual(summary.completedStories, ["S1", "S2"])
        })
    })

    it("rejects unsafe fragments atomically and replays an admitted fragment idempotently", async () => {
        await withTempDir("progressive-rejection-", async (dir) => {
            const runId = "run-progressive-reject"
            const planningId = "planning-reject"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                unsafeAllowUnboundPlanningAuthority: true,
            })
            const env = joinWithCapture(board)
            await start(env, runId)

            env.deliverSemanticEvent(
                source("planner"),
                fragment(runId, planningId, "unsafe", 1, [story("S2", ["S1"])]),
            )
            const rejected = await waitFor(env.events, PlanFragmentRejected.is)
            assert.equal(rejected.data.code, "graph_rejected")
            assert.deepEqual(readPrd(prdPath).userStories, [])
            assert.equal(readPrd(prdPath).runtimeGraph?.planning?.nextOrdinal, 1)

            const valid = fragment(runId, planningId, "foundation", 1, [story("S1")])
            env.deliverSemanticEvent(source("planner"), valid)
            await waitFor(env.events, PlanFragmentAdmitted.is)
            env.deliverSemanticEvent(source("planner"), valid)
            await waitForCount(env.events, PlanFragmentAdmitted.is, 2)
            assert.equal(env.events.filter(PlanFragmentAdmitted.is)[1]?.data.replay, true)
            assert.equal(readPrd(prdPath).userStories.length, 1)

            env.deliverSemanticEvent(
                source("planner"),
                fragment(runId, planningId, "foundation", 1, [
                    story("S1", [], { title: "conflicting replay" }),
                ]),
            )
            const conflict = await waitForCount(
                env.events,
                PlanFragmentRejected.is,
                2,
            )
            assert.equal(conflict[1]?.data.code, "fragment_id_conflict")
            assert.equal(readPrd(prdPath).userStories[0]?.title, "Story S1")
        })
    })

    it("keeps a completed planning latch monotonic across exact and conflicting completion replays", async () => {
        await withTempDir("progressive-completion-replay-", async (dir) => {
            const runId = "run-progressive-completion-replay"
            const planningId = "planning-completion-replay"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                unsafeAllowUnboundPlanningAuthority: true,
            })
            const env = joinWithCapture(board)
            await start(env, runId)

            env.deliverSemanticEvent(
                source("planner"),
                fragment(runId, planningId, "complete-prefix", 1, [story("S1")]),
            )
            await waitFor(env.events, PlanFragmentAdmitted.is)

            const completion = PlanningStreamCompleted.create({
                runId,
                planningId,
                finalPrd: bootstrapPrd([story("S1")]),
            })
            env.deliverSemanticEvent(source("planner"), completion)
            await waitFor(env.events, PlanningStreamClosed.is)

            env.deliverSemanticEvent(source("planner"), completion)
            const replayed = await waitForCount(
                env.events,
                PlanningStreamClosed.is,
                2,
            )
            assert.equal(replayed[1]?.data.status, "completed")

            env.deliverSemanticEvent(
                source("planner"),
                PlanningStreamCompleted.create({
                    runId,
                    planningId,
                    finalPrd: bootstrapPrd([
                        story("S1", [], { title: "conflicting final replay" }),
                    ]),
                }),
            )
            const rejected = await waitFor(env.events, PlanFragmentRejected.is)
            assert.equal(rejected.data.code, "final_plan_mismatch")
            assert.equal(
                readPrd(prdPath).runtimeGraph?.planning?.status,
                "completed",
            )
            assert.equal(
                env.events
                    .filter(PlanningStreamClosed.is)
                    .some((event) => event.data.status === "failed"),
                false,
            )
        })
    })

    it("lets already-dispatched work settle after Planner failure, then fails closed", async () => {
        await withTempDir("progressive-failure-", async (dir) => {
            const runId = "run-progressive-failure"
            const planningId = "planning-failure"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(bootstrapPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                progressivePlanningId: planningId,
                unsafeAllowUnboundPlanningAuthority: true,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            await start(env, runId)
            env.deliverSemanticEvent(
                source("planner"),
                fragment(runId, planningId, "prefix", 1, [story("S1")]),
            )
            const offer = await offerFor(env, runId, "S1")
            const leaseId = "lease-failure-s1"
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: offer.offerId,
                    leaseId,
                    workerId: "worker-S1",
                    generation: offer.generation,
                    request: offer.request,
                }),
            )
            await flush()

            env.deliverSemanticEvent(
                source("planner"),
                PlanningStreamFailed.create({
                    runId,
                    planningId,
                    code: "provider_disconnect",
                    reason: "planner transport closed",
                }),
            )
            const closed = await waitFor(env.events, PlanningStreamClosed.is)
            assert.equal(closed.data.status, "failed")
            assert.equal(env.events.some(RunPushRequested.is), false)

            env.deliverSemanticEvent(
                source("planner"),
                PlanningStreamCompleted.create({
                    runId,
                    planningId,
                    finalPrd: bootstrapPrd([story("S1")]),
                }),
            )
            await flush()
            assert.equal(
                readPrd(prdPath).runtimeGraph?.planning?.status,
                "failed",
            )
            assert.equal(
                env.events
                    .filter(PlanningStreamClosed.is)
                    .some((event) => event.data.status === "completed"),
                false,
            )

            const appliedBeforeFailure =
                env.events.filter(RuntimeReplanApplied.is).length
            env.deliverSemanticEvent(
                source("S1"),
                RuntimeReplanProposed.create({
                    runId,
                    proposalId: "post-planner-failure-runtime",
                    sourceStoryId: "S1",
                    leaseId,
                    generation: offer.generation,
                    baseGraphVersion: 2,
                    reason: "must not expand a terminally failed plan",
                    mutation: {
                        addedStories: [runtimeStory("S2")],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    },
                }),
            )
            env.deliverSemanticEvent(
                board,
                Replan.create({
                    source: "surgeon:test",
                    reason: "queued policy work must also remain closed",
                    addedStories: [runtimeStory("S3")],
                    removedStoryIds: [],
                    modifiedDeps: {},
                }),
            )
            await flush()

            await completeStory(env, runId, offer, leaseId)
            await waitFor(env.events, RunPushRequested.is)
            assert.equal(
                env.events.filter(RuntimeReplanApplied.is).length,
                appliedBeforeFailure,
                "failed planning never admits direct or queued runtime mutations",
            )
            assert.deepEqual(
                readPrd(prdPath).userStories.map((entry) => entry.id),
                ["S1"],
            )
            assert.equal(
                env.events.some(
                    (event) =>
                        WorkContextRequested.is(event) &&
                        (event.data.storyId === "S2" || event.data.storyId === "S3"),
                ),
                false,
            )
            assert.equal(
                env.events.some(
                    (event) =>
                        WorkOffered.is(event) &&
                        (event.data.request.storyId === "S2" ||
                            event.data.request.storyId === "S3"),
                ),
                false,
            )
            assert.equal(env.events.some(RecoveryStarted.is), false)
            env.deliverSemanticEvent(
                source("repo"),
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, false)
            assert.deepEqual(summary.completedStories, ["S1"])
            assert.match(summary.abortReason ?? "", /progressive planning failed/)
            assert.match(summary.abortReason ?? "", /provider_disconnect/)
        })
    })
})

function bootstrapPrd(userStories: PrdStory[] = []): PrdFile {
    return {
        project: "progressive-board",
        branchName: "baro/progressive-board",
        description: "Exercise progressive collective planning.",
        decisionDocument: "Keep the public API additive.",
        executionMode: {
            mode: "parallel",
            reason: "independent safe prefixes may execute early",
            maxStories: 8,
            source: "llm",
        },
        userStories,
    }
}

function story(
    id: string,
    dependsOn: string[] = [],
    overrides: Partial<PrdStory> = {},
): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 2,
        acceptance: [`${id} is observable`],
        tests: [`npm test -- ${id}`],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        ...overrides,
    }
}

function runtimeStory(id: string, dependsOn: string[] = []) {
    const planned = story(id, dependsOn)
    return {
        id: planned.id,
        priority: planned.priority,
        title: planned.title,
        description: planned.description,
        dependsOn: [...planned.dependsOn],
        retries: planned.retries,
        acceptance: [...planned.acceptance],
        tests: [...planned.tests],
        model: planned.model,
    }
}

function fragment(
    runId: string,
    planningId: string,
    fragmentId: string,
    ordinal: number,
    stories: PrdStory[],
): ReturnType<typeof PlanFragmentProposed.create> {
    return PlanFragmentProposed.create({
        runId,
        planningId,
        fragmentId,
        ordinal,
        stories,
    })
}

async function start(env: CapturedEnvironment, runId: string): Promise<void> {
    env.deliverSemanticEvent(
        source("operator"),
        RunStartRequest.create({ reason: "test" }),
    )
    env.deliverSemanticEvent(
        source("repo"),
        RunPrepared.create({ runId, baseSha: null }),
    )
    await flush()
}

async function offerFor(
    env: CapturedEnvironment,
    runId: string,
    storyId: string,
): Promise<ReturnType<typeof WorkOffered.create>["data"]> {
    const context = await waitFor(
        env.events,
        (event): event is ReturnType<typeof WorkContextRequested.create> =>
            WorkContextRequested.is(event) && event.data.storyId === storyId,
    )
    env.deliverSemanticEvent(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: context.data.requestId,
            storyId,
            context: null,
        }),
    )
    const offer = await waitFor(
        env.events,
        (event): event is ReturnType<typeof WorkOffered.create> =>
            WorkOffered.is(event) && event.data.request.storyId === storyId,
    )
    return offer.data
}

async function completeStory(
    env: CapturedEnvironment,
    runId: string,
    offer: ReturnType<typeof WorkOffered.create>["data"],
    leaseId: string,
): Promise<void> {
    const storyId = offer.request.storyId
    env.deliverSemanticEvent(
        source("broker"),
        WorkLeaseGranted.create({
            runId,
            offerId: offer.offerId,
            leaseId,
            workerId: `worker-${storyId}`,
            generation: offer.generation,
            request: offer.request,
        }),
    )
    env.deliverSemanticEvent(
        source(`worker-${storyId}`),
        StoryResult.create({
            runId,
            storyId,
            leaseId,
            generation: offer.generation,
            success: true,
            attempts: 1,
            durationSecs: 1,
            error: null,
        }),
    )
    await waitFor(
        env.events,
        (event): event is ReturnType<typeof StoryIntegrationRequested.create> =>
            StoryIntegrationRequested.is(event) && event.data.storyId === storyId,
    )
    env.deliverSemanticEvent(
        source("repo"),
        StoryMerged.create({
            runId,
            storyId,
            leaseId,
            mode: "worktree",
        }),
    )
    await flush()
}

function readPrd(path: string): PrdFile {
    return JSON.parse(readFileSync(path, "utf8")) as PrdFile
}

async function waitFor<T extends SemanticEvent<unknown>>(
    events: readonly SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
): Promise<T> {
    return (await waitForCount(events, guard, 1))[0]!
}

async function waitForCount<T extends SemanticEvent<unknown>>(
    events: readonly SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const matching = events.filter(guard)
        if (matching.length >= count) return matching
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${count} matching events`)
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
}
