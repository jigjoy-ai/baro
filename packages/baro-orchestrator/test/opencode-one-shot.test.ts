import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runOpenCodeOneShot } from "../src/opencode-one-shot.js"
import { withTempDir } from "./participants/helpers.js"

function writeFakeOpenCode(
    dir: string,
    lines: unknown[],
    opts: { captureArgvPath?: string; exitCode?: number } = {},
): string {
    const bin = join(dir, "fake-opencode.mjs")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const captureArgvPath = ${JSON.stringify(opts.captureArgvPath ?? null)};
if (captureArgvPath) {
  writeFileSync(captureArgvPath, JSON.stringify(process.argv.slice(2)));
}

const lines = ${JSON.stringify(lines)};
for (const line of lines) {
  if (typeof line === "string") {
    console.log(line);
  } else {
    console.log(JSON.stringify(line));
  }
}

process.exit(${opts.exitCode ?? 0});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("runOpenCodeOneShot", () => {
    it("returns concatenated text events and ignores non-result output", async () => {
        await withTempDir("baro-opencode-one-shot-", async (dir) => {
            const bin = writeFakeOpenCode(dir, [
                "not json",
                {
                    type: "tool_use",
                    part: { type: "tool", tool: "write" },
                },
                {
                    type: "text",
                    part: { type: "text", text: "first" },
                },
                {
                    type: "step_finish",
                    part: { tokens: { input: 2, output: 3 } },
                },
                {
                    type: "text",
                    part: { type: "text", text: "second" },
                },
            ])

            const result = await runOpenCodeOneShot({
                prompt: "collect text",
                cwd: dir,
                opencodeBin: bin,
            })

            assert.equal(result, "first\nsecond")
        })
    })

    it("passes configured argv to the opencode binary", async () => {
        await withTempDir("baro-opencode-one-shot-argv-", async (dir) => {
            const captureArgvPath = join(dir, "argv.json")
            const bin = writeFakeOpenCode(
                dir,
                [
                    {
                        type: "text",
                        part: { type: "text", text: "done" },
                    },
                ],
                { captureArgvPath },
            )

            await runOpenCodeOneShot({
                prompt: "do configured work",
                cwd: dir,
                opencodeBin: bin,
                model: "anthropic/test",
            })

            assert.deepEqual(
                JSON.parse(readFileSync(captureArgvPath, "utf8")) as string[],
                [
                    "run",
                    "--format",
                    "json",
                    "--dangerously-skip-permissions",
                    "-m",
                    "anthropic/test",
                    "--dir",
                    dir,
                    "do configured work",
                ],
            )
        })
    })

    it("rejects abnormal termination even after text output", async () => {
        await withTempDir("baro-opencode-one-shot-fail-", async (dir) => {
            const bin = writeFakeOpenCode(
                dir,
                [
                    {
                        type: "text",
                        part: { type: "text", text: "partial" },
                    },
                ],
                { exitCode: 7 },
            )

            await assert.rejects(
                runOpenCodeOneShot({
                    prompt: "fail after text",
                    cwd: dir,
                    opencodeBin: bin,
                }),
                /runOpenCodeOneShot: opencode terminated abnormally before completing/,
            )
        })
    })
})
