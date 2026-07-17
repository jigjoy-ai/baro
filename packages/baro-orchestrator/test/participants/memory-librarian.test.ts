import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem, FunctionCallOutputItem } from "@mozaik-ai/core"

import { MemoryLibrarian } from "../../src/participants/memory-librarian.js"
import { StoryResult, StorySpawned } from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

function call(
    callId: string,
    name: string,
    args: Record<string, unknown>,
): FunctionCallItem {
    return FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })
}

describe("MemoryLibrarian", () => {
    it("returns no launch context when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })

        assert.equal(await librarian.gatherContext("S2", ["auth"]), null)
    })

    it("does not store or emit knowledge when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const env = joinWithCapture(librarian)

        await librarian.onExternalFunctionCall(
            source("S1"),
            call("read-1", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            source("S1"),
            FunctionCallOutputItem.create("read-1", "export const token = 'abc'"),
        )

        assert.deepEqual(env.events, [])
    })

    it("stays silent for story lifecycle events when disabled", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const env = joinWithCapture(librarian)

        await librarian.onExternalEvent(source("conductor"), StorySpawned.create({ storyId: "S2" }))
        await librarian.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 2,
                durationSecs: 10,
                error: "failed",
            }),
        )

        assert.deepEqual(env.events, [])
        assert.equal(await librarian.gatherContext("S3", ["auth"]), null)
    })

    it("removes a dependency-suspended worker from the in-flight set", async () => {
        const librarian = new MemoryLibrarian({ disabled: true })
        const state = librarian as unknown as { inFlight: Set<string> }

        await librarian.onExternalEvent(
            source("board"),
            StorySpawned.create({ storyId: "S2" }),
        )
        assert.equal(state.inFlight.has("S2"), true)
        await librarian.onExternalEvent(
            source("S2"),
            StoryResult.create({
                storyId: "S2",
                success: false,
                attempts: 1,
                durationSecs: 2,
                error: null,
                suspension: {
                    kind: "dependency",
                    blockId: "block-S2-S1",
                },
            }),
        )

        assert.equal(state.inFlight.has("S2"), false)
    })
})
