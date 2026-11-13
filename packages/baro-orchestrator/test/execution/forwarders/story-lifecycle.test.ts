import { describe, it } from "@rstest/core"
import assert from "node:assert/strict"

import { FunctionCallItem } from "../../../src/runtime/mozaik.js"

import {
    AgentState,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    StoryRouted,
    WorkBlockAccepted,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { StoryLifecycleForwarder } from "../../../src/execution/forwarders/story-lifecycle.js"
import { StoryOutcomeAuthority } from "../../../src/runtime/story-outcome-authority.js"
import { captureStdout, source } from "../helpers.js"

function parseEvents(lines: string[]): BaroEvent[] {
    return lines.map((line) => JSON.parse(line) as BaroEvent)
}

function call(name: string, args: Record<string, unknown>): FunctionCallItem {
    return FunctionCallItem.rehydrate({
        callId: "call-1",
        name,
        args: JSON.stringify(args),
    })
}

describe("StoryLifecycleForwarder", () => {
    it("emits story lifecycle events with completed file counts", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const agent = source("S1")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                AgentState.create({ agentId: "S1", phase: "running" }),
            )
            await forwarder.onExternalEvent(
                agent,
                AgentState.create({
                    agentId: "S1",
                    phase: "waiting",
                    detail: "retrying (1/2)",
                }),
            )
            await forwarder.onExternalFunctionCall(
                agent,
                call("Write", { file_path: "new.ts", content: "x" }),
            )
            await forwarder.onExternalFunctionCall(
                agent,
                call("Edit", { file_path: "existing.ts", old: "a", new: "b" }),
            )
            await forwarder.onExternalEvent(
                agent,
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 2,
                    durationSecs: 12,
                    error: null,
                }),
            )
        }))

        assert.deepEqual(events, [
            { type: "story_start", id: "S1", title: "S1" },
            { type: "story_retry", id: "S1", attempt: 1 },
            {
                type: "story_complete",
                id: "S1",
                duration_secs: 12,
                files_created: 1,
                files_modified: 1,
            },
        ])
    })

    it("emits story_error BaroEvents for failed story results", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const agent = source("S2")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 3,
                    durationSecs: 25,
                    error: "tests failed",
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "story_error",
                id: "S2",
                error: "tests failed",
                attempt: 3,
                max_retries: 3,
            },
        ])
    })

    it("projects dependency suspension neutrally and starts the resumed lease anew", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const agent = source("S2")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                AgentState.create({ agentId: "S2", phase: "running" }),
            )
            await forwarder.onExternalFunctionCall(
                agent,
                call("Edit", { file_path: "partial.ts", old: "a", new: "b" }),
            )
            await forwarder.onExternalEvent(
                agent,
                StoryResult.create({
                    storyId: "S2",
                    success: false,
                    attempts: 1,
                    durationSecs: 3,
                    error: null,
                    suspension: {
                        kind: "dependency",
                        blockId: "block-S2-S1",
                    },
                }),
            )
            await forwarder.onExternalEvent(
                agent,
                AgentState.create({ agentId: "S2", phase: "running" }),
            )
        }))

        assert.deepEqual(events, [
            { type: "story_start", id: "S2", title: "S2" },
            {
                type: "story_suspended",
                id: "S2",
                waits_on: [],
                block_id: "block-S2-S1",
            },
            { type: "story_start", id: "S2", title: "S2" },
        ])
    })

    it("names the stories a suspended story waits on, from the accepted block", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const board = source("board")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                board,
                WorkBlockAccepted.create({
                    runId: "run-1",
                    blockId: "block-S5",
                    storyId: "S5",
                    leaseId: "lease-5",
                    generation: 1,
                    requiredStoryIds: ["S1", "S2", "S3"],
                    reason: "README documents S1-S3",
                    graphVersion: 2,
                }),
            )
            await forwarder.onExternalEvent(
                source("S5"),
                StoryResult.create({
                    storyId: "S5",
                    success: false,
                    attempts: 1,
                    durationSecs: 2,
                    error: "suspended on dependency block block-S5",
                    suspension: { kind: "dependency", blockId: "block-S5" },
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "story_suspended",
                id: "S5",
                waits_on: ["S1", "S2", "S3"],
                block_id: "block-S5",
            },
        ])
        assert.equal(events.some((e) => e.type === "story_error"), false)
    })

    it("takes waits_on only from the collective Board", async () => {
        const board = source("board")
        const broker = source("broker")
        const repository = source("repository")
        const agent = source("S5")
        const outcomeAuthority = new StoryOutcomeAuthority("run-1")
        outcomeAuthority.registerResultAuthority(
            { runId: "run-1", storyId: "S5", leaseId: "lease-5", generation: 1 },
            agent,
        )
        const forwarder = new StoryLifecycleForwarder(true)
        forwarder.sealCollectiveAuthorities({
            runId: "run-1",
            broker,
            repository,
            outcomeAuthority,
            board,
        })
        const accepted = (requiredStoryIds: string[]) =>
            WorkBlockAccepted.create({
                runId: "run-1",
                blockId: "block-S5",
                storyId: "S5",
                leaseId: "lease-5",
                generation: 1,
                requiredStoryIds,
                reason: "needs S1",
                graphVersion: 2,
            })

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: "run-1",
                    offerId: "offer-5",
                    leaseId: "lease-5",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S5",
                        prompt: "work",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                }),
            )
            await forwarder.onExternalEvent(board, accepted(["S1"]))
            await forwarder.onExternalEvent(source("spoof"), accepted(["S9"]))
            await forwarder.onExternalEvent(
                agent,
                StoryResult.create({
                    storyId: "S5",
                    success: false,
                    attempts: 1,
                    durationSecs: 2,
                    error: null,
                    runId: "run-1",
                    leaseId: "lease-5",
                    generation: 1,
                    suspension: { kind: "dependency", blockId: "block-S5" },
                }),
            )
        }))

        assert.deepEqual(
            events.filter((e) => e.type === "story_suspended"),
            [
                {
                    type: "story_suspended",
                    id: "S5",
                    waits_on: ["S1"],
                    block_id: "block-S5",
                },
            ],
        )
    })

    it("waits for repository integration before completing a collective story", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    runId: "run-1",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    workerId: "worker",
                    generation: 1,
                    request: {
                        storyId: "S1",
                        prompt: "work",
                        model: "standard",
                        retries: 1,
                        timeoutSecs: 60,
                    },
                }),
            )
            await forwarder.onExternalEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 1,
                    durationSecs: 4,
                    error: null,
                    runId: "run-1",
                    leaseId: "lease-1",
                    generation: 1,
                }),
            )
            await forwarder.onExternalEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-1",
                    leaseId: "lease-1",
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "story_complete",
                id: "S1",
                duration_secs: 4,
                files_created: 0,
                files_modified: 0,
            },
            { type: "story_merged", id: "S1", mode: "worktree" },
        ])
    })

    // #287: a story the run had dropped was shown as Running for 40 more minutes.
    it("closes a story whose lease ends without a merge after it reported success", async () => {
        for (const [reason, error] of [
            ["quality_failed", "the work was not accepted (acceptance gate failed)"],
            ["quality_inconclusive", "the work was neither accepted nor rejected (acceptance could not decide)"],
            ["aborted", "the story ended without a merge (aborted)"],
        ] as const) {
            const forwarder = new StoryLifecycleForwarder()
            const events = parseEvents(await captureStdout(async () => {
                await forwarder.onExternalEvent(
                    source("broker"),
                    WorkLeaseGranted.create({
                        runId: "run-1",
                        offerId: "offer-1",
                        leaseId: "lease-1",
                        workerId: "worker",
                        generation: 1,
                        request: { storyId: "S1", prompt: "work", model: "standard", retries: 2, timeoutSecs: 60 },
                    }),
                )
                await forwarder.onExternalEvent(
                    source("S1"),
                    StoryResult.create({
                        storyId: "S1",
                        success: true,
                        attempts: 1,
                        durationSecs: 4,
                        error: null,
                        runId: "run-1",
                        leaseId: "lease-1",
                        generation: 1,
                    }),
                )
                await forwarder.onExternalEvent(
                    source("broker"),
                    WorkLeaseReleased.create({
                        runId: "run-1",
                        offerId: "offer-1",
                        leaseId: "lease-1",
                        storyId: "S1",
                        workerId: "worker",
                        reason,
                    }),
                )
            }))

            assert.deepEqual(events, [
                { type: "story_error", id: "S1", error, attempt: 1, max_retries: 1 },
            ], reason)
        }
    })

    it("says nothing more when the lease of a merged story is released", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const lease = { runId: "run-1", offerId: "offer-1", leaseId: "lease-1", workerId: "worker" }
        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("broker"),
                WorkLeaseGranted.create({
                    ...lease,
                    generation: 1,
                    request: { storyId: "S1", prompt: "work", model: "standard", retries: 1, timeoutSecs: 60 },
                }),
            )
            await forwarder.onExternalEvent(
                source("S1"),
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 1,
                    durationSecs: 4,
                    error: null,
                    runId: "run-1",
                    leaseId: "lease-1",
                    generation: 1,
                }),
            )
            await forwarder.onExternalEvent(
                source("repo"),
                StoryMerged.create({ storyId: "S1", mode: "worktree", runId: "run-1", leaseId: "lease-1" }),
            )
            await forwarder.onExternalEvent(
                source("broker"),
                WorkLeaseReleased.create({ ...lease, storyId: "S1", reason: "integrated" }),
            )
        }))

        assert.deepEqual(events.map(({ type }) => type), ["story_complete", "story_merged"])
    })

    it("suppresses terminal events from a superseded lease", async () => {
        const forwarder = new StoryLifecycleForwarder()
        const lease = (
            leaseId: string,
            generation: number,
        ) => WorkLeaseGranted.create({
            runId: "run-stale",
            offerId: `offer-${generation}`,
            leaseId,
            workerId: "worker",
            generation,
            request: {
                storyId: "S1",
                prompt: "work",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            },
        })
        const result = (leaseId: string, generation: number) =>
            StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: generation,
                error: null,
                runId: "run-stale",
                leaseId,
                generation,
            })

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(source("broker"), lease("old", 1))
            await forwarder.onExternalEvent(source("old"), result("old", 1))
            await forwarder.onExternalEvent(source("broker"), lease("new", 2))
            await forwarder.onExternalEvent(source("new"), result("new", 2))
            await forwarder.onExternalEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-stale",
                    leaseId: "old",
                }),
            )
            await forwarder.onExternalEvent(
                source("repo"),
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-stale",
                    leaseId: "new",
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "story_complete",
                id: "S1",
                duration_secs: 2,
                files_created: 0,
                files_modified: 0,
            },
            { type: "story_merged", id: "S1", mode: "worktree" },
        ])
    })

    it("emits structured routed, story_merged, and merge_failed BaroEvents", async () => {
        const forwarder = new StoryLifecycleForwarder()

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("story-factory"),
                StoryRouted.create({
                    storyId: "S3",
                    backend: "openai",
                    model: "gpt-5.5",
                }),
            )
            await forwarder.onExternalEvent(
                source("git-coordinator"),
                StoryMerged.create({ storyId: "S3", mode: "worktree" }),
            )
            await forwarder.onExternalEvent(
                source("git-coordinator"),
                StoryMergeFailed.create({ storyId: "S4", error: "conflict in a.ts" }),
            )
        }))

        assert.deepEqual(events, [
            { type: "routed", id: "S3", backend: "openai", model: "gpt-5.5" },
            { type: "story_merged", id: "S3", mode: "worktree" },
            { type: "merge_failed", id: "S4", error: "conflict in a.ts" },
        ])
    })

    it("fails closed and projects only exact active collective authorities", async () => {
        const forwarder = new StoryLifecycleForwarder(true)
        const broker = source("broker")
        const repository = source("repository")
        const factory = source("factory")
        const worker = source("S1")
        const forger = source("S1")
        const outcomes = new StoryOutcomeAuthority("run-auth")
        const grant = WorkLeaseGranted.create({
            runId: "run-auth",
            offerId: "offer-1",
            leaseId: "lease-1",
            workerId: "worker-1",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "work",
                model: "standard",
                retries: 2,
                timeoutSecs: 60,
            },
        })
        const result = StoryResult.create({
            storyId: "S1",
            success: true,
            attempts: 1,
            durationSecs: 4,
            error: null,
            runId: "run-auth",
            leaseId: "lease-1",
            generation: 1,
        })

        const events = parseEvents(await captureStdout(async () => {
            // Collective forwarders are deny-all until the production seal.
            await forwarder.onExternalEvent(
                forger,
                StoryResult.create({
                    storyId: "S1",
                    success: true,
                    attempts: 1,
                    durationSecs: 999,
                    error: null,
                }),
            )
            forwarder.sealCollectiveAuthorities({
                runId: "run-auth",
                broker,
                repository,
                outcomeAuthority: outcomes,
            })

            // Same payload from a non-Broker cannot seed the lease view.
            await forwarder.onExternalEvent(forger, grant)
            await forwarder.onExternalEvent(broker, grant)
            outcomes.registerSpawnAuthority(
                { runId: "run-auth", storyId: "S1", leaseId: "lease-1" },
                factory,
            )
            outcomes.registerResultAuthority(
                {
                    runId: "run-auth",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                },
                worker,
            )

            await forwarder.onExternalEvent(
                forger,
                AgentState.create({ agentId: "S1", phase: "running" }),
            )
            await forwarder.onExternalEvent(
                factory,
                StoryRouted.create({
                    storyId: "S1",
                    backend: "codex",
                    model: "gpt",
                    runId: "run-auth",
                    leaseId: "lease-1",
                    generation: 1,
                }),
            )
            await forwarder.onExternalEvent(
                worker,
                AgentState.create({ agentId: "S1", phase: "running" }),
            )
            await forwarder.onExternalFunctionCall(
                forger,
                call("Write", { file_path: "forged.ts" }),
            )
            await forwarder.onExternalFunctionCall(
                worker,
                call("Write", { file_path: "real.ts" }),
            )
            await forwarder.onExternalEvent(forger, result)
            await forwarder.onExternalEvent(worker, result)
            await forwarder.onExternalEvent(
                forger,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-auth",
                    leaseId: "lease-1",
                }),
            )
            await forwarder.onExternalEvent(
                repository,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId: "run-auth",
                    leaseId: "lease-1",
                }),
            )
            await forwarder.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-auth",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    storyId: "S1",
                    workerId: "worker-1",
                    reason: "integrated",
                }),
            )
            // The formerly exact worker is stale once its lease is released.
            await forwarder.onExternalEvent(
                worker,
                AgentState.create({
                    agentId: "S1",
                    phase: "waiting",
                    detail: "retrying",
                }),
            )
        }))

        assert.deepEqual(events, [
            { type: "routed", id: "S1", backend: "codex", model: "gpt" },
            { type: "story_start", id: "S1", title: "S1" },
            {
                type: "story_complete",
                id: "S1",
                duration_secs: 4,
                files_created: 1,
                files_modified: 0,
            },
            { type: "story_merged", id: "S1", mode: "worktree" },
        ])
    })
})
