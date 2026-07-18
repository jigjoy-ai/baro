import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { PrdFile, PrdStory } from "../../src/prd.js"
import { CollectiveBoard } from "../../src/participants/collective-board.js"
import {
    ConductorState,
    RecoveryDecision,
    Replan,
    RunPrepared,
    RunPushRequested,
    RunStartRequest,
    RuntimeReplanApplied,
    StoryIntegrationRequested,
    StoryMerged,
    StoryResult,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import {
    joinWithCapture,
    source,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

describe("CollectiveBoard policy replan batching", () => {
    it("applies four sibling rewires as one healing cycle and schedules their prerequisite", async () => {
        await withTempDir("collective-policy-batch-", async (dir) => {
            const runId = "run-policy-batch"
            const prdPath = join(dir, "prd.json")
            const siblingIds = ["S6", "S7", "S8", "S9"]
            writeFileSync(
                prdPath,
                JSON.stringify(siblingRewirePrd(siblingIds), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
                replanProgressBudget: 3,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )

            const firstWaveContexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                5,
            )
            for (const request of firstWaveContexts) {
                provideContext(env, runId, request)
            }
            const firstWaveOffers = await waitForCount(
                env.events,
                WorkOffered.is,
                5,
            )
            const offersByStory = new Map(
                firstWaveOffers.map((offer) => [
                    offer.data.request.storyId,
                    offer,
                ]),
            )
            for (const offer of firstWaveOffers) {
                const storyId = offer.data.request.storyId
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId: `lease-${storyId}`,
                        workerId: `worker-${storyId}`,
                        generation: offer.data.generation,
                        request: offer.data.request,
                    }),
                )
            }

            const prerequisite = offersByStory.get("S10")!
            env.deliverSemanticEvent(
                source("worker-S10"),
                result(
                    runId,
                    "S10",
                    "lease-S10",
                    prerequisite.data.generation,
                    true,
                ),
            )
            await waitFor(env.events, StoryIntegrationRequested.is)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S10",
                    leaseId: "lease-S10",
                    mode: "worktree",
                }),
            )

            // Continuous scheduling admits S11 as soon as S10 integrates;
            // unrelated failing siblings no longer impose a wave barrier.
            const prerequisiteContext = (
                await waitForCount(env.events, WorkContextRequested.is, 6)
            )[5]!
            assert.equal(prerequisiteContext.data.storyId, "S11")
            provideContext(env, runId, prerequisiteContext)
            const prerequisiteOffer = (
                await waitForCount(env.events, WorkOffered.is, 6)
            )[5]!
            assert.equal(prerequisiteOffer.data.request.storyId, "S11")
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: prerequisiteOffer.data.offerId,
                    leaseId: "lease-S11",
                    workerId: "worker-S11",
                    generation: prerequisiteOffer.data.generation,
                    request: prerequisiteOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S11"),
                result(
                    runId,
                    "S11",
                    "lease-S11",
                    prerequisiteOffer.data.generation,
                    true,
                ),
            )
            const integrations = await waitForCount(
                env.events,
                StoryIntegrationRequested.is,
                2,
            )
            assert.equal(integrations[1]?.data.storyId, "S11")
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S11",
                    leaseId: "lease-S11",
                    mode: "worktree",
                }),
            )

            for (const [index, storyId] of siblingIds.entries()) {
                const offer = offersByStory.get(storyId)!
                const leaseId = `lease-${storyId}`
                env.deliverSemanticEvent(
                    source(`worker-${storyId}`),
                    result(
                        runId,
                        storyId,
                        leaseId,
                        offer.data.generation,
                        false,
                    ),
                )
                const cleanup = (
                    await waitForCount(
                        env.events,
                        WorkspaceCleanupRequested.is,
                        index + 1,
                    )
                )[index]!
                env.deliverSemanticEvent(
                    source("surgeon"),
                    Replan.create({
                        source: `surgeon:${storyId}`,
                        reason: `${storyId} requires the iterator prerequisite`,
                        recovery: {
                            runId,
                            storyId,
                            leaseId,
                            generation: offer.data.generation,
                        },
                        addedStories: [],
                        removedStoryIds: [],
                        modifiedDeps: { [storyId]: ["S11"] },
                    }),
                )
                env.deliverSemanticEvent(
                    source("surgeon"),
                    RecoveryDecision.create({
                        runId,
                        storyId,
                        source: `surgeon:${storyId}`,
                        action: "replan",
                        reason: `${storyId} requires the iterator prerequisite`,
                    }),
                )
                env.deliverSemanticEvent(
                    source("repo"),
                    WorkspaceCleanupCompleted.create({ ...cleanup.data }),
                )
            }

            const applied = await waitForCount(
                env.events,
                RuntimeReplanApplied.is,
                4,
            )
            assert.deepEqual(
                applied.map((event) => event.data.graphVersion),
                [2, 3, 4, 5],
            )

            const persisted = readPrd(prdPath)
            for (const storyId of siblingIds) {
                assert.deepEqual(
                    persisted.userStories.find((story) => story.id === storyId)
                        ?.dependsOn,
                    ["S11"],
                )
            }

            const healingEvents = env.events
                .filter(ConductorState.is)
                .filter((event) => /healing action/.test(event.data.detail ?? ""))
            assert.equal(healingEvents.length, 2)
            assert.match(healingEvents[0]?.data.detail ?? "", /1\/3/)
            assert.match(healingEvents[1]?.data.detail ?? "", /2\/3/)
            assert.equal(env.events.some(RunPushRequested.is), false)
        })
    })

    it("admits a policy-added dependent into its prerequisite's live wave", async () => {
        await withTempDir("collective-policy-live-admission-", async (dir) => {
            const runId = "run-policy-live-admission"
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify(singleStoryPrd("S1"), null, 2) + "\n",
            )
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                expectRecoveryDecisions: true,
            })
            const env = joinWithCapture(board)

            env.deliverSemanticEvent(
                source("operator"),
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                RunPrepared.create({ runId, baseSha: null }),
            )
            const originalContext = await waitFor(
                env.events,
                WorkContextRequested.is,
            )
            provideContext(env, runId, originalContext)
            const originalOffer = await waitFor(env.events, WorkOffered.is)
            env.deliverSemanticEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId,
                    offerId: originalOffer.data.offerId,
                    leaseId: "lease-S1",
                    workerId: "worker-S1",
                    generation: originalOffer.data.generation,
                    request: originalOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("worker-S1"),
                result(
                    runId,
                    "S1",
                    "lease-S1",
                    originalOffer.data.generation,
                    false,
                ),
            )
            const cleanup = await waitFor(
                env.events,
                WorkspaceCleanupRequested.is,
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon:S1",
                    reason: "split cancellation primitives while keeping a peer busy",
                    recovery: {
                        runId,
                        storyId: "S1",
                        leaseId: "lease-S1",
                        generation: originalOffer.data.generation,
                    },
                    removedStoryIds: ["S1"],
                    modifiedDeps: {},
                    addedStories: [
                        replacement("S10", []),
                        replacement("S11", ["S10"]),
                        replacement("SP", []),
                    ],
                }),
            )
            env.deliverSemanticEvent(
                source("surgeon"),
                RecoveryDecision.create({
                    runId,
                    storyId: "S1",
                    source: "surgeon:S1",
                    action: "replan",
                    reason: "split cancellation primitives while keeping a peer busy",
                }),
            )
            env.deliverSemanticEvent(
                source("repo"),
                WorkspaceCleanupCompleted.create({ ...cleanup.data }),
            )

            await waitFor(env.events, RuntimeReplanApplied.is)
            const nextContexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                3,
            )
            for (const request of nextContexts.slice(1)) {
                provideContext(env, runId, request)
            }
            const nextOffers = await waitForCount(env.events, WorkOffered.is, 3)
            const s10Offer = nextOffers.find(
                (offer) => offer.data.request.storyId === "S10",
            )!
            const peerOffer = nextOffers.find(
                (offer) => offer.data.request.storyId === "SP",
            )!
            for (const offer of [s10Offer, peerOffer]) {
                const storyId = offer.data.request.storyId
                env.deliverSemanticEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId: `lease-${storyId}`,
                        workerId: `worker-${storyId}`,
                        generation: offer.data.generation,
                        request: offer.data.request,
                    }),
                )
            }

            env.deliverSemanticEvent(
                source("worker-S10"),
                result(
                    runId,
                    "S10",
                    "lease-S10",
                    s10Offer.data.generation,
                    true,
                ),
            )
            await waitForCount(env.events, StoryIntegrationRequested.is, 1)
            env.deliverSemanticEvent(
                source("repo"),
                StoryMerged.create({
                    runId,
                    storyId: "S10",
                    leaseId: "lease-S10",
                    mode: "worktree",
                }),
            )

            const admitted = (
                await waitForCount(env.events, WorkContextRequested.is, 4)
            )[3]!
            assert.equal(admitted.data.storyId, "S11")
            assert.equal(
                env.events.some((event) => event.type === "level_completed"),
                true,
                "only the original failed wave has completed; SP keeps the current wave open",
            )
            assert.equal(
                env.events.filter(
                    (event) =>
                        event.type === "level_completed" &&
                        (event as { data?: { ordinal?: number } }).data?.ordinal === 2,
                ).length,
                0,
            )
        })
    })
})

