import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem } from "@mozaik-ai/core"

import {
    AgentState,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    StoryRouted,
    WorkLeaseGranted,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { StoryLifecycleForwarder } from "../../../src/participants/forwarders/story-lifecycle.js"
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
                block_id: "block-S2-S1",
            },
            { type: "story_start", id: "S2", title: "S2" },
        ])
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
})
