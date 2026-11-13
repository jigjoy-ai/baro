import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import { Critic } from "../../src/harness/claude/critic.js"
import { runCodexOneShot } from "../../src/harness/codex/one-shot.js"
import { runOpenCodeOneShot } from "../../src/harness/opencode/one-shot.js"
import { runPiOneShot } from "../../src/harness/pi/one-shot.js"
import { withTempDir } from "../execution/helpers.js"

// Larger than a pipe buffer, so the write is still pending when the CLI exits
// and stdin fails with EPIPE.
const PROMPT = "x".repeat(1024 * 1024)

function writeCli(dir: string, name: string, body: string): string {
    const bin = join(dir, `${name}.mjs`)
    writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`)
    chmodSync(bin, 0o755)
    return bin
}

const print = (event: Record<string, unknown>): string =>
    `console.log(${JSON.stringify(JSON.stringify(event))});`

const REFUSES = `process.stderr.write("bad flag\\n"); process.exitCode = 2`

const ONE_SHOTS = [
    {
        name: "codex",
        answers: print({
            type: "item.completed",
            item: { type: "agent_message", text: "answer" },
        }),
        run: (bin: string, cwd: string) =>
            runCodexOneShot({ prompt: PROMPT, cwd, codexBin: bin }),
    },
    {
        name: "pi",
        answers: print({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "answer" }],
            },
        }),
        run: (bin: string, cwd: string) =>
            runPiOneShot({ prompt: PROMPT, cwd, piBin: bin }),
    },
    {
        name: "opencode",
        answers: print({
            type: "text",
            sessionID: "session",
            part: { text: "answer" },
        }),
        run: (bin: string, cwd: string) =>
            runOpenCodeOneShot({ prompt: PROMPT, cwd, opencodeBin: bin }),
    },
]

describe("a CLI that exits without reading its stdin", () => {
    for (const { name, answers, run } of ONE_SHOTS) {
        it(`${name} one-shot returns the answer the CLI gave`, async () => {
            await withTempDir(`baro-${name}-unread-stdin-`, async (dir) => {
                const bin = writeCli(dir, name, answers)
                assert.equal(await run(bin, dir), "answer")
            })
        })

        it(`${name} one-shot reports the CLI's own failure`, async () => {
            await withTempDir(`baro-${name}-unread-stdin-`, async (dir) => {
                const bin = writeCli(dir, name, REFUSES)
                await assert.rejects(run(bin, dir), /terminated abnormally .*exit=2/)
            })
        })
    }

    it("Claude critic reports the CLI's own failure", async () => {
        await withTempDir("baro-claude-critic-unread-stdin-", async (dir) => {
            const critic = new Critic({
                targets: new Map(),
                claudeBin: writeCli(dir, "claude", REFUSES),
            })
            const invoke = (
                critic as unknown as {
                    invoke(
                        prompt: string,
                        context: { cwd: string; timeoutMs: number },
                    ): Promise<string>
                }
            ).invoke.bind(critic)

            await assert.rejects(
                invoke(PROMPT, { cwd: dir, timeoutMs: 60_000 }),
                /exited with code 2\nbad flag/,
            )
        })
    })
})
