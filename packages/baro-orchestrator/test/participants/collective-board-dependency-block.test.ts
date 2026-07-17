import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { PrdFile } from "../../src/prd.js"
import { CollectiveBoard } from "../../src/participants/collective-board.js"
import {
    ConductorState,
    LevelCompleted,
    RunPrepared,
    RunPushed,
    RunPushRequested,
    RunStartRequest,
    RuntimeReplanApplied,
    StoryMerged,
    StoryResult,
    WorkBlockAccepted,
    WorkBlocked,
    WorkBlockRejected,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkLeaseExpired,
    WorkLeaseReleased,
    WorkOffered,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("CollectiveBoard dependency suspension", () => {
    it("durably rewires, preserves, and resumes a blocked story without recovery failure", async () => {
        await withTempDir("collective-dependency-block-", async (dir) => {
            const runId = "run-dependency-block"
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
            env.deliverSemanticEvent(
                operator,
                RunStartRequest.create({ reason: "test" }),
            )
            env.deliverSemanticEvent(
                repo,
                RunPrepared.create({ runId, baseSha: null }),
            )
            await answerNewContexts(env, context, runId)
            const initialOffers = await waitForCount(env.events, WorkOffered.is, 2)
            const byStory = new Map(
                initialOffers.map((offer) => [offer.data.request.storyId, offer]),
            )
            for (const storyId of ["S1", "S2"]) {
                const offer = byStory.get(storyId)!
                env.deliverSemanticEvent(
                    broker,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: offer.data.offerId,
                        leaseId: `lease-${storyId}-1`,
                        workerId: "worker",
                        generation: offer.data.generation,
                        request: offer.data.request,
                        supportsCooperativeSuspend: true,
                    }),
                )
            }

            env.deliverSemanticEvent(
                bridge,
                WorkBlocked.create({
                    runId,
                    blockId: "block-S1-S2",
                    storyId: "S1",
                    leaseId: "lease-S1-1",
                    generation: byStory.get("S1")!.data.generation,
                    requiredStoryIds: ["S2"],
                    reason: "S2 provides the shared helper",
                }),
            )
            const accepted = await waitFor(env.events, WorkBlockAccepted.is)
            assert.equal(accepted.data.graphVersion, 2)
            assert.equal(env.events.filter(RuntimeReplanApplied.is).length, 1)
            let saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.deepEqual(
                saved.userStories.find((story) => story.id === "S1")?.dependsOn,
                ["S2"],
            )

            // A late abort result is expected process-quiescence evidence for
            // Broker, not an execution failure for Board/Surgeon policy.
            env.deliverSemanticEvent(
                source("S1-agent"),
                StoryResult.create({
                    runId,
                    storyId: "S1",
                    leaseId: "lease-S1-1",
                    generation: byStory.get("S1")!.data.generation,
                    success: false,
                    attempts: 1,
                    durationSecs: 3,
                    error: "cooperative suspension",
                }),
            )
            const dependencyRelease = {
                runId,
                offerId: byStory.get("S1")!.data.offerId,
                leaseId: "lease-S1-1",
                storyId: "S1",
                workerId: "worker",
                reason: "dependency_blocked" as const,
                // Forward-compatible Board accounting while Broker/event
                // schema rollout happens in parallel.
                attempts: 1,
                durationSecs: 3,
            }
            env.deliverSemanticEvent(
                broker,
                WorkLeaseReleased.create(dependencyRelease),
            )
            const cleanup = await waitFor(
                env.events,
                WorkspaceCleanupRequested.is,
            )
            assert.equal(cleanup.data.preserveForRecovery, true)
            env.deliverSemanticEvent(
                repo,
                WorkspaceCleanupCompleted.create({
                    runId,
                    cleanupId: cleanup.data.cleanupId,
                    storyId: "S1",
                    leaseId: "lease-S1-1",
                    generation: byStory.get("S1")!.data.generation,
                    preservedBranch: "baro-recovery/run/S1/1",
                }),
            )

            env.deliverSemanticEvent(
                source("S2-agent"),
                success(runId, "S2", "lease-S2-1", byStory.get("S2")!.data.generation),
            )
            env.deliverSemanticEvent(
                repo,
                StoryMerged.create({
                    runId,
                    storyId: "S2",
                    leaseId: "lease-S2-1",
                    mode: "worktree",
                }),
            )

            const firstLevel = await waitFor(env.events, LevelCompleted.is)
            assert.deepEqual(firstLevel.data.blocked, ["S1"])
            assert.deepEqual(firstLevel.data.failed, [])
            assert.equal(
                env.events.some(
                    (event) =>
                        ConductorState.is(event) &&
                        event.data.detail.includes("healing action"),
                ),
                false,
            )

            await answerNewContexts(env, context, runId)
            const resumedOffer = (
                await waitForCount(env.events, WorkOffered.is, 3)
            )[2]!
            assert.equal(resumedOffer.data.request.storyId, "S1")
            assert.match(
                resumedOffer.data.request.prompt,
                /Resumed after dependency integration/,
            )
            assert.match(
                resumedOffer.data.request.prompt,
                /baro-recovery\/run\/S1\/1/,
            )
            env.deliverSemanticEvent(
                broker,
                WorkLeaseGranted.create({
                    runId,
                    offerId: resumedOffer.data.offerId,
                    leaseId: "lease-S1-2",
                    workerId: "worker",
                    generation: resumedOffer.data.generation,
                    request: resumedOffer.data.request,
                }),
            )
            env.deliverSemanticEvent(
                source("S1-agent-2"),
                success(
                    runId,
                    "S1",
                    "lease-S1-2",
                    resumedOffer.data.generation,
                ),
            )
            env.deliverSemanticEvent(
                repo,
                StoryMerged.create({
                    runId,
                    storyId: "S1",
                    leaseId: "lease-S1-2",
                    mode: "worktree",
                }),
            )
            await waitFor(env.events, RunPushRequested.is)
            env.deliverSemanticEvent(
                repo,
                RunPushed.create({ runId, pushed: false }),
            )
            const summary = await board.done
            assert.equal(summary.success, true)
            assert.deepEqual(summary.failedStories, [])
            assert.equal(summary.totalAttempts, 3)
            saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.userStories.every((story) => story.passes), true)
            assert.equal(
                saved.userStories.find((story) => story.id === "S1")
                    ?.durationSecs,
                5,
            )
        })
    })

    it("rejects dependency suspension unless the feature is explicitly enabled", async () => {
        await withTempDir("collective-dependency-disabled-", async (dir) => {
            const fixture = await startRunningBoard(dir, {
                supportsCooperativeSuspend: true,
            })
            fixture.env.deliverSemanticEvent(
                fixture.bridge,
                dependencyBlock(fixture),
            )

            const rejected = await waitFor(
                fixture.env.events,
                WorkBlockRejected.is,
            )
            assert.equal(rejected.data.code, "invalid_request")
            assert.match(rejected.data.reason, /disabled/)
            assert.equal(rejected.data.requestReason, BLOCK_REASON)
            assert.equal(
                fixture.env.events.some(WorkBlockAccepted.is),
                false,
            )
            assert.equal(
                fixture.env.events.some(RuntimeReplanApplied.is),
                false,
            )
            fixture.board.leave(fixture.env)
        })
    })

    it("rejects a lease whose executor cannot prove cooperative suspension", async () => {
        await withTempDir("collective-dependency-unsupported-", async (dir) => {
            const fixture = await startRunningBoard(dir, {
                dependencySuspensionEnabled: true,
                supportsCooperativeSuspend: false,
            })
            fixture.env.deliverSemanticEvent(
                fixture.bridge,
                dependencyBlock(fixture),
            )

            const rejected = await waitFor(
                fixture.env.events,
                WorkBlockRejected.is,
            )
            assert.equal(rejected.data.code, "invalid_request")
            assert.match(rejected.data.reason, /cannot prove.*quiescence/)
            assert.equal(
                fixture.env.events.some(RuntimeReplanApplied.is),
                false,
            )
            fixture.board.leave(fixture.env)
        })
    })

    it("replays an exact block decision and rejects block-id content conflicts", async () => {
        await withTempDir("collective-dependency-replay-", async (dir) => {
            const fixture = await startRunningBoard(dir, {
                dependencySuspensionEnabled: true,
                supportsCooperativeSuspend: true,
            })
            const request = dependencyBlock(fixture)
            fixture.env.deliverSemanticEvent(fixture.bridge, request)
            const first = await waitFor(
                fixture.env.events,
                WorkBlockAccepted.is,
            )

            fixture.env.deliverSemanticEvent(fixture.bridge, request)
            const accepted = await waitForCount(
                fixture.env.events,
                WorkBlockAccepted.is,
                2,
            )
            assert.deepEqual(accepted[1]!.data, first.data)
            assert.equal(
                fixture.env.events.filter(RuntimeReplanApplied.is).length,
                1,
            )

            fixture.env.deliverSemanticEvent(
                fixture.bridge,
                dependencyBlock(fixture, "different request content"),
            )
            const conflict = await waitFor(
                fixture.env.events,
                WorkBlockRejected.is,
            )
            assert.equal(conflict.data.code, "invalid_request")
            assert.match(conflict.data.reason, /already used with different content/)
            assert.equal(conflict.data.requestReason, "different request content")
            assert.equal(
                fixture.env.events.filter(RuntimeReplanApplied.is).length,
                1,
            )
            fixture.board.leave(fixture.env)
        })
    })

    it("stops fail-closed without cleanup when a pending suspension expires", async () => {
        await withTempDir("collective-dependency-expired-", async (dir) => {
            const fixture = await startRunningBoard(dir, {
                dependencySuspensionEnabled: true,
                supportsCooperativeSuspend: true,
            })
            fixture.env.deliverSemanticEvent(
                fixture.bridge,
                dependencyBlock(fixture),
            )
            await waitFor(fixture.env.events, WorkBlockAccepted.is)

            fixture.env.deliverSemanticEvent(
                fixture.broker,
                WorkLeaseExpired.create({
                    runId: fixture.runId,
                    offerId: fixture.s1Offer.data.offerId,
                    leaseId: S1_LEASE,
                    storyId: "S1",
                    workerId: "worker",
                    reason: "dependency suspension timed out",
                }),
            )

            const summary = await fixture.board.done
            assert.equal(summary.success, false)
            assert.match(summary.abortReason ?? "", /before worker quiescence/)
            assert.equal(
                fixture.env.events.some(WorkspaceCleanupRequested.is),
                false,
            )
        })
    })
})

