import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runPiOneShot } from "../src/pi-one-shot.js"
import { withTempDir } from "./participants/helpers.js"

function writeFakePiEvents(
    dir: string,
    name: string,
    events: Record<string, unknown>[],
    options: { invalidJson?: boolean; exitCode?: number } = {},
): string {
    const bin = join(dir, `${name}.mjs`)
    writeFileSync(
        bin,
        `#!/usr/bin/env node
const events = ${JSON.stringify(events)};
if (${JSON.stringify(options.invalidJson ?? false)}) {
    process.stdout.write("not json\\n");
}
for (let i = 0; i < events.length; i += 1) {
    process.stdout.write(JSON.stringify(events[i]));
    if (i < events.length - 1) process.stdout.write("\\n");
}
process.exit(${JSON.stringify(options.exitCode ?? 0)});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakePiArgvCapture(dir: string, capturePath: string): string {
    const bin = join(dir, "fake-pi-argv.mjs")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
    },
}));
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("runPiOneShot", () => {
    it("returns assistant message_end text and flushes final newline-less stdout", async () => {
        await withTempDir("baro-pi-one-shot-", async (dir) => {
            const bin = writeFakePiEvents(
                dir,
                "fake-pi-success",
                [
                    {
                        type: "tool_execution_start",
                        toolName: "bash",
                    },
                    {
                        type: "message_update",
                        assistantMessageEvent: {
                            type: "toolcall_start",
                            toolCall: { name: "read_file" },
                        },
                    },
                    {
                        type: "message_end",
                        message: {
                            role: "user",
                            content: [{ type: "text", text: "ignored user text" }],
                        },
                    },
                    {
                        type: "message_end",
                        message: {
                            role: "assistant",
                            usage: { input: 2, output: 3 },
                            content: [{ type: "tool_use", text: "ignored tool text" }],
                        },
                    },
                    {
                        type: "message_end",
                        message: {
                            role: "assistant",
                            content: [{ type: "text", text: "first" }],
                        },
                    },
                    {
                        type: "message_end",
                        message: {
                            role: "assistant",
                            content: [{ type: "text", text: "second" }],
                        },
                    },
                ],
                { invalidJson: true },
            )

            const text = await runPiOneShot({
                prompt: "do work",
                cwd: dir,
                piBin: bin,
            })

            assert.equal(text, "first\nsecond")
        })
    })

    it("passes configured argv to pi", async () => {
        await withTempDir("baro-pi-one-shot-argv-", async (dir) => {
            const capturePath = join(dir, "argv.json")
            const bin = writeFakePiArgvCapture(dir, capturePath)

            await runPiOneShot({
                prompt: "do configured work",
                cwd: dir,
                piBin: bin,
                provider: "google",
                model: "gemini-test",
            })

            assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), [
                "--mode",
                "json",
                "-p",
                "--no-session",
                "--provider",
                "google",
                "--model",
                "gemini-test",
                "do configured work",
            ])
        })
    })

    it("rejects abnormal termination even after assistant text", async () => {
        await withTempDir("baro-pi-one-shot-fail-", async (dir) => {
            const bin = writeFakePiEvents(
                dir,
                "fake-pi-fail",
                [
                    {
                        type: "message_end",
                        message: {
                            role: "assistant",
                            content: [{ type: "text", text: "partial" }],
                        },
                    },
                ],
                { exitCode: 7 },
            )

            await assert.rejects(
                runPiOneShot({
                    prompt: "do work",
                    cwd: dir,
                    piBin: bin,
                }),
                /runPiOneShot: pi terminated abnormally before completing/,
            )
        })
    })
})
