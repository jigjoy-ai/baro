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

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) {
            assert.fail(`fixture did not create ${path}`)
        }
        await delay(10)
    }
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

    it("settles an asynchronous spawn error exactly once", async () => {
        await withTempDir("baro-exec-spawn-error-", async (dir) => {
            await assert.rejects(
                execFileCli(join(dir, "missing-cli"), []),
                { code: "ENOENT" },
            )
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
    stdio: ["ignore", "inherit", "inherit"],
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

    it(
        "cleans an inherited-stdio descendant after a natural root exit",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-exec-natural-tree-", async (dir) => {
                const escaped = join(dir, "descendant-escaped")
                const bin = writeCli(
                    dir,
                    `
import { spawn } from "node:child_process";
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 700);
setInterval(() => {}, 10_000);
`)};
const descendant = spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
console.log("ready");
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(0);
`,
                )

                const result = await execFileCli(bin, [], {
                    terminationGraceMs: 50,
                })

                assert.equal(result.stdout, "ready\n")
                await delay(750)
                assert.equal(
                    existsSync(escaped),
                    false,
                    "descendant survived the natural root-exit cleanup",
                )
            })
        },
    )

    it("honors an abort that arrives after the direct root exits", async () => {
        await withTempDir("baro-exec-late-abort-", async (dir) => {
            const rootExited = join(dir, "root-exited")
            const escaped = join(dir, "descendant-escaped")
            const bin = writeCli(
                dir,
                `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 1_300);
setInterval(() => {}, 10_000);
`)};
const descendant = spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
console.log("ready");
await new Promise((resolve) => setTimeout(resolve, 150));
writeFileSync(${JSON.stringify(rootExited)}, "yes");
process.exit(0);
`,
            )
            const controller = new AbortController()
            const pending = execFileCli(bin, [], {
                signal: controller.signal,
                terminationGraceMs: 1_000,
            })

            await waitForFile(rootExited)
            await delay(75)
            const abortedAt = Date.now()
            controller.abort()

            await assert.rejects(pending, { name: "AbortError" })
            assert.ok(
                Date.now() - abortedAt < 2_500,
                "late abort exceeded the bounded cleanup window",
            )
            await delay(350)
            assert.equal(
                existsSync(escaped),
                false,
                "descendant survived late-abort cleanup",
            )
        })
    })
})
