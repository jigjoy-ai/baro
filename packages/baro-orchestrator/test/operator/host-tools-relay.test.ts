import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { describe, it } from "node:test"

import { HostToolsRelay, OPERATOR_MCP_MODE } from "../../src/operator/host-tools-relay.js"

/* The relay is what the MCP child dials; this speaks its wire format directly. */

async function call(port: number, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port })
        socket.setEncoding("utf8")
        let buffer = ""
        socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"))
        socket.on("data", (chunk: string) => {
            buffer += chunk
            if (buffer.includes("\n")) {
                socket.destroy()
                resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))))
            }
        })
        socket.once("error", reject)
    })
}

describe("operator host tools relay", () => {
    it("describes its tools and forwards calls, only with the token", async () => {
        const calls: unknown[] = []
        const relay = new HostToolsRelay(
            [
                {
                    name: "echo",
                    description: "returns its input",
                    parameters: { type: "object", properties: { text: { type: "string" } } },
                    invoke: async (args) => {
                        calls.push(args)
                        return `echo:${(args as { text: string }).text}`
                    },
                },
            ],
            "test instructions",
        )
        const connection = await relay.open()
        try {
            const token = Object.values(connection.env)[0]!
            const port = Number(connection.args[connection.args.indexOf("--bridge-port") + 1])
            assert.ok(connection.args.includes(OPERATOR_MCP_MODE))
            assert.match(token, /^[a-f0-9]{64}$/)

            const described = await call(port, { type: "describe", token })
            assert.equal(described.ok, true)
            const result = described.result as { instructions: string; tools: Array<{ name: string }> }
            assert.equal(result.instructions, "test instructions")
            assert.deepEqual(result.tools.map((t) => t.name), ["echo"])

            const answered = await call(port, { type: "call", name: "echo", args: { text: "hi" }, token })
            assert.deepEqual(answered, { ok: true, result: "echo:hi" })
            assert.deepEqual(calls, [{ text: "hi" }])

            const refused = await call(port, { type: "call", name: "echo", args: {}, token: "nope" })
            assert.equal(refused.ok, false)
            assert.match(String(refused.error), /authentication failed/)

            const unknown = await call(port, { type: "call", name: "missing", args: {}, token })
            assert.equal(unknown.ok, false)
            assert.match(String(unknown.error), /unknown tool: missing/)
        } finally {
            await relay.close()
        }
    })
})
