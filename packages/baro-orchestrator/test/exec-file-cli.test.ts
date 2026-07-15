import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { execFileCli } from "../src/exec-file-cli.js"
import { withTempDir } from "./participants/helpers.js"

function writeCli(dir: string, source: string): string {
    const path = join(dir, "fake-cli.mjs")
    writeFileSync(path, `#!/usr/bin/env node\n${source}`)
    chmodSync(path, 0o755)
    return path
}

describe("execFileCli process supervision", () => {
    it("returns clean CLI output", async () => {
        await withTempDir("baro-exec-cli-", async (dir) => {
            const bin = writeCli(dir, 'console.log("ready")')
            const result = await execFileCli(bin, [])
            assert.equal(result.stdout, "ready\n")
        })
    })

    it("delivers a large exact stdin payload without putting it on argv", async () => {
        await withTempDir("baro-exec-stdin-", async (dir) => {
            const captured = join(dir, "stdin.txt")
            const bin = writeCli(dir, `
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(captured)}, input);
console.log("ready");
`)
            const input = `large:${"x".repeat(40_000)}`
            const result = await execFileCli(bin, ["safe-flag"], { input })

            assert.equal(result.stdout, "ready\n")
            assert.equal(readFileSync(captured, "utf8"), input)
        })
    })

    it("escalates across the CLI process tree after timeout", async () => {
        await withTempDir("baro-exec-tree-", async (dir) => {
            const started = join(dir, "descendant-started")
            const escaped = join(dir, "descendant-escaped")
            const bin = writeCli(
                dir,
                `
import { spawn } from "node:child_process";
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.BARO_TEST_STARTED, "yes");
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(process.env.BARO_TEST_ESCAPED, "yes"), 2_000);
setInterval(() => {}, 10_000);
`)};
spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    env: process.env,
    stdio: "ignore",
});
setInterval(() => {}, 10_000);
`,
            )

            await assert.rejects(
                execFileCli(bin, [], {
                    env: {
                        ...process.env,
                        BARO_TEST_STARTED: started,
                        BARO_TEST_ESCAPED: escaped,
                    },
                    timeout: 1_200,
                    terminationGraceMs: 75,
                }),
                (error: Error & { killed?: boolean }) => {
                    assert.equal(error.killed, true)
                    assert.match(error.message, /timed out/)
                    return true
                },
            )

            assert.equal(existsSync(started), true, "descendant never started")
            await delay(2_050)
            assert.equal(
                existsSync(escaped),
                false,
                "TERM-resistant descendant survived CLI timeout escalation",
            )
        })
    })
})
