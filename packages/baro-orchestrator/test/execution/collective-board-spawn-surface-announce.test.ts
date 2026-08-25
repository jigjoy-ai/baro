import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { SemanticEvent } from "../../src/runtime/mozaik.js"

import { CollectiveBoard } from "../../src/execution/collective-board.js"
import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    GateRuleAnnounced,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RunPrepared,
    RunStartRequest,
    StorySpawned,
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

describe("CollectiveBoard write-surface re-announcement at spawn", () => {
    it("re-announces to the lease when a decision revised its surface before the worker existed", async () => {
        await withTempDir("board-spawn-surface-", async (dir) => {
            const runId = "run-spawn-surface-changed"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(spawnPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            const lease = await startAndLeaseFirst(env, runId)
            assert.deepEqual(lease.request.surface?.writes, ["src/one.ts"])

            // The decision lands while the factory is still starting the
            // process, so announceRevisedSurfaces reaches nobody.
            env.deliverSemanticEvent(
                source("S1"),
                RuntimeReplanProposed.create({
                    runId,
                    proposalId: "proposal-spawn-window",
                    sourceStoryId: "S1",
                    leaseId: lease.leaseId,
                    generation: lease.generation,
                    baseGraphVersion: 1,
                    reason: "a shared helper surfaced mid-story",
                    mutation: {
                        addedStories: [
                            { ...dynamicStory("S1b", ["S1"]), writes: ["src/shared.ts"] },
                        ],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    },
                }),
            )
            const applied = await waitFor(env.events, RuntimeReplanApplied.is)
            assert.equal(applied.data.graphVersion, 2)
            // Emitted before the worker process existed, so it reached nobody:
            // StoryAgent only applies a revision once its surface is live.
            assert.equal(env.events.filter(GateRuleAnnounced.is).length, 1)

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S1" }),
            )
            await board.idle()

            const announced = env.events.filter(GateRuleAnnounced.is)
            assert.equal(
                announced.length,
                2,
                "the spawn re-announces the revision the worker could not hear",
            )
            const spawnAnnounce = announced.at(-1)!
            assert.equal(spawnAnnounce.data.runId, runId)
            assert.equal(spawnAnnounce.data.storyId, "S1")
            assert.equal(spawnAnnounce.data.leaseId, lease.leaseId)
            assert.equal(spawnAnnounce.data.generation, lease.generation)
            assert.equal(spawnAnnounce.data.gateId, "write-surface")
            assert.equal(spawnAnnounce.data.graphVersion, 2)
            assert.deepEqual(spawnAnnounce.data.surface?.writes, ["src/one.ts"])
            assert.equal(
                spawnAnnounce.data.surface?.ownedElsewhere["src/shared.ts"],
                "S1b",
            )

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S1" }),
            )
            await board.idle()
            assert.equal(
                env.events.filter(GateRuleAnnounced.is).length,
                2,
                "a repeated spawn for the same key announces nothing further",
            )

            // Once the worker is live it hears decisions directly, so a later
            // revision must not be replayed by a stray spawn observation.
            env.deliverSemanticEvent(
                source("S1"),
                RuntimeReplanProposed.create({
                    runId,
                    proposalId: "proposal-after-spawn",
                    sourceStoryId: "S1",
                    leaseId: lease.leaseId,
                    generation: lease.generation,
                    baseGraphVersion: 2,
                    reason: "a second helper surfaced",
                    mutation: {
                        addedStories: [
                            { ...dynamicStory("S1c", ["S1"]), writes: ["src/other.ts"] },
                        ],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    },
                }),
            )
            await waitForCount(env.events, RuntimeReplanApplied.is, 2)
            await board.idle()
            assert.equal(env.events.filter(GateRuleAnnounced.is).length, 3)

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S1" }),
            )
            await board.idle()
            assert.equal(
                env.events.filter(GateRuleAnnounced.is).length,
                3,
                "a spawn after the worker is live re-announces nothing",
            )
        })
    })

    it("stays silent at spawn when no decision changed the granted surface", async () => {
        await withTempDir("board-spawn-surface-", async (dir) => {
            const runId = "run-spawn-surface-unchanged"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(spawnPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            const lease = await startAndLeaseFirst(env, runId)
            assert.deepEqual(lease.request.surface?.writes, ["src/one.ts"])
            assert.equal(env.events.filter(GateRuleAnnounced.is).length, 0)

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S1" }),
            )
            await board.idle()

            assert.equal(
                env.events.filter(GateRuleAnnounced.is).length,
                0,
                "an unchanged surface key is not re-announced at spawn",
            )
        })
    })

    it("announces at spawn when the grant itself handed out a superseded surface", async () => {
        await withTempDir("board-spawn-surface-", async (dir) => {
            const runId = "run-spawn-surface-stale-grant"
            const prdPath = join(dir, "prd.json")
            const input = spawnPrd()
            // Both stories are ready at once, so S2 still holds an open offer
            // — and no lease record — while S1's decision is applied.
            input.userStories[1]!.dependsOn = []
            writeFileSync(prdPath, JSON.stringify(input, null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            const first = await startAndLeaseFirst(env, runId)
            for (const context of env.events.filter(WorkContextRequested.is)) {
                if (context.data.storyId === first.request.storyId) continue
                env.deliverSemanticEvent(
                    source("context"),
                    WorkContextProvided.create({
                        runId,
                        requestId: context.data.requestId,
                        storyId: context.data.storyId,
                        context: null,
                    }),
                )
            }
            await board.idle()
            const offer = env.events
                .filter(WorkOffered.is)
                .find((event) => event.data.request.storyId === "S2")!
            assert.ok(offer, "S2 holds an open offer")

            env.deliverSemanticEvent(
                source("S1"),
                RuntimeReplanProposed.create({
                    runId,
                    proposalId: "proposal-stale-grant",
                    sourceStoryId: "S1",
                    leaseId: first.leaseId,
                    generation: first.generation,
                    baseGraphVersion: 1,
                    reason: "a shared helper surfaced mid-story",
                    mutation: {
                        addedStories: [
                            { ...dynamicStory("S1b", ["S1"]), writes: ["src/shared.ts"] },
                        ],
                        removedStoryIds: [],
                        modifiedDeps: {},
                    },
                }),
            )
            await waitFor(env.events, RuntimeReplanApplied.is)
            await board.idle()
            const announcedForS2 = () =>
                env.events
                    .filter(GateRuleAnnounced.is)
                    .filter((event) => event.data.storyId === "S2")
            assert.equal(
                announcedForS2().length,
                0,
                "a story with no lease yet is not announced to",
            )

            const lease = {
                runId,
                offerId: offer.data.offerId,
                leaseId: `${runId}:lease:2`,
                workerId: "worker-2",
                generation: offer.data.generation,
                request: offer.data.request,
            }
            env.deliverSemanticEvent(source("broker"), WorkLeaseGranted.create(lease))
            await board.idle()
            assert.equal(announcedForS2().length, 0)

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S2" }),
            )
            await board.idle()

            const announced = announcedForS2()
            assert.equal(announced.length, 1)
            assert.equal(announced[0]!.data.leaseId, lease.leaseId)
            assert.equal(announced[0]!.data.generation, lease.generation)
            assert.equal(announced[0]!.data.graphVersion, 2)
            assert.equal(
                announced[0]!.data.surface?.ownedElsewhere["src/shared.ts"],
                "S1b",
            )
        })
    })

    it("ignores a spawn for a story this board holds no lease for", async () => {
        await withTempDir("board-spawn-surface-", async (dir) => {
            const runId = "run-spawn-surface-unleased"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(spawnPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            await startAndLeaseFirst(env, runId)

            env.deliverSemanticEvent(
                source("factory"),
                StorySpawned.create({ storyId: "S2" }),
            )
            await board.idle()

            assert.equal(env.events.filter(GateRuleAnnounced.is).length, 0)
        })
    })
})

