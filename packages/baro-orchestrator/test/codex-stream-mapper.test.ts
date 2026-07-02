import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "@mozaik-ai/core"

import { mapCodexEvent } from "../src/codex-stream-mapper.js"
import {
    CodexItemEvent,
    CodexSystem,
    CodexTurnEvent,
    CodexUnknownEvent,
} from "../src/semantic-events.js"

const agentId = "codex-agent"

function map(event: Record<string, unknown>) {
    const result = mapCodexEvent(agentId, event)
    assert.ok(result.items.length > 0)
    return result
}

function json(item: unknown): any {
    return JSON.parse(JSON.stringify(item))
}

function itemEvents(items: unknown[]) {
    return items.filter(CodexItemEvent.is).map((item) => item.data)
}

function assertNoMozaikBuiltins(items: unknown[]) {
    assert.equal(items.some((item) => item instanceof ModelMessageItem), false)
    assert.equal(items.some((item) => item instanceof FunctionCallItem), false)
    assert.equal(
        items.some((item) => item instanceof FunctionCallOutputItem),
        false,
    )
}

function onlyFunctionCall(items: unknown[]) {
    const calls = items.filter((item) => item instanceof FunctionCallItem)
    assert.equal(calls.length, 1)
    return json(calls[0])
}

function onlyFunctionCallOutput(items: unknown[]) {
    const outputs = items.filter(
        (item) => item instanceof FunctionCallOutputItem,
    )
    assert.equal(outputs.length, 1)
    return json(outputs[0])
}

function assertCodexItem(items: unknown[], itemType: string) {
    const events = itemEvents(items)
    assert.equal(events.length, 1)
    assert.equal(events[0].agentId, agentId)
    assert.equal(events[0].itemType, itemType)
}

