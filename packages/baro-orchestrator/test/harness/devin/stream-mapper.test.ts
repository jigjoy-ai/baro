import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { FunctionCallItem, FunctionCallOutputItem, ModelMessageItem } from "../../../src/runtime/mozaik.js"
import { DevinStreamMapper } from "../../../src/harness/devin/stream-mapper.js"

describe("DevinStreamMapper", () => {
    it("buffers message chunks until the agent moves on", () => {
        const mapper = new DevinStreamMapper("s1")
        const chunk = (text: string) => mapper.map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
        assert.ok(chunk("Let me ").every((item) => !(item instanceof ModelMessageItem)))
        chunk("look.")
        const items = mapper.map({ sessionUpdate: "tool_call", toolCallId: "exec:1", kind: "execute", rawInput: { command: "ls" }, _meta: { "cognition.ai/inferenceToolName": "exec" } })
        const message = items.find((item) => item instanceof ModelMessageItem) as ModelMessageItem
        assert.equal(message.content.text, "Let me look.")
        const call = items.find((item) => item instanceof FunctionCallItem) as FunctionCallItem
        assert.deepEqual([call.callId, call.name, call.args], ["exec:1", "shell", JSON.stringify({ command: "ls" })])
        assert.deepEqual(mapper.flush(), [])
    })

    it("closes each call once, marking failures", () => {
        const mapper = new DevinStreamMapper("s1")
        mapper.map({ sessionUpdate: "tool_call", toolCallId: "a", kind: "edit" })
        mapper.map({ sessionUpdate: "tool_call", toolCallId: "b", kind: "read" })
        assert.equal(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress" }).filter((i) => i instanceof FunctionCallOutputItem).length, 0)
        const done = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] })
        assert.equal(done.filter((i) => i instanceof FunctionCallOutputItem).length, 1)
        assert.equal(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }).filter((i) => i instanceof FunctionCallOutputItem).length, 0)
        mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", content: [{ type: "content", content: { type: "text", text: "denied" } }] })
        assert.equal(mapper.toolCallCount, 2)
        assert.equal(mapper.toolSuccessCount, 1)
    })

    it("reports a non-zero exit even when Devin marks the call completed", () => {
        const mapper = new DevinStreamMapper("s1")
        mapper.map({ sessionUpdate: "tool_call", toolCallId: "t", kind: "execute", rawInput: { command: "npm test" } })
        mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", _meta: { terminal_exit: { exit_code: 1, signal: null } } })
        const [output] = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "content", content: { type: "text", text: "1 failing" } }] })
            .filter((i) => i instanceof FunctionCallOutputItem) as FunctionCallOutputItem[]
        assert.match(JSON.stringify(output!.toJSON()), /\[error\] exit code 1/)
        assert.equal(mapper.toolSuccessCount, 0)
    })

    it("takes a command's output from its streamed updates; the final one carries none", () => {
        const mapper = new DevinStreamMapper("s1")
        const update = (u: Record<string, unknown>) => mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "t", ...u })
        mapper.map({ sessionUpdate: "tool_call", toolCallId: "t", kind: "execute", rawInput: { command: "npm test" } })
        update({ status: "in_progress", content: [{ type: "content", content: { type: "text", text: "ok 1" } }] })
        update({ status: "in_progress", content: [{ type: "content", content: { type: "text", text: "ok 1\nok 2" } }], _meta: { terminal_exit: { exit_code: 0 } } })
        const [output] = update({ status: "completed" }).filter((i) => i instanceof FunctionCallOutputItem) as FunctionCallOutputItem[]
        assert.match(JSON.stringify(output!.toJSON()), /ok 1\\nok 2\\n\(exit code 0\)/)
        assert.equal(mapper.toolSuccessCount, 1)
    })
})
