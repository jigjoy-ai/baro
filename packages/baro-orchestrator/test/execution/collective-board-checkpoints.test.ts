import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { SemanticEvent } from "../../src/runtime/mozaik.js"

import { CollectiveBoard } from "../../src/execution/collective-board.js"
import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    ConductorState,
    RunPrepared,
    RunStartRequest,
    StoryCheckpointDecided,
    StoryCheckpointRequested,
    StoryCheckpointWithdrawn,
    StoryIntegrationRequested,
    StoryMerged,
    StoryResult,
    WorkContextProvided,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
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

const RUN = "run-checkpoints"
const SHA = "c".repeat(40)

// The hermes-baro run: S2 and S3 waited 21 minutes for S1 to integrate, but
// needed only its parser contract and fixtures, committed after about six.
describe("CollectiveBoard checkpoints", () => {
    it("starts dependents on a running story's checkpoint and integrates them after it", async () => {
        await withBoard(async (env, board) => {
            const s1 = await leaseStory(env, "S1", 1)
            assert.equal(s1.request.sessionSource, undefined, "a story with no prerequisite starts cold")
            assert.equal(s1.request.mayDelegate, undefined, "a planned story does not re-plan the goal")

            requestCheckpoint(env, s1, [])
            assert.match(
                (await nthDecision(env, 1)).reason,
                /nothing is committed beyond your base/,
            )
            requestCheckpoint(env, s1, ["src/board.ts"])
            assert.match(
                (await nthDecision(env, 2)).reason,
                /outside your surface \(src\/board\.ts\)/,
            )

            requestCheckpoint(env, s1, ["src/contract.ts"])
            const published = await nthDecision(env, 3)
            assert.equal(published.outcome, "published")
            assert.deepEqual([...published.admitted].sort(), ["S2", "S3"])

            const s2 = await leaseStory(env, "S2", 2)
            assert.deepEqual(s2.request.checkpointBase, [{ storyId: "S1", sha: SHA }])
            // It forks the session of the story whose checkpoint it starts on.
            assert.deepEqual(s2.request.sessionSource, { storyId: "S1", mode: "fork" })
            assert.match(s2.request.prompt, /You start on checkpoints/)
            assert.match(s2.request.prompt, /S1 is still running; it published c{12}: parser contract/)

            env.publish(source("S2"), pass("S2", s2))
            await waitForDetail(env, /S2 is accepted and integrates after S1/)
            assert.equal(integrationsOf(env, "S2"), 0, "S2 must not integrate before S1")

            env.publish(source("S1"), pass("S1", s1))
            await waitFor(env.events, (e): e is ReturnType<typeof StoryIntegrationRequested.create> =>
                StoryIntegrationRequested.is(e) && e.payload.storyId === "S1")
            assert.equal(integrationsOf(env, "S2"), 0)
            env.publish(
                source("repo"),
                StoryMerged.create({ storyId: "S1", mode: "worktree", runId: RUN, leaseId: s1.leaseId }),
            )
            await waitFor(env.events, (e): e is ReturnType<typeof StoryIntegrationRequested.create> =>
                StoryIntegrationRequested.is(e) && e.payload.storyId === "S2")
            await board.idle()
        })
    })

    it("lets the run's only story hand parts to stories it adds", async () => {
        await withBoard(async (env, board) => {
            const lead = await leaseStory(env, "S1", 1)
            assert.equal(lead.request.mayDelegate, true)
            assert.equal(lead.request.sessionSource, undefined)
            await board.idle()
        }, {
            ...checkpointPrd(),
            executionMode: { mode: "focused", source: "user", reason: "quick" },
            userStories: [story("S1", [], ["src/a.ts"])],
        } as PrdFile)
    })

    it("does not offer that to the first story of a plan that is not focused", async () => {
        await withBoard(async (env, board) => {
            assert.equal((await leaseStory(env, "S1", 1)).request.mayDelegate, undefined)
            await board.idle()
        }, { ...checkpointPrd(), userStories: [story("S1", [], ["src/a.ts"])] })
    })

    it("withdraws the checkpoint when its story fails, and retries finished early starters", async () => {
        await withBoard(async (env, board) => {
            const s1 = await leaseStory(env, "S1", 1)
            requestCheckpoint(env, s1, ["src/contract.ts"])
            await nthDecision(env, 1)
            const s2 = await leaseStory(env, "S2", 2)
            env.publish(source("S2"), pass("S2", s2))
            await waitForDetail(env, /S2 is accepted and integrates after S1/)

            env.publish(source("S1"), fail("S1", s1))

            const withdrawn = await waitFor(env.events, StoryCheckpointWithdrawn.is)
            assert.equal(withdrawn.payload.storyId, "S1")
            assert.deepEqual(withdrawn.payload.affected, ["S2"])
            await waitForDetail(env, /S2 failed: started on S1's checkpoint, which was withdrawn/)
            assert.equal(integrationsOf(env, "S2"), 0)
            await board.idle()
        })
    })

    // Run 3 of the hermes-baro goal stalled for an hour: a held early starter
    // kept the wave pending while the prerequisite it waited on needed exactly
    // that wave to close to be retried.
    it("never lets a held early starter keep its wave open", async () => {
        await withBoard(async (env, board) => {
            const s1 = await leaseStory(env, "S1", 1)
            requestCheckpoint(env, s1, ["src/contract.ts"])
            await nthDecision(env, 1)
            const s2 = await leaseStory(env, "S2", 2)
            env.publish(source("S2"), pass("S2", s2))
            await waitForDetail(env, /S2 is accepted and integrates after S1/)

            env.publish(source("S1"), fail("S1", s1))
            // The repository finishes the failed attempts' cleanups.
            const cleanups = await waitForCount(env.events, WorkspaceCleanupRequested.is, 2)
            for (const cleanup of cleanups) {
                env.publish(
                    source("repo"),
                    WorkspaceCleanupCompleted.create({
                        runId: RUN,
                        cleanupId: cleanup.payload.cleanupId,
                        storyId: cleanup.payload.storyId,
                        leaseId: cleanup.payload.leaseId,
                        generation: cleanup.payload.generation,
                    }),
                )
            }

            // S2 retries from the run branch, S3 waits for real integration,
            // and S1 gets its recovery attempt: no wave waits on itself.
            const s1Contexts = () =>
                env.events.filter((x) => WorkContextRequested.is(x) && x.payload.storyId === "S1").length
            const deadline = Date.now() + 2_000
            while (s1Contexts() < 2 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5))
            }
            assert.equal(s1Contexts(), 2, "S1's recovery attempt was offered")
            await board.idle()
        })
    })

    it("does not start a story on a checkpoint from a stale lease", async () => {
        await withBoard(async (env) => {
            const s1 = await leaseStory(env, "S1", 1)
            requestCheckpoint(env, { ...s1, leaseId: "lease-old" }, ["src/contract.ts"])
            const decision = await nthDecision(env, 1)
            assert.equal(decision.outcome, "refused")
            assert.equal(env.events.filter(WorkContextRequested.is).length, 1)
        })
    })
})

