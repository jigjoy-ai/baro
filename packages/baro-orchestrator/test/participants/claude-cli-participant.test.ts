import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { ClaudeCliParticipant } from "../../src/participants/claude-cli-participant.js"
import {
    AgentResult,
    AgentState,
    ClaudeSystem,
} from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

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

describe("ClaudeCliParticipant", () => {
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
                        event.data.agentId === "claude-agent" &&
                        event.data.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        ClaudeSystem.is(event) &&
                        event.data.subtype === "init",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        AgentResult.is(event) &&
                        event.data.resultText === "claude completed",
                ),
            )
        })
    })
})
