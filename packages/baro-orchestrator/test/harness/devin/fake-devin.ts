import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A stand-in `devin acp`: answers the ACP handshake and plays FAKE_DEVIN_SCENARIO
 * for the prompt. "echo" replies with what the client asked for (cwd, mode, isolation).
 */
export function writeFakeDevin(dir: string, scenario: string): string {
    const bin = join(dir, "devin")
    const script = String.raw`#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const scenario = ${JSON.stringify(scenario)}
let cwd = "", mode = "", buf = ""
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } })
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } })
        else if (m.method === "session/new") {
            cwd = m.params.cwd
            if (scenario === "auth") send({ id: m.id, error: { code: -32603, message: "Authentication required: failed to validate Devin token: Service key has expired" } })
            else send({ id: m.id, result: { sessionId: "s1" } })
        } else if (m.method === "session/set_mode") { mode = m.params.modeId; send({ id: m.id, result: {} }) }
        else if (m.method === "session/prompt") prompt(m.id)
    }
})
process.stdin.on("end", () => process.exit(0))
function finish(id) {
    send({ method: "_cognition.ai/turn_stats", params: { sessionId: "s1", responseDimensions: [
        { uid: "model", kind: { type: "metric", value: "SWE-2 Medium" } },
        { uid: "input_tokens", kind: { type: "cumulativeMetric", value: 60 } },
        { uid: "output_tokens", kind: { type: "cumulativeMetric", value: 5 } },
        { uid: "cached_input_tokens", kind: { type: "cumulativeMetric", value: 40 } },
    ] } })
    send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 40 } } })
}
function prompt(id) {
    if (scenario === "text") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } })
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } })
    } else if (scenario === "echo") {
        const isolated = fs.existsSync(path.join(cwd, ".devin", "config.json"))
        const at = process.argv.indexOf("--agent-type")
        const agentType = at >= 0 ? process.argv[at + 1] : null
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ cwd, mode, isolated, agentType }) } })
    } else if (scenario === "tool") {
        update({ sessionUpdate: "tool_call", toolCallId: "read:1", title: "Read file", kind: "read", rawInput: { file_path: "x" } })
        return
    } else if (scenario === "story") {
        update({ sessionUpdate: "tool_call", toolCallId: "exec:1", title: "Ran touch", kind: "execute", rawInput: { command: "touch a" }, _meta: { "cognition.ai/inferenceToolName": "exec" } })
        update({ sessionUpdate: "tool_call_update", toolCallId: "exec:1", status: "completed", content: [{ type: "content", content: { type: "text", text: "" } }] })
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } })
    } else if (scenario === "prose") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I would edit the file." } })
    }
    finish(id)
}
`
    writeFileSync(bin, script)
    chmodSync(bin, 0o755)
    return bin
}
