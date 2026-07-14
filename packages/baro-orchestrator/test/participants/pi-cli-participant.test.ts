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
import {
    assertHarnessEnvironmentWasSanitized,
    captureEnv,
    harnessEnvironmentCaptureProgram,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "./helpers.js"

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

function writeFakePiWithPostExitStdio(dir: string): string {
    const bin = join(dir, "fake-pi-final-line.mjs")
    const stdout = [
        JSON.stringify({ type: "session", id: "pi-final-line" }),
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "write",
        }),
        JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "write",
            isError: false,
            result: { content: [{ type: "text", text: "ok" }] },
        }),
        JSON.stringify({ type: "agent_end", willRetry: false }),
    ].join("\n")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
const follower = spawn("/bin/sh", [
  "-c",
  "while kill -0 \\\"$1\\\" 2>/dev/null; do :; done; printf '%s' \\\"$2\\\"; printf '%s' \\\"$3\\\" >&2",
  "baro-stdio-follower",
  String(process.pid),
  ${JSON.stringify(stdout)},
  "pi terminal diagnostic",
], { stdio: ["ignore", "inherit", "inherit"] });
follower.unref();
process.exit(0);
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("PiCliParticipant", () => {
    it("keeps Baro's injected Gateway credential out of the Pi subscription process", async () => {
        await withTempDir("baro-pi-cli-env-", async (dir) => {
            const capture = join(dir, "env.json")
            const bin = join(dir, "fake-pi-env.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
console.log(JSON.stringify({ type: "session", id: "env-session" }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }));
`)
            chmodSync(bin, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const participant = new PiCliParticipant("pi-env", {
                    cwd: dir,
                    prompt: "verify env",
                    piBin: bin,
                })
                participant.start(captureEnv())
                await participant.ready
                assert.equal((await participant.done).exitCode, 0)
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

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

    it("waits for inherited stdio to flush final JSON and stderr after process exit", async () => {
        await withTempDir("baro-pi-cli-final-line-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new PiCliParticipant("pi-agent", {
                cwd: dir,
                prompt: "finish",
                piBin: writeFakePiWithPostExitStdio(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "pi-final-line")
            assert.equal(summary.stderrTail, "pi terminal diagnostic")
            assert.equal(summary.sawAgentEnd, true)
            assert.equal(summary.toolCallCount, 1)
            assert.equal(summary.toolSuccessCount, 1)
        })
    })
})
