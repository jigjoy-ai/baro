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
    it("emits condensed activity events for model messages and tool IO", async () => {
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

        // The forwarder now emits ONE condensed, typed `activity` per bus item
        // (no per-line firehose): model message → agent_msg (first line),
        // read/bash/file tool calls → tool_call, outputs → tool_result.
        assert.deepEqual(events, [
            { type: "activity", id: "S1", kind: "agent_msg", text: "hello" },
            {
                type: "activity",
                id: "S1",
                kind: "tool_call",
                tool: "read",
                text: "Read src/app.ts",
            },
            { type: "activity", id: "S1", kind: "tool_result", text: "done" },
        ])
    })
})