function spawnPrd(): PrdFile {
    return {
        project: "spawn surface announcement",
        branchName: "baro/spawn-surface-announce",
        description: "Exercise the grant-to-spawn window.",
        userStories: [
            story("S1", [], ["src/one.ts"]),
            story("S2", ["S1"], ["src/two.ts"]),
        ],
    }
}

function story(id: string, dependsOn: string[], writes: string[]): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
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
        writes,
    } as PrdStory
}

function dynamicStory(id: string, dependsOn: string[]) {
    return {
        id,
        priority: 10,
        title: `Dynamic ${id}`,
        description: `Implement dynamically discovered ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: ["npm test"],
        model: "standard",
    }
}

async function startAndLeaseFirst(env: CapturedEnvironment, runId: string) {
    env.deliverSemanticEvent(
        source("operator"),
        RunStartRequest.create({ reason: "test" }),
    )
    env.deliverSemanticEvent(
        source("repo"),
        RunPrepared.create({ runId, baseSha: null }),
    )
    const context = await waitFor(env.events, WorkContextRequested.is)
    env.deliverSemanticEvent(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: context.data.requestId,
            storyId: context.data.storyId,
            context: null,
        }),
    )
    const offer = await waitFor(env.events, WorkOffered.is)
    const lease = {
        runId,
        offerId: offer.data.offerId,
        leaseId: `${runId}:lease:1`,
        workerId: "worker",
        generation: offer.data.generation,
        request: offer.data.request,
    }
    env.deliverSemanticEvent(source("broker"), WorkLeaseGranted.create(lease))
    await flush()
    return lease
}

async function waitFor<T extends SemanticEvent<unknown>>(
    events: SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
): Promise<T> {
    return (await waitForCount(events, guard, 1))[0]!
}

async function waitForCount<T extends SemanticEvent<unknown>>(
    events: SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
    count: number,
): Promise<T[]> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        const matches = events.filter(guard)
        if (matches.length >= count) return matches
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
    }
    assert.fail(`timed out waiting for ${count} events`)
}

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
