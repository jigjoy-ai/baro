import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { SemanticEvent } from "../../src/runtime/mozaik.js"

import { CollectiveBoard } from "../../src/execution/collective-board.js"
import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    GateRuleAnnounced,
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

describe("CollectiveBoard runtime path claims", () => {
    it("hands a running story free paths at once and tells its lease the new boundary", async () => {
        await withTempDir("board-path-claims-", async (dir) => {
            const runId = "run-path-claims"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(claimPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            const lease = await startAndLeaseFirst(env, runId)
            assert.equal(lease.request.storyId, "S1")
            env.publish(source("factory"), StorySpawned.create({ storyId: "S1" }))
            await board.idle()
            const before = env.events.filter(GateRuleAnnounced.is).length

            const decisions = board.claimPaths("S1", [
                "src/done.ts",
                "src/two.ts",
                "src/new.ts",
                "src/one.ts",
            ])

            assert.deepEqual(decisions, [
                { path: "src/done.ts", outcome: "granted", releasedBy: "S0" },
                { path: "src/two.ts", outcome: "held", ownerStoryId: "S2" },
                { path: "src/new.ts", outcome: "granted" },
                { path: "src/one.ts", outcome: "already_owned" },
            ])
            await board.idle()
            const announced = env.events.filter(GateRuleAnnounced.is)
            assert.equal(announced.length, before + 1)
            const rule = announced.at(-1)!.payload
            assert.equal(rule.storyId, "S1")
            assert.equal(rule.leaseId, lease.leaseId)
            assert.ok((rule.surfaceRevision ?? 0) > 0)
            assert.deepEqual(
                [...(rule.surface?.writes ?? [])].sort(),
                ["src/done.ts", "src/new.ts", "src/one.ts"],
            )
            assert.deepEqual(board.ownerOfPath("src/new.ts"), {
                storyId: "S1",
                integrated: false,
            })
            assert.deepEqual(
                board.ownerOfPath("src/done.ts"),
                { storyId: "S1", integrated: false },
                "the running claimant, not the story that released it",
            )

            assert.deepEqual(board.claimPaths("S1", ["src/new.ts"]), [
                { path: "src/new.ts", outcome: "already_owned" },
            ])
            await board.idle()
            assert.equal(
                env.events.filter(GateRuleAnnounced.is).length,
                before + 1,
                "a claim that changed nothing announces nothing",
            )
        })
    })

    it("refuses claims from a story that is not running", async () => {
        await withTempDir("board-path-claims-", async (dir) => {
            const runId = "run-path-claims-idle"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(claimPrd(), null, 2) + "\n")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                unsafeAllowUnboundRuntimeReplanAuthority: true,
            })
            const env = joinWithCapture(board)
            await startAndLeaseFirst(env, runId)

            assert.equal(board.claimPaths("S2", ["src/new.ts"])[0]!.outcome, "refused")
            assert.equal(board.ownerOfPath("src/new.ts"), null)
        })
    })
})

function claimPrd(): PrdFile {
    return {
        project: "path claims",
        branchName: "baro/path-claims",
        description: "Exercise runtime path claims.",
        userStories: [
            story("S0", [], ["src/done.ts"], true),
            story("S1", ["S0"], ["src/one.ts"]),
            story("S2", ["S1"], ["src/two.ts"]),
        ],
    }
}

function story(
    id: string,
    dependsOn: string[],
    writes: string[],
    passes = false,
): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) + 1,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes,
        completedAt: passes ? new Date(0).toISOString() : null,
        durationSecs: passes ? 1 : null,
        model: "standard",
        writes,
    } as PrdStory
}

async function startAndLeaseFirst(env: CapturedEnvironment, runId: string) {
    env.publish(source("operator"), RunStartRequest.create({ reason: "test" }))
    env.publish(source("repo"), RunPrepared.create({ runId, baseSha: null }))
    const context = await waitFor(env.events, WorkContextRequested.is)
    env.publish(
        source("context"),
        WorkContextProvided.create({
            runId,
            requestId: context.payload.requestId,
            storyId: context.payload.storyId,
            context: null,
        }),
    )
    const offer = await waitFor(env.events, WorkOffered.is)
    const lease = {
        runId,
        offerId: offer.payload.offerId,
        leaseId: `${runId}:lease:1`,
        workerId: "worker",
        generation: offer.payload.generation,
        request: offer.payload.request,
    }
    env.publish(source("broker"), WorkLeaseGranted.create(lease))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return lease
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