const S1_LEASE = "lease-S1-1"
const BLOCK_REASON = "S2 provides the shared helper"

async function startRunningBoard(
    dir: string,
    options: {
        dependencySuspensionEnabled?: boolean
        supportsCooperativeSuspend: boolean
    },
) {
    const runId = "run-dependency-board-safety"
    const prdPath = join(dir, "prd.json")
    writeFileSync(
        prdPath,
        JSON.stringify(twoIndependentStories(), null, 2) + "\n",
    )
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
        contextAuthority: context,
        ...(options.dependencySuspensionEnabled !== undefined
            ? {
                  dependencySuspensionEnabled:
                      options.dependencySuspensionEnabled,
              }
            : {}),
    })
    const env = joinWithCapture(board)
    env.deliverSemanticEvent(
        operator,
        RunStartRequest.create({ reason: "test" }),
    )
    env.deliverSemanticEvent(
        repo,
        RunPrepared.create({ runId, baseSha: null }),
    )
    await answerNewContexts(env, context, runId)
    const offers = await waitForCount(env.events, WorkOffered.is, 2)
    const s1Offer = offers.find(
        (offer) => offer.data.request.storyId === "S1",
    )!
    for (const offer of offers) {
        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: offer.data.offerId,
                leaseId: `lease-${offer.data.request.storyId}-1`,
                workerId: "worker",
                generation: offer.data.generation,
                request: offer.data.request,
                supportsCooperativeSuspend:
                    options.supportsCooperativeSuspend,
            }),
        )
    }
    return {
        runId,
        board,
        env,
        bridge,
        broker,
        s1Offer,
    }
}

