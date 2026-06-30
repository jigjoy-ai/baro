import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem } from "@mozaik-ai/core"

import { AgentState, StoryResult } from "../../../src/semantic-events.js"
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
})
