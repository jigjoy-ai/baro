import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "../src/runtime/mozaik.js"

import { mapOpenCodeEvent } from "../src/opencode-stream-mapper.js"
import {
    OpenCodeStepEvent,
    OpenCodeSystem,
    OpenCodeUnknownEvent,
} from "../src/semantic-events.js"

const agentId = "opencode-agent"

function map(event: Record<string, unknown>) {
    const result = mapOpenCodeEvent(agentId, event)
    assert.ok(result.items.length > 0)
    return result
}

function serialized(item: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(item)) as Record<string, unknown>
}

function contentText(item: unknown): string {
    const content = serialized(item).content as { text?: string }[] | undefined
    return (content ?? []).map((part) => part.text ?? "").join("")
}

function outputText(item: unknown): string {
    const output = serialized(item).output as { text?: string }[] | undefined
    return (output ?? []).map((part) => part.text ?? "").join("")
}

function firstSystem(items: readonly unknown[]) {
    const item = items.find((candidate) =>
        OpenCodeSystem.is(candidate as ReturnType<typeof OpenCodeSystem.create>),
    )
    assert.ok(item)
    assert.ok(OpenCodeSystem.is(item as ReturnType<typeof OpenCodeSystem.create>))
    return item
}

function stepEvents(items: readonly unknown[]) {
    return items.filter((item): item is ReturnType<typeof OpenCodeStepEvent.create> =>
        OpenCodeStepEvent.is(item as ReturnType<typeof OpenCodeStepEvent.create>),
    )
}