function dependencyBlock(
    fixture: Awaited<ReturnType<typeof startRunningBoard>>,
    reason = BLOCK_REASON,
) {
    return WorkBlocked.create({
        runId: fixture.runId,
        blockId: "block-S1-S2",
        storyId: "S1",
        leaseId: S1_LEASE,
        generation: fixture.s1Offer.data.generation,
        requiredStoryIds: ["S2"],
        reason,
    })
}

function twoIndependentStories(): PrdFile {
    return {
        project: "Dependency suspension",
        branchName: "baro/dependency-suspension",
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

function success(
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
) {
    return StoryResult.create({
        runId,
        storyId,
        leaseId,
        generation,
        success: true,
        attempts: 1,
        durationSecs: 2,
        error: null,
    })
}

async function answerNewContexts(
    env: ReturnType<typeof joinWithCapture>,
    authority: ReturnType<typeof source>,
    runId: string,
): Promise<void> {
    const answered = new Set(
        env.events
            .filter(WorkContextProvided.is)
            .map((event) => event.data.requestId),
    )
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const requests = env.events
            .filter(WorkContextRequested.is)
            .filter((event) => !answered.has(event.data.requestId))
        if (requests.length > 0) {
            for (const request of requests) {
                answered.add(request.data.requestId)
                env.deliverSemanticEvent(
                    authority,
                    WorkContextProvided.create({
                        runId,
                        requestId: request.data.requestId,
                        storyId: request.data.storyId,
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
