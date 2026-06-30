import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { CodexCliParticipant } from "../../src/participants/codex-cli-participant.js"
import {
    AgentState,
    CodexSystem,
    CodexTurnEvent,
} from "../../src/semantic-events.js"
import { captureEnv, withTempDir } from "./helpers.js"

function writeFakeCodex(dir: string): string {
    const bin = join(dir, "fake-codex.mjs")
    const events = [
        {
            type: "thread.started",
            thread_id: "codex-thread-1",
        },
        {
            type: "turn.started",
        },
        {
            type: "turn.completed",
            usage: {
                input_tokens: 1,
                output_tokens: 1,
            },
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("CodexCliParticipant", () => {
    it("maps fake JSONL output into lifecycle and turn events", async () => {
        await withTempDir("baro-codex-cli-", async (dir) => {
            const env = captureEnv()
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt: "do the work",
                codexBin: writeFakeCodex(dir),
                skipGitRepoCheck: true,
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.threadId, "codex-thread-1")
            assert.equal(summary.error, null)
            assert.equal(participant.getPhase(), "done")

            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.data.agentId === "codex-agent" &&
                        event.data.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        CodexSystem.is(event) &&
                        event.data.subtype === "thread.started",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        CodexTurnEvent.is(event) &&
                        event.data.phase === "completed",
                ),
            )
        })
    })
})