type Lease = {
    leaseId: string
    generation: number
    request: ReturnType<typeof WorkOffered.create>["payload"]["request"]
}

async function withBoard(
    run: (env: CapturedEnvironment, board: CollectiveBoard) => Promise<void>,
    prd: PrdFile = checkpointPrd(),
): Promise<void> {
    await withTempDir("board-checkpoints-", async (dir) => {
        const prdPath = join(dir, "prd.json")
        writeFileSync(prdPath, JSON.stringify(prd, null, 2) + "\n")
        const board = new CollectiveBoard({
            runId: RUN,
            prdPath,
            cwd: dir,
            timeoutSecs: 60,
            defaultModel: "standard",
        })
        const env = joinWithCapture(board)
        env.publish(source("operator"), RunStartRequest.create({ reason: "test" }))
        env.publish(source("repo"), RunPrepared.create({ runId: RUN, baseSha: null }))
        await run(env, board)
    })
}

async function leaseStory(
    env: CapturedEnvironment,
    storyId: string,
    ordinal: number,
): Promise<Lease> {
    const request = await waitFor(env.events, (e): e is ReturnType<typeof WorkContextRequested.create> =>
        WorkContextRequested.is(e) && e.payload.storyId === storyId)
    env.publish(
        source("context"),
        WorkContextProvided.create({
            runId: RUN,
            requestId: request.payload.requestId,
            storyId,
            context: null,
        }),
    )
    const offer = await waitFor(env.events, (e): e is ReturnType<typeof WorkOffered.create> =>
        WorkOffered.is(e) && e.payload.request.storyId === storyId)
    const lease = {
        leaseId: `lease-${ordinal}`,
        generation: offer.payload.generation,
        request: offer.payload.request,
    }
    env.publish(
        source("broker"),
        WorkLeaseGranted.create({
            runId: RUN,
            offerId: offer.payload.offerId,
            leaseId: lease.leaseId,
            workerId: "worker",
            generation: lease.generation,
            request: offer.payload.request,
        }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return lease
}

function requestCheckpoint(env: CapturedEnvironment, lease: Lease, changedPaths: string[]): void {
    env.publish(
        source("bridge"),
        StoryCheckpointRequested.create({
            runId: RUN,
            storyId: "S1",
            leaseId: lease.leaseId,
            generation: lease.generation,
            sha: SHA,
            changedPaths,
            reason: "parser contract and fixtures",
        }),
    )
}

async function nthDecision(env: CapturedEnvironment, n: number) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        const decisions = env.events.filter(StoryCheckpointDecided.is)
        if (decisions.length >= n) return decisions[n - 1]!.payload
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
    }
    assert.fail(`timed out waiting for checkpoint decision ${n}`)
}

