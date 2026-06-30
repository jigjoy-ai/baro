import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "@mozaik-ai/core"

import type { BaroEvent } from "../../../src/tui-protocol.js"
import { AgentStreamForwarder } from "../../../src/participants/forwarders/agent-stream.js"
import { captureStdout, source } from "../helpers.js"

function parseEvents(lines: string[]): BaroEvent[] {
    return lines.map((line) => JSON.parse(line) as BaroEvent)
}

describe("AgentStreamForwarder", () => {
    it("emits story_log events for model messages and tool IO", async () => {
        const forwarder = new AgentStreamForwarder()
        const agent = source("S1")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalModelMessage(
                agent,
                ModelMessageItem.rehydrate({ text: "hello\nworld" }),
            )
            await forwarder.onExternalFunctionCall(
                agent,
                FunctionCallItem.rehydrate({
                    callId: "call-1",
                    name: "Read",
                    args: JSON.stringify({ file_path: "src/app.ts" }),
                }),
            )
            await forwarder.onExternalFunctionCallOutput(
                agent,
                FunctionCallOutputItem.create("call-1", "done"),
            )
        }))

        assert.deepEqual(events, [
            { type: "story_log", id: "S1", line: "hello" },
            { type: "story_log", id: "S1", line: "world" },
            {
                type: "story_log",
                id: "S1",
                line: "[tool_call] Read {\"file_path\":\"src/app.ts\"}",
            },
            { type: "story_log", id: "S1", line: "[tool_result call-1] done" },
        ])
    })
})
