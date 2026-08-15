import {
    chmodSync,
    existsSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { execFileCli, execFileCliBuffer } from "../../src/harness/exec-file-cli.js"
import {
    SPAWNED_FIXTURE_DEADLINE_MS,
    withTempDir,
} from "../execution/helpers.js"

function writeCli(dir: string, source: string): string {
    const path = join(dir, "fake-cli.mjs")
    writeFileSync(path, `#!/usr/bin/env node\n${source}`)
    chmodSync(path, 0o755)
    return path
}

async function waitForFile(path: string, timeoutMs = SPAWNED_FIXTURE_DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) {
            assert.fail(`fixture did not create ${path}`)
        }
        await delay(10)
    }
}


/** A clock the test drives. Records what the watchdogs asked for so their
 *  behaviour can be asserted, and fires only when told to. */
class RecordingClock {
    readonly arms: number[] = []
    cleared = 0
    fired = 0
    private pending: (() => void) | null = null

    setTimeout(callback: () => void, ms: number): unknown {
        this.arms.push(ms)
        this.pending = callback
        return this.arms.length
    }

    clearTimeout(_handle: unknown): void {
        this.cleared += 1
        this.pending = null
    }

    /** Wait for the watchdog to arm, then fire it. */
    async fireWhenArmed(): Promise<void> {
        const deadline = Date.now() + SPAWNED_FIXTURE_DEADLINE_MS
        while (!this.pending) {
            if (Date.now() >= deadline) throw new Error("watchdog never armed")
            await delay(5)
        }
        const fire = this.pending
        this.pending = null
        this.fired += 1
        fire()
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

    it("preserves exact UTF-8 bytes split across stdout chunks", async () => {
        await withTempDir("baro-exec-cli-utf8-", async (dir) => {
            const bin = writeCli(dir, `
process.stdout.write(Buffer.from([0xe2]));
setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 25);
`)
            const bytes = await execFileCliBuffer(bin, [])
            assert.deepEqual(bytes.stdout, Buffer.from("€", "utf8"))

            const text = await execFileCli(bin, [])
            assert.equal(text.stdout, "€")
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
import { writeFileSync } from "node:fs";
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setInterval(() => writeFileSync(process.env.BARO_TEST_ESCAPED, "yes"), 100);
`)};
const descendant = spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.BARO_TEST_STARTED, String(descendant.pid));
setTimeout(() => process.exit(0), 120_000).unref?.(); setInterval(() => {}, 10_000);
`,
            )

            await assert.rejects(
                execFileCli(bin, [], {
                    env: {
                        ...process.env,
                        BARO_TEST_STARTED: started,
                        BARO_TEST_ESCAPED: escaped,
                    },
                    timeout: 3_000,
                    terminationGraceMs: 75,
                }),
                (error: Error & { killed?: boolean }) => {
                    assert.equal(error.killed, true)
                    assert.match(error.message, /timed out/)
                    return true
                },
            )

            assert.equal(existsSync(started), true, "descendant was never spawned")
            rmSync(escaped, { force: true })
            await delay(350)
            assert.equal(
                existsSync(escaped),
                false,
                "TERM-resistant descendant survived CLI timeout escalation",
            )
        })
    })

    it("rearms the idle clock on every chunk, and only on a chunk", async () => {
        await withTempDir("baro-exec-idle-rearm-", async (dir) => {
            const bin = writeCli(dir, `
let ticks = 0;
const timer = setInterval(() => {
    process.stdout.write("tick " + ticks + "\\n");
    if (++ticks >= 4) { clearInterval(timer); }
}, 5);
`)
            const clock = new RecordingClock()
            const result = await execFileCli(bin, [], {
                idleTimeoutMs: 900,
                timers: clock,
            })

            assert.match(result.stdout.toString(), /tick 3/)
            // One arm before any output, then exactly one rearm per chunk, each
            // cancelling the arm before it. Nothing here waited on the machine.
            assert.ok(clock.arms.length >= 2, `armed ${clock.arms.length} times`)
            assert.ok(
                clock.arms.every((ms) => ms === 900),
                "every arm uses the caller's window",
            )
            assert.equal(
                clock.cleared,
                clock.arms.length,
                "each rearm cancels its predecessor, and settling cancels the last",
            )
            assert.equal(clock.fired, 0, "a talking process is never presumed hung")
        })
    })

    it("kills a process the idle clock declares silent, without waiting for it", async () => {
        await withTempDir("baro-exec-idle-silent-", async (dir) => {
            const bin = writeCli(dir, `setTimeout(() => process.exit(0), 120_000).unref?.(); setInterval(() => {}, 10_000);`)
            const clock = new RecordingClock()
            const run = execFileCli(bin, [], {
                idleTimeoutMs: 900,
                timers: clock,
            })

            // Drive the window rather than sleep through it.
            await clock.fireWhenArmed()
            await assert.rejects(run, /produced no output for 900ms/u)
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
setInterval(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 100);
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
                rmSync(escaped, { force: true })
                await delay(350)
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
setInterval(() => writeFileSync(${JSON.stringify(escaped)}, "yes"), 100);
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
            // A dead descendant cannot recreate the marker; a survivor
            // rewrites it within 100ms. No knife-edge timer race.
            rmSync(escaped, { force: true })
            await delay(350)
            assert.equal(
                existsSync(escaped),
                false,
                "descendant survived late-abort cleanup",
            )
        })
    })
})
