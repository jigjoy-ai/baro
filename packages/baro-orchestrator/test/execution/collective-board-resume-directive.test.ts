import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import type { PrdFile } from "../../src/prd.js"
import { CollectiveBoard } from "../../src/execution/collective-board.js"
import {
    RunPrepared,
    RunStartRequest,
    StoryMerged,
    StoryResult,
    WorkBlockAccepted,
    WorkBlocked,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

const PRESERVED = "baro-recovery/run/S1/1"

describe("CollectiveBoard resume directive", () => {
    it("carries the preserved branch on the re-offer of a host-suspended story", async () => {
        await withTempDir("collective-resume-directive-", async (dir) => {
            const { firstOffer, resumedOffer } = await driveSuspension(dir, PRESERVED)

            assert.equal(firstOffer.payload.request.resume, undefined)
            assert.deepEqual(resumedOffer.payload.request.resume, {
                preservedBranch: PRESERVED,
            })
        })
    })

    it("re-offers with a null preserved branch when no recovery material survived", async () => {
        await withTempDir("collective-resume-directive-empty-", async (dir) => {
            const { resumedOffer } = await driveSuspension(dir, null)

            assert.deepEqual(resumedOffer.payload.request.resume, {
                preservedBranch: null,
            })
        })
    })
})

/**
 * Event-level only: the board never holds a WorktreeManager, so the directive
 * it publishes is the whole of its contribution to the resume path.
 */
async function driveSuspension(
    dir: string,
    preservedBranch: string | null,
): Promise<{
    firstOffer: ReturnType<typeof WorkOffered.create>
    resumedOffer: ReturnType<typeof WorkOffered.create>
}> {
    const runId = "run-resume-directive"
    const prdPath = join(dir, "prd.json")
    writeFileSync(prdPath, JSON.stringify(twoIndependentStories(), null, 2) + "\n")
    const operator = source("operator")
    const repo = source("repo")
    const broker = source("broker")
    const bridge = source("bridge")
    const context = source("context")
    const board = new CollectiveBoard({
        runId,
        prdPath,
        cwd: dir,
        timeoutSecs: 60,
        startAuthority: operator,
        integrationAuthority: repo,
        leaseAuthority: broker,
        dependencyAuthority: bridge,
        dependencySuspensionEnabled: true,
        contextAuthority: context,
    })
    const env = joinWithCapture(board)
    env.publish(operator, RunStartRequest.create({ reason: "test" }))
    env.publish(repo, RunPrepared.create({ runId, baseSha: null }))
    await answerNewContexts(env, context, runId)
    const initialOffers = await waitForCount(env.events, WorkOffered.is, 2)
    const byStory = new Map(
        initialOffers.map((offer) => [offer.payload.request.storyId, offer]),
    )
    for (const storyId of ["S1", "S2"]) {
        const offer = byStory.get(storyId)!
        env.publish(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: offer.payload.offerId,
                leaseId: `lease-${storyId}-1`,
                workerId: "worker",
                generation: offer.payload.generation,
                request: offer.payload.request,
                supportsCooperativeSuspend: true,
            }),
        )
    }

    env.publish(
        bridge,
        WorkBlocked.create({
            runId,
            blockId: "block-S1-S2",
            storyId: "S1",
            leaseId: "lease-S1-1",
            generation: byStory.get("S1")!.payload.generation,
            requiredStoryIds: ["S2"],
            reason: "S2 provides the shared helper",
        }),
    )
    await waitFor(env.events, WorkBlockAccepted.is)
    env.publish(
        source("S1-agent"),
        StoryResult.create({
            runId,
            storyId: "S1",
            leaseId: "lease-S1-1",
            generation: byStory.get("S1")!.payload.generation,
            success: false,
            attempts: 1,
            durationSecs: 3,
            error: "cooperative suspension",
        }),
    )
    env.publish(
        broker,
        WorkLeaseReleased.create({
            runId,
            offerId: byStory.get("S1")!.payload.offerId,
            leaseId: "lease-S1-1",
            storyId: "S1",
            workerId: "worker",
            reason: "dependency_blocked",
            attempts: 1,
            durationSecs: 3,
        }),
    )
    const cleanup = await waitFor(env.events, WorkspaceCleanupRequested.is)
    env.publish(
        repo,
        WorkspaceCleanupCompleted.create({
            runId,
            cleanupId: cleanup.payload.cleanupId,
            storyId: "S1",
            leaseId: "lease-S1-1",
            generation: byStory.get("S1")!.payload.generation,
            ...(preservedBranch ? { preservedBranch } : {}),
        }),
    )

    env.publish(
        source("S2-agent"),
        StoryResult.create({
            runId,
            storyId: "S2",
            leaseId: "lease-S2-1",
            generation: byStory.get("S2")!.payload.generation,
            success: true,
            attempts: 1,
            durationSecs: 2,
            error: null,
        }),
    )
    env.publish(
        repo,
        StoryMerged.create({
            runId,
            storyId: "S2",
            leaseId: "lease-S2-1",
            mode: "worktree",
        }),
    )

    await answerNewContexts(env, context, runId)
    const resumedOffer = (await waitForCount(env.events, WorkOffered.is, 3))[2]!
    assert.equal(resumedOffer.payload.request.storyId, "S1")
    return { firstOffer: byStory.get("S1")!, resumedOffer }
}

function twoIndependentStories(): PrdFile {
    return {
        project: "Resume directive",
        branchName: "baro/resume-directive",
        description: "test",
        userStories: ["S1", "S2"].map((id, index) => ({
            id,
            priority: index + 1,
            title: id,
            description: `Implement ${id}.`,
            dependsOn: [],
            retries: 0,
            acceptance: [`${id} works`],
            tests: [],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: "standard",
        })),
    }
}

async function answerNewContexts(
    env: ReturnType<typeof joinWithCapture>,
    authority: ReturnType<typeof source>,
    runId: string,
): Promise<void> {
    const answered = new Set(
        env.events
            .filter(WorkContextProvided.is)
            .map((event) => event.payload.requestId),
    )
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const requests = env.events
            .filter(WorkContextRequested.is)
            .filter((event) => !answered.has(event.payload.requestId))
        if (requests.length > 0) {
            for (const request of requests) {
                answered.add(request.payload.requestId)
                env.publish(
                    authority,
                    WorkContextProvided.create({
                        runId,
                        requestId: request.payload.requestId,
                        storyId: request.payload.storyId,
                        context: null,
                    }),
                )
            }
            return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail("timed out waiting for work context request")
}

async function waitFor<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
): Promise<T> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const found = events.find(guard)
        if (found) return found
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail("timed out waiting for event")
}

async function waitForCount<T>(
    events: readonly unknown[],
    guard: (event: unknown) => event is T,
    count: number,
): Promise<T[]> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const found = events.filter(guard)
        if (found.length >= count) return found
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`timed out waiting for ${count} events`)
}
