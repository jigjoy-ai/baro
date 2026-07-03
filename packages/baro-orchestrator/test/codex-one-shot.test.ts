import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runCodexOneShot } from "../src/codex-one-shot.js"
import { withTempDir } from "./participants/helpers.js"

type FakeLine = string | Record<string, unknown>

function writeFakeCodex(dir: string, lines: FakeLine[]): string {
    const bin = join(dir, "fake-codex.mjs")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
for (const line of lines) {
    console.log(typeof line === "string" ? line : JSON.stringify(line));
}
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeCodexArgCapture(
    dir: string,
): { bin: string; argsPath: string } {
    const bin = join(dir, "fake-codex-args.mjs")
    const argsPath = join(dir, "args.json")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "done" },
}));
`,
    )
    chmodSync(bin, 0o755)
    return { bin, argsPath }
}

describe("runCodexOneShot", () => {
    it("returns concatenated completed agent messages", async () => {
        await withTempDir("baro-codex-one-shot-", async (dir) => {
            const bin = writeFakeCodex(dir, [
                "not json",
                {
                    type: "item.completed",
                    item: { type: "agent_message", text: "first" },
                },
                {
                    type: "turn.completed",
                    usage: { input_tokens: 2, output_tokens: 3 },
                },
                {
                    type: "item.completed",
                    item: {
                        type: "command_execution",
                        command: "echo ignored",
                    },
                },
                {
                    type: "item.completed",
                    item: { type: "agent_message", text: "second" },
                },
            ])

            const result = await runCodexOneShot({
                prompt: "do work",
                cwd: dir,
                codexBin: bin,
                skipGitRepoCheck: true,
            })

            assert.equal(result, "first\nsecond")
        })
    })

    it("passes configured command arguments to the fake Codex process", async () => {
        await withTempDir("baro-codex-one-shot-args-", async (dir) => {
            const { bin, argsPath } = writeFakeCodexArgCapture(dir)

            await runCodexOneShot({
                prompt: "do configured work",
                cwd: dir,
                codexBin: bin,
                skipGitRepoCheck: true,
                bypassSandbox: true,
                model: "gpt-test",
            })

            assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-test",
                "do configured work",
            ])
        })
    })

    it("rejects when Codex exits successfully without an agent message", async () => {
        await withTempDir("baro-codex-one-shot-empty-", async (dir) => {
            const bin = writeFakeCodex(dir, [
                {
                    type: "turn.completed",
                    usage: { input_tokens: 2, output_tokens: 3 },
                },
            ])

            await assert.rejects(
                runCodexOneShot({
                    prompt: "do work",
                    cwd: dir,
                    codexBin: bin,
                    skipGitRepoCheck: true,
                }),
                /runCodexOneShot: codex produced no agent_message/,
            )
        })
    })
})