describe("mapOpenCodeEvent", () => {
    it("maps step_start to OpenCodeSystem and extracts sessionId", () => {
        const event = {
            type: "step_start",
            timestamp: 1,
            sessionID: "opencode-session",
            part: { type: "step-start" },
        }

        const result = map(event)
        const system = firstSystem(result.items)

        assert.equal(result.sessionId, "opencode-session")
        assert.equal(system.data.agentId, agentId)
        assert.equal(system.data.subtype, "step_start")
        assert.deepEqual(system.data.raw, event)
    })

    it("maps text to ModelMessageItem and OpenCodeStepEvent", () => {
        const event = {
            type: "text",
            timestamp: 2,
            sessionID: "opencode-session",
            part: { type: "text", text: "OpenCode says hi" },
        }

        const result = map(event)
        const message = result.items.find(
            (item): item is ModelMessageItem => item instanceof ModelMessageItem,
        )
        const step = stepEvents(result.items).find(
            (item) => item.data.stepType === "text",
        )

        assert.ok(message)
        assert.equal(contentText(message), "OpenCode says hi")
        assert.ok(step)
        assert.equal(step.data.agentId, agentId)
        assert.deepEqual(step.data.raw, event)
    })

    it("maps real tool_use to paired call and output items plus step events", () => {
        const event = {
            type: "tool_use",
            timestamp: 3,
            sessionID: "opencode-session",
            part: {
                type: "tool",
                tool: "write",
                callID: "tool-call-1",
                state: {
                    status: "completed",
                    input: { filePath: "README.md", content: "hi" },
                    output: "wrote README.md",
                },
            },
        }

        const result = map(event)
        const call = result.items.find(
            (item): item is FunctionCallItem => item instanceof FunctionCallItem,
        )
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )

        assert.ok(call)
        assert.ok(output)

        const callJson = serialized(call)
        const outputJson = serialized(output)

        assert.equal(callJson.call_id, "tool-call-1")
        assert.equal(callJson.name, "write")
        assert.equal(
            callJson.arguments,
            JSON.stringify({ filePath: "README.md", content: "hi" }),
        )
        assert.equal(outputJson.call_id, "tool-call-1")
        assert.equal(outputJson.call_id, callJson.call_id)
        assert.equal(outputText(output), "wrote README.md")
        assert.deepEqual(
            stepEvents(result.items).map((item) => item.data.stepType),
            ["tool_call", "tool_result"],
        )
    })

    it("maps tool_use without output to a call item only", () => {
        const event = {
            type: "tool_use",
            timestamp: 4,
            sessionID: "opencode-session",
            part: {
                type: "tool",
                tool: "read",
                callID: "tool-call-2",
                state: {
                    status: "running",
                    input: { filePath: "package.json" },
                },
            },
        }

        const result = map(event)
        const call = result.items.find(
            (item): item is FunctionCallItem => item instanceof FunctionCallItem,
        )

        assert.ok(call)
        assert.equal(serialized(call).call_id, "tool-call-2")
        assert.equal(
            result.items.some((item) => item instanceof FunctionCallOutputItem),
            false,
        )
        assert.deepEqual(
            stepEvents(result.items).map((item) => item.data.stepType),
            ["tool_call"],
        )
    })

    it("maps legacy tool_call to FunctionCallItem and OpenCodeStepEvent", () => {
        const event = {
            type: "tool_call",
            timestamp: 5,
            sessionID: "opencode-session",
            part: {
                id: "legacy-call-1",
                type: "tool-call",
                tool: "Read",
                args: { path: "README.md" },
            },
        }

        const result = map(event)
        const call = result.items.find(
            (item): item is FunctionCallItem => item instanceof FunctionCallItem,
        )

        assert.ok(call)

        const callJson = serialized(call)

        assert.equal(callJson.call_id, "legacy-call-1")
        assert.equal(callJson.name, "Read")
        assert.equal(callJson.arguments, JSON.stringify({ path: "README.md" }))
        assert.deepEqual(
            stepEvents(result.items).map((item) => item.data.stepType),
            ["tool_call"],
        )
    })

    it("maps legacy tool_result to FunctionCallOutputItem and OpenCodeStepEvent", () => {
        const event = {
            type: "tool_result",
            timestamp: 6,
            sessionID: "opencode-session",
            part: {
                id: "legacy-call-1",
                type: "tool-result",
                result: "legacy result",
            },
        }

        const result = map(event)
        const output = result.items.find(
            (item): item is FunctionCallOutputItem =>
                item instanceof FunctionCallOutputItem,
        )

        assert.ok(output)
        assert.equal(serialized(output).call_id, "legacy-call-1")
        assert.equal(outputText(output), "legacy result")
        assert.deepEqual(
            stepEvents(result.items).map((item) => item.data.stepType),
            ["tool_result"],
        )
    })

    it("maps step_finish to OpenCodeSystem and preserves metadata in raw", () => {
        const event = {
            type: "step_finish",
            timestamp: 7,
            sessionID: "opencode-session",
            part: {
                type: "step-finish",
                tokens: { total: 100, input: 90, output: 10 },
                cost: 0.001,
            },
        }

        const result = map(event)
        const system = firstSystem(result.items)
        const raw = system.data.raw as typeof event

        assert.equal(system.data.subtype, "step_finish")
        assert.equal(raw.part.tokens.total, 100)
        assert.equal(raw.part.cost, 0.001)
    })

    it("maps unknown events to OpenCodeUnknownEvent", () => {
        const event = {
            type: "mystery",
            timestamp: 8,
            sessionID: "opencode-session",
            payload: { value: true },
        }

        const result = map(event)
        const unknown = result.items.find((item) =>
            OpenCodeUnknownEvent.is(
                item as ReturnType<typeof OpenCodeUnknownEvent.create>,
            ),
        )

        assert.ok(unknown)
        assert.ok(
            OpenCodeUnknownEvent.is(
                unknown as ReturnType<typeof OpenCodeUnknownEvent.create>,
            ),
        )
        assert.equal(unknown.data.agentId, agentId)
        assert.equal(unknown.data.openCodeType, "mystery")
        assert.deepEqual(unknown.data.raw, event)
    })
})
