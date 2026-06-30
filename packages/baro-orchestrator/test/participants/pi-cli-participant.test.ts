import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { PiCliParticipant } from "../../src/participants/pi-cli-participant.js"
import {
    AgentState,
    PiItemEvent,
    PiSystem,
} from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

function writeFakePi(dir: string): string {
    const bin = join(dir, "fake-pi.mjs")
    const events = [
        {
            type: "session",
            version: 3,
            id: "pi-session-1",
            timestamp: "2026-06-30T00:00:00.000Z",
            cwd: dir,
        },
        {
            type: "agent_start",
        },
        {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
        },
        {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            isError: false,
            result: {
                content: [{ type: "text", text: "tool output" }],
            },
        },
        {
            type: "agent_end",
            messages: [],
            willRetry: false,
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakePiFailedTool(dir: string): string {
    const bin = join(dir, "fake-pi-failed-tool.mjs")
    const events = [
        {
            type: "session",
            version: 3,
            id: "pi-session-failed-tool",
            timestamp: "2026-06-30T00:00:00.000Z",
            cwd: dir,
        },
        {
            type: "agent_start",
        },
        {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
        },
        {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            isError: true,
            result: {
                content: [{ type: "text", text: "tool failed" }],
            },
        },
        {
            type: "agent_end",
            messages: [],
            willRetry: false,
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("PiCliParticipant", () => {
    it("maps fake JSONL output into lifecycle and tool events", async () => {
        await withTempDir("baro-pi-cli-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new PiCliParticipant("pi-agent", {
                cwd: dir,
                prompt: "do the work",
                piBin: writeFakePi(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "pi-session-1")
            assert.equal(summary.error, null)
            assert.equal(summary.sawAgentEnd, true)
            assert.equal(summary.toolCallCount, 1)
            assert.equal(summary.toolSuccessCount, 1)
            assert.equal(participant.getPhase(), "done")

            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.data.agentId === "pi-agent" &&
                        event.data.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        PiSystem.is(event) &&
                        event.data.subtype === "agent_end",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        PiItemEvent.is(event) &&
                        event.data.itemType === "tool_result",
                ),
            )
        })
    })

    it("keeps failed fake Pi tool executions out of the success count", async () => {
        await withTempDir("baro-pi-cli-failed-tool-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new PiCliParticipant("pi-agent", {
                cwd: dir,
                prompt: "run a failing tool",
                piBin: writeFakePiFailedTool(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "pi-session-failed-tool")
            assert.equal(summary.sawAgentEnd, true)
            assert.equal(summary.toolCallCount, 1)
            assert.equal(summary.toolSuccessCount, 0)
            assert.equal(participant.getPhase(), "done")
            assert.ok(
                env.events.some(
                    (event) =>
                        PiItemEvent.is(event) &&
                        event.data.itemType === "tool_result" &&
                        event.data.raw.isError === true,
                ),
            )
        })
    })
})
