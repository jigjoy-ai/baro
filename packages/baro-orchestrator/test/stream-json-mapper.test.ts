import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "@mozaik-ai/core"

import { mapClaudeEvent } from "../src/stream-json-mapper.js"
import {
    AgentResult,
    AgentUserMessage,
    ClaudeRateLimit,
    ClaudeStreamChunk,
    ClaudeSystem,
    ClaudeUnknownEvent,
} from "../src/semantic-events.js"

const AGENT_ID = "claude-agent"

function map(event: Record<string, unknown>) {
    const result = mapClaudeEvent(AGENT_ID, event)
    assert.ok(result.items.length > 0, `${String(event.type)} maps to items`)
    return result
}

function json(item: unknown): any {
    return JSON.parse(JSON.stringify(item))
}

function assertModelMessage(item: unknown): ModelMessageItem {
    assert.ok(item instanceof ModelMessageItem)
    return item
}

function assertFunctionCall(item: unknown): FunctionCallItem {
    assert.ok(item instanceof FunctionCallItem)
    return item
}

function assertFunctionCallOutput(item: unknown): FunctionCallOutputItem {
    assert.ok(item instanceof FunctionCallOutputItem)
    return item
}

describe("mapClaudeEvent", () => {
    it("maps system init events and surfaces session ids", () => {
        const event = {
            type: "system",
            subtype: "init",
            session_id: "claude-session",
        }
        const result = map(event)
        const item = result.items[0]

        assert.equal(result.sessionId, "claude-session")
        assert.ok(ClaudeSystem.is(item as ReturnType<typeof ClaudeSystem.create>))
        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.subtype, "init")
        assert.deepEqual(item.data.raw, event)
    })

    it("maps rate limit events", () => {
        const event = {
            type: "rate_limit_event",
            detail: "slow down",
        }
        const result = map(event)
        const item = result.items[0]

        assert.equal(result.sessionId, null)
        assert.ok(ClaudeRateLimit.is(item as ReturnType<typeof ClaudeRateLimit.create>))
        assert.equal(item.data.agentId, AGENT_ID)
        assert.deepEqual(item.data.raw, event)
    })

    it("maps stream chunk events", () => {
        const event = {
            type: "stream_event",
            event: { type: "content_block_delta" },
        }
        const result = map(event)
        const item = result.items[0]

        assert.ok(ClaudeStreamChunk.is(item as ReturnType<typeof ClaudeStreamChunk.create>))
        assert.equal(item.data.agentId, AGENT_ID)
        assert.deepEqual(item.data.raw, event)
    })

    it("maps user string content to AgentUserMessage", () => {
        const result = map({
            type: "user",
            message: { content: "please inspect README" },
        })
        const item = result.items[0]

        assert.ok(AgentUserMessage.is(item as ReturnType<typeof AgentUserMessage.create>))
        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.text, "please inspect README")
    })

    it("maps user tool_result blocks to function call outputs", () => {
        const result = map({
            type: "user",
            message: {
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "tool-1",
                        content: [
                            { type: "text", text: "first line" },
                            { type: "text", text: "second line" },
                        ],
                    },
                ],
            },
        })
        const output = assertFunctionCallOutput(result.items[0])
        const serialized = json(output)

        assert.equal(serialized.call_id, "tool-1")
        assert.equal(serialized.output.map((part: any) => part.text).join(""), "first line\nsecond line")
    })

    it("maps mixed assistant text and tool_use blocks to typed Mozaik items", () => {
        const result = map({
            type: "assistant",
            message: {
                content: [
                    { type: "text", text: "I will read it." },
                    {
                        type: "tool_use",
                        id: "tool-1",
                        name: "Read",
                        input: { file_path: "README.md" },
                    },
                ],
            },
        })
        const message = assertModelMessage(result.items[0])
        const call = assertFunctionCall(result.items[1])
        const serializedMessage = json(message)
        const serializedCall = json(call)

        assert.equal(serializedMessage.content.map((part: any) => part.text).join(""), "I will read it.")
        assert.equal(serializedCall.call_id, "tool-1")
        assert.equal(serializedCall.name, "Read")
        assert.equal(serializedCall.arguments, JSON.stringify({ file_path: "README.md" }))
    })

    it("maps result events to claude_result semantic events", () => {
        const usage = { input_tokens: 10, output_tokens: 5 }
        const result = map({
            type: "result",
            subtype: "success",
            session_id: "claude-session",
            is_error: true,
            result: "done with caveats",
            usage,
            total_cost_usd: 0.0123,
            num_turns: 3,
            duration_ms: 4567,
        })
        const item = result.items[0]

        assert.equal(result.sessionId, "claude-session")
        assert.ok(AgentResult.is(item as ReturnType<typeof AgentResult.create>))
        assert.equal(item.type, "claude_result")
        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.subtype, "success")
        assert.equal(item.data.sessionId, "claude-session")
        assert.equal(item.data.isError, true)
        assert.equal(item.data.resultText, "done with caveats")
        assert.deepEqual(item.data.usage, usage)
        assert.equal(item.data.totalCostUsd, 0.0123)
        assert.equal(item.data.numTurns, 3)
        assert.equal(item.data.durationMs, 4567)
    })

    it("maps unknown event types to ClaudeUnknownEvent", () => {
        const event = {
            type: "new_claude_event",
            payload: { value: 1 },
        }
        const result = map(event)
        const item = result.items[0]

        assert.ok(ClaudeUnknownEvent.is(item as ReturnType<typeof ClaudeUnknownEvent.create>))
        assert.equal(item.data.agentId, AGENT_ID)
        assert.equal(item.data.claudeType, "new_claude_event")
        assert.deepEqual(item.data.raw, event)
    })
})
