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

    it("emits typed activity shapes for file changes and test results", async () => {
        const forwarder = new AgentStreamForwarder()
        const agent = source("S2")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalFunctionCall(
                agent,
                FunctionCallItem.rehydrate({
                    callId: "call-1",
                    name: "write_file",
                    args: JSON.stringify({ path: "src/new.ts" }),
                }),
            )
            await forwarder.onExternalFunctionCall(
                agent,
                FunctionCallItem.rehydrate({
                    callId: "call-2",
                    name: "edit_file",
                    args: JSON.stringify({ file_path: "src/existing.ts" }),
                }),
            )
            await forwarder.onExternalFunctionCallOutput(
                agent,
                FunctionCallOutputItem.create("call-3", "12 tests passed\nok"),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "activity",
                id: "S2",
                kind: "file_change",
                tool: "write",
                op: "create",
                path: "src/new.ts",
                text: "src/new.ts",
            },
            {
                type: "activity",
                id: "S2",
                kind: "file_change",
                tool: "write",
                op: "modify",
                path: "src/existing.ts",
                text: "src/existing.ts",
            },
            {
                type: "activity",
                id: "S2",
                kind: "test",
                ok: true,
                text: "12 tests passed",
            },
        ])
    })

    // Wiring check: the forwarder must use the counts-based testVerdict —
    // a green node:test summary ("fail 0") is a passed test entry, not a ✗.
    it("reads zero-failure summaries as passed", async () => {
        const forwarder = new AgentStreamForwarder()
        const agent = source("S3")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalFunctionCallOutput(
                agent,
                FunctionCallOutputItem.create("call-1", "ℹ tests 144\nℹ pass 144\nℹ fail 0"),
            )
        }))

        assert.deepEqual(events, [
            { type: "activity", id: "S3", kind: "test", ok: true, text: "ℹ tests 144" },
        ])
    })
})
