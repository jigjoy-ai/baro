import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import { mapPiEvent } from "../src/pi-stream-mapper.js"
import {
    PiItemEvent,
    PiSystem,
    PiTurnEvent,
    PiUnknownEvent,
} from "../src/semantic-events.js"

const AGENT_ID = "pi-agent"

type PiItem = ReturnType<typeof mapPiEvent>["items"][number]

function map(event: Record<string, unknown>): ReturnType<typeof mapPiEvent> {
    const result = mapPiEvent(AGENT_ID, event)
    assert.ok(result.items.length > 0)
    return result
}

function json(item: unknown): Record<string, any> {
    return JSON.parse(JSON.stringify(item)) as Record<string, any>
}

function semantic<T>(
    items: PiItem[],
    is: (event: SemanticEvent<unknown>) => event is SemanticEvent<T>,
): SemanticEvent<T> {
    const item = items.find(
        (candidate): candidate is SemanticEvent<T> =>
            candidate instanceof SemanticEvent && is(candidate),
    )
    assert.ok(item)
    return item
}

function hasModelMessage(items: PiItem[]): boolean {
    return items.some((item) => item instanceof ModelMessageItem)
}

function hasFunctionCall(items: PiItem[]): boolean {
    return items.some((item) => item instanceof FunctionCallItem)
}

describe("mapPiEvent", () => {
    it("maps session and returns the session id", () => {
        const event = { type: "session", id: "pi-session" }
        const result = map(event)
        const item = semantic(result.items, PiSystem.is)

        assert.equal(result.sessionId, "pi-session")
        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.subtype, "session")
        assert.equal(item.data.raw, event)
    })

    it("maps agent_start and turn_start lifecycle events", () => {
        for (const subtype of ["agent_start", "turn_start"]) {
            const result = map({ type: subtype })
            const item = semantic(result.items, PiSystem.is)

            assert.equal(item.data.agentId, AGENT_ID)
            assert.equal(item.data.subtype, subtype)
        }
    })

    it("maps message_start to a turn event", () => {
        const result = map({ type: "message_start" })
        const item = semantic(result.items, PiTurnEvent.is)

        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.turnType, "message_start")
    })

    it("normalizes message_update subtypes without emitting model messages", () => {
        const cases = [
            ["text_delta", "text"],
            ["thinking_delta", "thinking"],
            ["toolcall_delta", "tool_call"],
            ["custom_delta", "custom_delta"],
        ] as const

        for (const [subtype, itemType] of cases) {
            const result = map({
                type: "message_update",
                assistantMessageEvent: { type: subtype },
            })
            const item = semantic(result.items, PiItemEvent.is)

            assert.equal(item.data.agentId, AGENT_ID)
            assert.equal(item.data.itemType, itemType)
            assert.equal(hasModelMessage(result.items), false)
        }
    })

    it("maps assistant message_end text to a model message plus lifecycle event", () => {
        const result = map({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Pi says hi" }],
            },
        })
        const message = result.items.find(
            (item): item is ModelMessageItem => item instanceof ModelMessageItem,
        )
        const turn = semantic(result.items, PiTurnEvent.is)

        assert.ok(message)
        assert.equal(json(message).content[0].text, "Pi says hi")
        assert.equal(turn.data.turnType, "message_end")
    })

    it("maps assistant message_end tool calls to function calls plus lifecycle event", () => {
        const result = map({
            type: "message_end",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "call-1",
                        name: "bash",
                        arguments: { command: "echo hi" },
                    },
                ],
            },
        })
        const call = result.items.find(
            (item): item is FunctionCallItem => item instanceof FunctionCallItem,
        )
        const turn = semantic(result.items, PiTurnEvent.is)

        assert.ok(call)
        assert.deepEqual(json(call), {
            type: "function_call",
            call_id: "call-1",
            name: "bash",
            arguments: JSON.stringify({ command: "echo hi" }),
        })
        assert.equal(turn.data.turnType, "message_end")
    })

    it("maps user message_end only to a lifecycle event", () => {
        const result = map({
            type: "message_end",
            message: {
                role: "user",
                content: [{ type: "text", text: "hello" }],
            },
        })
        const turn = semantic(result.items, PiTurnEvent.is)

        assert.equal(turn.data.turnType, "message_end")
        assert.equal(hasModelMessage(result.items), false)
        assert.equal(hasFunctionCall(result.items), false)
    })

    it("maps tool execution start and update item events", () => {
        const cases = [
            ["tool_execution_start", "tool_start"],
            ["tool_execution_update", "tool_update"],
        ] as const

        for (const [type, itemType] of cases) {
            const result = map({ type })
            const item = semantic(result.items, PiItemEvent.is)

            assert.equal(item.data.agentId, AGENT_ID)
            assert.equal(item.data.itemType, itemType)
        }
    })

    it("maps tool_execution_end text content to function output plus item event", () => {
        const result = map({
            type: "tool_execution_end",
            toolCallId: "call-1",
            result: {
                content: [
                    { type: "text", text: "hello " },
                    { type: "text", text: "world" },
                ],
            },
        })
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )
        const item = semantic(result.items, PiItemEvent.is)

        assert.ok(output)
        assert.equal(json(output).call_id, "call-1")
        assert.equal(json(output).output[0].text, "hello world")
        assert.equal(item.data.itemType, "tool_result")
    })

    it("keeps empty text blocks as empty function outputs", () => {
        const result = map({
            type: "tool_execution_end",
            toolCallId: "call-1",
            result: { content: [{ type: "text", text: "" }] },
        })
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )

        assert.ok(output)
        assert.equal(json(output).call_id, "call-1")
        assert.equal(json(output).output[0].text, "")
    })

    it("emits empty output when a successful tool_execution_end has no result", () => {
        const result = map({
            type: "tool_execution_end",
            toolCallId: "call-1",
            isError: false,
        })
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )

        assert.ok(output)
        assert.equal(json(output).call_id, "call-1")
        assert.equal(json(output).output[0].text, "")
    })

    it("emits an error fallback when a failed tool_execution_end has no result", () => {
        const result = map({
            type: "tool_execution_end",
            toolCallId: "call-1",
            isError: true,
        })
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )

        assert.ok(output)
        assert.equal(json(output).call_id, "call-1")
        assert.equal(json(output).output[0].text, "[error] no output")
    })

    it("maps turn_end and agent_end lifecycle events", () => {
        const turnResult = map({ type: "turn_end" })
        const turn = semantic(turnResult.items, PiTurnEvent.is)

        assert.equal(turn.data.agentId, AGENT_ID)
        assert.equal(turn.data.turnType, "turn_end")

        const agentResult = map({ type: "agent_end" })
        const agent = semantic(agentResult.items, PiSystem.is)

        assert.equal(agent.data.agentId, AGENT_ID)
        assert.equal(agent.data.subtype, "agent_end")
    })

    it("maps unknown events to PiUnknownEvent", () => {
        const event = { type: "mystery", value: 1 }
        const result = map(event)
        const item = semantic(result.items, PiUnknownEvent.is)

        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.piType, "mystery")
        assert.equal(item.data.raw, event)
    })
})
