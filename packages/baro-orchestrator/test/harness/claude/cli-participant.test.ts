import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ClaudeCliParticipant } from "../../../src/harness/claude/cli-participant.js"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    ClaudeSystem,
} from "../../../src/semantic-events.js"
import {
    assertHarnessEnvironmentWasSanitized,
    captureEnv,
    harnessEnvironmentCaptureProgram,
    source,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "../../execution/helpers.js"

function writeFakeClaude(dir: string): string {
    const bin = join(dir, "fake-claude.mjs")
    const events = [
        {
            type: "system",
            subtype: "init",
            session_id: "claude-session-1",
        },
        {
            type: "result",
            subtype: "success",
            session_id: "claude-session-1",
            is_error: false,
            result: "claude completed",
            num_turns: 1,
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeClaudeStdinCapture(
    dir: string,
): { bin: string; stdinPath: string } {
    const bin = join(dir, "fake-claude-stdin.mjs")
    const stdinPath = join(dir, "stdin.jsonl")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const stdinPath = ${JSON.stringify(stdinPath)};
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-stdin" }));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  writeFileSync(stdinPath, input);
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session-stdin",
    is_error: false,
    result: "stdin captured",
    num_turns: 1
  }));
});
`,
    )
    chmodSync(bin, 0o755)
    return { bin, stdinPath }
}

describe("ClaudeCliParticipant", () => {
    it("keeps Baro's injected Gateway credential out of the Claude subscription process", async () => {
        await withTempDir("baro-claude-cli-env-", async (dir) => {
            const capture = join(dir, "env.json")
            const bin = join(dir, "fake-claude-env.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "env-session" }));
console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "env-session", is_error: false, result: "ok", num_turns: 1 }));
`)
            chmodSync(bin, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const participant = new ClaudeCliParticipant("claude-env", {
                    cwd: dir,
                    claudeBin: bin,
                })
                participant.start(captureEnv())
                await participant.ready
                assert.equal((await participant.done).exitCode, 0)
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("maps fake stream-json output into lifecycle and result events", async () => {
        await withTempDir("baro-claude-cli-", async (dir) => {
            const env = captureEnv()
            const participant = new ClaudeCliParticipant("claude-agent", {
                cwd: dir,
                claudeBin: writeFakeClaude(dir),
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.sessionId, "claude-session-1")
            assert.equal(summary.error, null)
            assert.equal(summary.lastResult?.resultText, "claude completed")
            assert.equal(participant.getPhase(), "done")

            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.payload.agentId === "claude-agent" &&
                        event.payload.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        ClaudeSystem.is(event) &&
                        event.payload.subtype === "init",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        AgentResult.is(event) &&
                        event.payload.resultText === "claude completed",
                ),
            )
        })
    })

    // A story with four turns reported its first turn's cost four times (a
    // bench run read as $24 that cost $13), and a fork reported its parent's again.
    it("reports what each turn added to the session's running cost", async () => {
        await withTempDir("baro-claude-cost-", async (dir) => {
            const bin = join(dir, "fake-claude-cost.mjs")
            const result = (total: number) => ({
                type: "result", subtype: "success", session_id: "s", is_error: false, result: "ok", total_cost_usd: total,
            })
            const events = [{ type: "system", subtype: "init", session_id: "s" }, result(1.5), result(1.75), result(2.5)]
            writeFileSync(bin, `#!/usr/bin/env node\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`)
            chmodSync(bin, 0o755)
            const costsOf = async (options: { costBaselineUsd?: number }) => {
                const env = captureEnv()
                const participant = new ClaudeCliParticipant("claude-agent", { cwd: dir, claudeBin: bin, ...options })
                participant.start(env)
                await participant.done
                assert.equal(participant.getCumulativeCostUsd(), 2.5)
                return env.events.filter(AgentResult.is).map((event) => event.payload.totalCostUsd)
            }
            assert.deepEqual(await costsOf({}), [1.5, 0.25, 0.75])
            // Resumed from a session that had already cost 1.0.
            assert.deepEqual(await costsOf({ costBaselineUsd: 1.0 }), [0.5, 0.25, 0.75])
        })
    })

    it("forwards targeted messages to the fake Claude stdin stream", async () => {
        await withTempDir("baro-claude-cli-stdin-", async (dir) => {
            const { bin, stdinPath } = writeFakeClaudeStdinCapture(dir)
            const env = captureEnv()
            const participant = new ClaudeCliParticipant("claude-agent", {
                cwd: dir,
                claudeBin: bin,
            })

            participant.start(env)
            await participant.ready
            await participant.onExternalEvent(
                source("story-agent"),
                AgentTargetedMessage.create({
                    recipientId: "claude-agent",
                    text: "continue from the bus",
                    metadata: { storyId: "S3" },
                }),
            )
            participant.closeStdin()
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.lastResult?.resultText, "stdin captured")

            const lines = readFileSync(stdinPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
            assert.deepEqual(lines, [
                {
                    type: "user",
                    message: {
                        role: "user",
                        content: "continue from the bus",
                    },
                },
            ])
        })
    })

    it("accepts collective messages only from the exact Bridge and lease", async () => {
        await withTempDir("baro-claude-cli-message-authority-", async (dir) => {
            const { bin, stdinPath } = writeFakeClaudeStdinCapture(dir)
            const env = captureEnv()
            const bridge = source("bridge")
            const participant = new ClaudeCliParticipant("claude-agent", {
                cwd: dir,
                claudeBin: bin,
                targetedMessageAuthority: bridge,
                targetedMessageCorrelation: {
                    runId: "run-1",
                    leaseId: "lease-1",
                    generation: 3,
                },
            })

            participant.start(env)
            await participant.ready
            for (const [messageSource, text, leaseId] of [
                [source("bridge"), "forged source", "lease-1"],
                [bridge, "stale lease", "lease-old"],
                [bridge, "authorized", "lease-1"],
            ] as const) {
                await participant.onExternalEvent(
                    messageSource,
                    AgentTargetedMessage.create({
                        recipientId: "claude-agent",
                        text,
                        metadata: {},
                        runId: "run-1",
                        leaseId,
                        generation: 3,
                    }),
                )
            }
            participant.closeStdin()
            await participant.done

            const lines = readFileSync(stdinPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
            assert.deepEqual(
                lines.map((line) => line.message.content),
                ["authorized"],
            )
        })
    })
})
