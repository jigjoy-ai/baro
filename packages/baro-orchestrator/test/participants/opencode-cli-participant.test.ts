import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { OpenCodeCliParticipant } from "../../src/participants/opencode-cli-participant.js"
import {
    AgentState,
    OpenCodeStepEvent,
    OpenCodeSystem,
} from "../../src/semantic-events.js"
import {
    assertHarnessEnvironmentWasSanitized,
    captureEnv,
    harnessEnvironmentCaptureProgram,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "./helpers.js"

function writeFakeOpenCode(dir: string): string {
    const bin = join(dir, "fake-opencode.mjs")
    const events = [
        {
            type: "step_start",
            timestamp: 1,
            sessionID: "opencode-session-1",
            part: { type: "step-start" },
        },
        {
            type: "tool_use",
            timestamp: 2,
            sessionID: "opencode-session-1",
            part: {
                type: "tool",
                tool: "write",
                callID: "tool-1",
                state: {
                    status: "completed",
                    input: { filePath: "out.txt", content: "ok" },
                    output: "wrote file",
                },
            },
        },
        {
            type: "step_finish",
            timestamp: 3,
            sessionID: "opencode-session-1",
            part: { type: "step-finish" },
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFailingFakeOpenCode(dir: string): string {
    const bin = join(dir, "fake-opencode-fail.mjs")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "step_start",
  timestamp: 1,
  sessionID: "opencode-session-fail",
  part: { type: "step-start" }
}));
process.exit(7);
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeOpenCodeWithPostExitStdio(dir: string): string {
    const bin = join(dir, "fake-opencode-final-line.mjs")
    const sessionID = "opencode-final-line"
    const stdout = [
        JSON.stringify({
            type: "step_start",
            timestamp: 1,
            sessionID,
            part: { type: "step-start" },
        }),
        JSON.stringify({
            type: "tool_use",
            timestamp: 2,
            sessionID,
            part: {
                type: "tool",
                tool: "write",
                callID: "tool-1",
                state: {
                    status: "completed",
                    input: {},
                    output: "ok",
                },
            },
        }),
        JSON.stringify({
            type: "step_finish",
            timestamp: 3,
            sessionID,
            part: { type: "step-finish" },
        }),
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
  "opencode terminal diagnostic",
], { stdio: ["ignore", "inherit", "inherit"] });
follower.unref();
process.exit(0);
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeOpenCodeWithoutStart(dir: string): string {
    const bin = join(dir, "fake-opencode-no-start.mjs")
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(7);\n")
    chmodSync(bin, 0o755)
    return bin
}

describe("OpenCodeCliParticipant", () => {
    it("keeps Baro's injected Gateway credential out of the OpenCode subscription process", async () => {
        await withTempDir("baro-opencode-cli-env-", async (dir) => {
            const capture = join(dir, "env.json")
            const bin = join(dir, "fake-opencode-env.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "env-session", part: { type: "step-start" } }));
console.log(JSON.stringify({ type: "step_finish", timestamp: 2, sessionID: "env-session", part: { type: "step-finish" } }));
`)
            chmodSync(bin, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const participant = new OpenCodeCliParticipant("opencode-env", {
                    cwd: dir,
                    prompt: "verify env",
                    opencodeBin: bin,
                })
                participant.start(captureEnv())
                await participant.ready
                assert.equal((await participant.done).exitCode, 0)
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("maps fake JSONL output into lifecycle and tool events", async () => {
        await withTempDir("baro-opencode-cli-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCall = (() => {}) as typeof env.deliverFunctionCall
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new OpenCodeCliParticipant("opencode-agent", {
                cwd: dir,
                prompt: "do the work",
                opencodeBin: writeFakeOpenCode(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "opencode-session-1")
            assert.equal(summary.error, null)
            assert.equal(summary.sawStepFinish, true)
            assert.equal(summary.toolCallCount, 1)
            assert.equal(participant.getPhase(), "done")

            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.data.agentId === "opencode-agent" &&
                        event.data.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        OpenCodeSystem.is(event) &&
                        event.data.subtype === "step_finish",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        OpenCodeStepEvent.is(event) &&
                        event.data.stepType === "tool_result",
                ),
            )
        })
    })

    it("reports a failed phase when the fake OpenCode process exits nonzero", async () => {
        await withTempDir("baro-opencode-cli-fail-", async (dir) => {
            const env = captureEnv()
            const participant = new OpenCodeCliParticipant("opencode-agent", {
                cwd: dir,
                prompt: "fail deterministically",
                opencodeBin: writeFailingFakeOpenCode(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 7)
            assert.equal(summary.sessionId, "opencode-session-fail")
            assert.equal(summary.error, null)
            assert.equal(summary.sawStepFinish, false)
            assert.equal(summary.toolCallCount, 0)
            assert.equal(participant.getPhase(), "failed")
            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.data.agentId === "opencode-agent" &&
                        event.data.phase === "failed" &&
                        event.data.detail === "exit code 7",
                ),
            )
        })
    })

    it("waits for inherited stdio to flush final JSON and stderr after process exit", async () => {
        await withTempDir("baro-opencode-cli-final-line-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCall = (() => {}) as typeof env.deliverFunctionCall
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new OpenCodeCliParticipant("opencode-agent", {
                cwd: dir,
                prompt: "finish",
                opencodeBin: writeFakeOpenCodeWithPostExitStdio(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "opencode-final-line")
            assert.equal(summary.stderrTail, "opencode terminal diagnostic")
            assert.equal(summary.sawStepFinish, true)
            assert.equal(summary.toolCallCount, 1)
        })
    })

    it("rejects ready instead of leaving it pending when the process exits before start", async () => {
        await withTempDir("baro-opencode-cli-no-start-", async (dir) => {
            const participant = new OpenCodeCliParticipant("opencode-agent", {
                cwd: dir,
                prompt: "fail",
                opencodeBin: writeFakeOpenCodeWithoutStart(dir),
            })

            participant.start(captureEnv())
            await assert.rejects(participant.ready, /before step_start/)
            assert.equal((await participant.done).exitCode, 7)
        })
    })
})