describe("mapCodexEvent", () => {
    it("maps thread.started to CodexSystem and returns thread id", () => {
        const event = { type: "thread.started", thread_id: "thread-1" }
        const result = map(event)
        const system = result.items.find(CodexSystem.is)

        assert.equal(result.threadId, "thread-1")
        assert.ok(system)
        assert.equal(system.data.agentId, agentId)
        assert.equal(system.data.subtype, "thread.started")
        assert.equal(system.data.raw, event)
    })

    it("maps thread.completed to CodexSystem", () => {
        const event = { type: "thread.completed" }
        const result = map(event)
        const system = result.items.find(CodexSystem.is)

        assert.ok(system)
        assert.equal(system.data.agentId, agentId)
        assert.equal(system.data.subtype, "thread.completed")
        assert.equal(system.data.raw, event)
    })

    it("maps turn lifecycle events to CodexTurnEvent phases", () => {
        for (const phase of ["started", "completed", "failed"]) {
            const event = { type: `turn.${phase}` }
            const result = map(event)
            const turn = result.items.find(CodexTurnEvent.is)

            assert.ok(turn)
            assert.equal(turn.data.agentId, agentId)
            assert.equal(turn.data.phase, phase)
            assert.equal(turn.data.raw, event)
        }
    })

    it("maps error envelopes to CodexSystem", () => {
        const event = { type: "error", message: "bad request" }
        const result = map(event)
        const system = result.items.find(CodexSystem.is)

        assert.ok(system)
        assert.equal(system.data.agentId, agentId)
        assert.equal(system.data.subtype, "error")
        assert.equal(system.data.raw, event)
    })

    it("maps item.started to CodexItemEvent only", () => {
        const event = {
            type: "item.started",
            item: { id: "item-1", type: "agent_message" },
        }
        const result = map(event)

        assertNoMozaikBuiltins(result.items)
        assertCodexItem(result.items, "started:agent_message")
    })

    it("maps item.updated to CodexItemEvent only", () => {
        const event = {
            type: "item.updated",
            item: { id: "item-1", type: "agent_message", text: "partial" },
        }
        const result = map(event)

        assertNoMozaikBuiltins(result.items)
        assertCodexItem(result.items, "updated:agent_message")
    })

    it("maps completed agent messages to ModelMessageItem plus CodexItemEvent", () => {
        const event = {
            type: "item.completed",
            item: {
                id: "msg-1",
                type: "agent_message",
                text: "Codex says hi",
            },
        }
        const result = map(event)
        const messages = result.items.filter(
            (item) => item instanceof ModelMessageItem,
        )

        assert.equal(messages.length, 1)
        assert.equal(json(messages[0]).content[0].text, "Codex says hi")
        assertCodexItem(result.items, "agent_message")
    })

    it("maps completed reasoning items to CodexItemEvent only", () => {
        const result = map({
            type: "item.completed",
            item: { id: "reason-1", type: "reasoning", text: "thinking" },
        })

        assertNoMozaikBuiltins(result.items)
        assertCodexItem(result.items, "reasoning")
    })

    it("maps command_execution items to shell FunctionCallItem", () => {
        const result = map({
            type: "item.completed",
            item: {
                id: "cmd-1",
                type: "command_execution",
                command: "npm test",
                output: "ok",
            },
        })
        const call = onlyFunctionCall(result.items)

        assert.equal(call.call_id, "cmd-1")
        assert.equal(call.name, "shell")
        assert.deepEqual(JSON.parse(call.arguments), { command: "npm test" })
        assertCodexItem(result.items, "command_execution")
    })

    it("maps command_execution with exit code and no stdout to fallback output", () => {
        const result = map({
            type: "item.completed",
            item: {
                id: "cmd-2",
                type: "command_execution",
                command: "true",
                exit_code: 0,
            },
        })
        const output = onlyFunctionCallOutput(result.items)

        assert.equal(output.call_id, "cmd-2")
        assert.equal(output.output[0].text, "exit_code=0")
    })

    it("maps file_change items to edit FunctionCallItem", () => {
        const result = map({
            type: "item.completed",
            item: {
                id: "file-1",
                type: "file_change",
                path: "README.md",
                diff: "+hello",
            },
        })
        const call = onlyFunctionCall(result.items)

        assert.equal(call.call_id, "file-1")
        assert.equal(call.name, "edit")
        assert.deepEqual(JSON.parse(call.arguments), {
            path: "README.md",
            diff: "+hello",
        })
        assertCodexItem(result.items, "file_change")
    })

    it("maps mcp_tool_call items to paired call and output items", () => {
        const result = map({
            type: "item.completed",
            item: {
                id: "mcp-1",
                type: "mcp_tool_call",
                tool_name: "memory.query",
                arguments: { query: "Codex" },
                result: "done",
            },
        })
        const call = onlyFunctionCall(result.items)
        const output = onlyFunctionCallOutput(result.items)

        assert.equal(call.call_id, "mcp-1")
        assert.equal(call.name, "memory.query")
        assert.deepEqual(JSON.parse(call.arguments), { query: "Codex" })
        assert.equal(output.call_id, call.call_id)
        assert.equal(output.output[0].text, "done")
        assertCodexItem(result.items, "mcp_tool_call")
    })

    it("maps web_search items to web_search FunctionCallItem", () => {
        const result = map({
            type: "item.completed",
            item: {
                id: "web-1",
                type: "web_search",
                query: "Codex CLI JSON events",
            },
        })
        const call = onlyFunctionCall(result.items)

        assert.equal(call.call_id, "web-1")
        assert.equal(call.name, "web_search")
        assert.deepEqual(JSON.parse(call.arguments), {
            query: "Codex CLI JSON events",
        })
        assertCodexItem(result.items, "web_search")
    })

    it("maps plan_update items to CodexItemEvent only", () => {
        const result = map({
            type: "item.completed",
            item: { id: "plan-1", type: "plan_update", plan: [] },
        })

        assertNoMozaikBuiltins(result.items)
        assertCodexItem(result.items, "plan_update")
    })

    it("maps unknown envelope types to CodexUnknownEvent", () => {
        const event = { type: "unexpected.event", payload: true }
        const result = map(event)
        const unknown = result.items.find(CodexUnknownEvent.is)

        assert.ok(unknown)
        assert.equal(unknown.data.agentId, agentId)
        assert.equal(unknown.data.codexType, "unexpected.event")
        assert.equal(unknown.data.raw, event)
    })
})