function siblingRewirePrd(siblingIds: readonly string[]): PrdFile {
    return {
        project: "Policy replan batch",
        branchName: "baro/policy-replan-batch",
        description: "Exercise sibling recovery at one safe boundary.",
        userStories: [
            story("S10", 1, []),
            ...siblingIds.map((id, index) => story(id, index + 2, [])),
            story("S11", siblingIds.length + 2, ["S10"]),
        ],
    }
}

function singleStoryPrd(id: string): PrdFile {
    return {
        project: "Policy live admission",
        branchName: "baro/policy-live-admission",
        description: "Exercise policy-added runtime readiness.",
        userStories: [story(id, 1, [])],
    }
}

function story(id: string, priority: number, dependsOn: readonly string[]): PrdStory {
    return {
        id,
        priority,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
    }
}

function replacement(id: string, dependsOn: readonly string[]) {
    return {
        id,
        priority: id === "S10" ? 1 : id === "SP" ? 2 : 3,
        title: `Replacement ${id}`,
        description: `Implement replacement ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: ["npm test"],
        model: "standard",
    }
}

function result(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
    success: boolean,
) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success,
        attempts: 1,
        durationSecs: 1,
        error: success ? null : "missing iterator prerequisite",
    })
}

function provideContext(
    env: CapturedEnvironment,
    runId: string,
    request: ReturnType<typeof WorkContextRequested.create>,
): void {
    env.deliverSemanticEvent(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: request.data.requestId,
            storyId: request.data.storyId,
            context: null,
        }),
    )
}

function readPrd(path: string): PrdFile {
    return JSON.parse(readFileSync(path, "utf8")) as PrdFile
}

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    return (await waitForCount(events, guard, 1))[0]!
}

async function waitForCount<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail(`timed out waiting for ${count} events`)
}
