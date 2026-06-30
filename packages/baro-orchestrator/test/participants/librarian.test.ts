import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { FunctionCallItem, FunctionCallOutputItem } from "@mozaik-ai/core"

import { AgentTargetedMessage, Knowledge, StorySpawned } from "../../src/semantic-events.js"
import { Librarian } from "../../src/participants/librarian.js"
import { joinWithCapture, source } from "./helpers.js"

function call(
    callId: string,
    name: string,
    args: Record<string, unknown>,
): FunctionCallItem {
    return FunctionCallItem.rehydrate({ callId, name, args: JSON.stringify(args) })
}

describe("Librarian", () => {
    it("indexes exploration tool output, emits knowledge, and gathers cross-agent context", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)

        await librarian.onExternalFunctionCall(
            source("S1"),
            call("read-1", "Read", { file_path: "src/auth.ts" }),
        )
        await librarian.onExternalFunctionCallOutput(
            source("S1"),
            FunctionCallOutputItem.create("read-1", "export const token = 'abc'"),
        )

        const knowledge = librarian.getKnowledge()
        assert.equal(knowledge.length, 1)
        assert.equal(knowledge[0].sourceAgentId, "S1")
        assert.equal(knowledge[0].tool, "Read")
        assert.equal(knowledge[0].summary, "Read src/auth.ts")
        assert.equal(knowledge[0].content, "export const token = 'abc'")

        const event = env.events.find(Knowledge.is)
        assert.ok(event, "knowledge event emitted")
        assert.equal(event.data.sourceAgentId, "S1")
        assert.equal(event.data.summary, "Read src/auth.ts")

        assert.equal(librarian.gatherContext("S1", ["auth"]), null)
        const context = librarian.gatherContext("S2", ["auth"])
        assert.ok(context?.includes("Read src/auth.ts"))
        assert.ok(context?.includes("export const token = 'abc'"))
    })

    it("broadcasts new findings to other in-flight stories", async () => {
        const librarian = new Librarian()
        const env = joinWithCapture(librarian)

        await librarian.onExternalEvent(source("conductor"), StorySpawned.create({ storyId: "S2" }))
        await librarian.onExternalFunctionCall(
            source("S1"),
            call("grep-1", "Grep", { pattern: "auth", path: "src" }),
        )
        await librarian.onExternalFunctionCallOutput(
            source("S1"),
            FunctionCallOutputItem.create("grep-1", "src/auth.ts:1:auth"),
        )

        const targeted = env.events.filter(AgentTargetedMessage.is)
        assert.equal(targeted.length, 1)
        assert.equal(targeted[0].data.recipientId, "S2")
        assert.equal(targeted[0].data.metadata.from_agent, "S1")
        assert.ok(targeted[0].data.text.includes("Grep 'auth' in src"))
    })
})
