import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DevinAcpTurn } from "../../../src/harness/devin/acp-turn.js"

function turn(permissions: "allow" | "reject" = "allow") {
    const written: Record<string, unknown>[] = []
    const t = new DevinAcpTurn(
        { cwd: "/work", prompt: "do it", mode: "bypass", permissions },
        (line) => written.push(JSON.parse(line)),
    )
    return { t, written }
}

describe("DevinAcpTurn", () => {
    it("walks the handshake to a finished prompt", () => {
        const { t, written } = turn()
        t.start()
        assert.equal(written[0]!.method, "initialize")
        assert.deepEqual(t.consume({ id: 1, result: { protocolVersion: 1 } }), [])
        assert.deepEqual(written[1]!.params, { cwd: "/work", mcpServers: [] })
        assert.deepEqual(t.consume({ id: 2, result: { sessionId: "s1" } }), [{ kind: "session", sessionId: "s1" }])
        assert.deepEqual(written[2]!.params, { sessionId: "s1", modeId: "bypass" })
        t.consume({ id: 3, result: {} })
        assert.equal(written[3]!.method, "session/prompt")
        assert.deepEqual(written[3]!.params, { sessionId: "s1", prompt: [{ type: "text", text: "do it" }] })
        assert.deepEqual(
            t.consume({ id: 4, result: { stopReason: "end_turn", usage: { inputTokens: 9 } } }),
            [{ kind: "finished", stopReason: "end_turn", usage: { inputTokens: 9 } }],
        )
    })

    it("fails on an error response, naming the step", () => {
        const { t } = turn()
        t.start()
        t.consume({ id: 1, result: {} })
        const [event] = t.consume({ id: 2, error: { code: -32603, message: "Service key has expired" } })
        assert.deepEqual(event, { kind: "failed", message: "session/new failed: Service key has expired" })
    })

    it("answers permission requests by policy", () => {
        const options = [
            { optionId: "yes", kind: "allow_once" },
            { optionId: "no", kind: "reject_once" },
        ]
        for (const [policy, optionId] of [["allow", "yes"], ["reject", "no"]] as const) {
            const { t, written } = turn(policy)
            const [event] = t.consume({ id: 7, method: "session/request_permission", params: { toolCall: { title: "Ran rm" }, options } })
            assert.deepEqual(written.at(-1), { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId } } })
            assert.deepEqual(event, { kind: "permission", title: "Ran rm", granted: policy === "allow" })
        }
    })

    it("refuses agent requests it does not handle instead of leaving Devin waiting", () => {
        const { t, written } = turn()
        assert.deepEqual(t.consume({ id: 9, method: "fs/read_text_file", params: {} }), [])
        assert.equal((written.at(-1)!.error as { code: number }).code, -32601)
    })

    it("reads turn totals from turn_stats", () => {
        const { t } = turn()
        const [event] = t.consume({
            method: "_cognition.ai/turn_stats",
            params: {
                responseDimensions: [
                    { uid: "model", kind: { value: "SWE-2 Medium" } },
                    { uid: "input_tokens", kind: { value: 28965 } },
                    { uid: "output_tokens", kind: { value: 75 } },
                    { uid: "cached_input_tokens", kind: { value: 10560 } },
                ],
            },
        })
        assert.deepEqual(event, {
            kind: "turn_stats",
            tokens: { inputTokens: 28965, cachedInputTokens: 10560, outputTokens: 75, model: "SWE-2 Medium" },
        })
    })
})