function integrationsOf(env: CapturedEnvironment, storyId: string): number {
    return env.events.filter(
        (e) => StoryIntegrationRequested.is(e) && e.payload.storyId === storyId,
    ).length
}

async function waitForDetail(env: CapturedEnvironment, pattern: RegExp): Promise<void> {
    await waitFor(env.events, (e): e is ReturnType<typeof ConductorState.create> =>
        ConductorState.is(e) && pattern.test(e.payload.detail ?? ""))
}

function pass(storyId: string, lease: Lease) {
    return result(storyId, lease, true)
}

function fail(storyId: string, lease: Lease) {
    return result(storyId, lease, false)
}

function result(storyId: string, lease: Lease, success: boolean) {
    return StoryResult.create({
        runId: RUN,
        storyId,
        leaseId: lease.leaseId,
        generation: lease.generation,
        success,
        attempts: 1,
        durationSecs: 2,
        error: success ? null : "failed",
    })
}

function checkpointPrd(): PrdFile {
    return {
        project: "checkpoints",
        branchName: "baro/checkpoints",
        description: "Exercise checkpoints.",
        userStories: [
            story("S1", [], ["src/contract.ts", "src/parser.ts"]),
            story("S2", ["S1"], ["src/board.ts"]),
            story("S3", ["S1"], ["src/tools.ts"]),
        ],
    }
}

function story(id: string, dependsOn: string[], writes: string[]): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")),
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 0,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        writes,
    } as PrdStory
}

async function waitFor<T extends SemanticEvent<string, unknown>>(
    events: SemanticEvent<string, unknown>[],
    guard: (event: SemanticEvent<string, unknown>) => event is T,
): Promise<T> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        const match = events.find(guard)
        if (match) return match
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
    }
    assert.fail("timed out waiting for event")
}

async function waitForCount<T extends SemanticEvent<string, unknown>>(
    events: SemanticEvent<string, unknown>[],
    guard: (event: SemanticEvent<string, unknown>) => event is T,
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
