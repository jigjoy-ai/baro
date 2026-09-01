import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import {
    execFileCli,
    type CpuActivityProbe,
} from "../../src/harness/exec-file-cli.js"
import {
    CPU_PROBE_TIMEOUT_MS,
    type CpuActivitySample,
} from "../../src/harness/process-cpu-activity.js"
import { SPAWNED_FIXTURE_DEADLINE_MS, withTempDir } from "../execution/helpers.js"

const IDLE_MS = 900

/**
 * Silent by default: it only speaks or exits when the test drops the matching
 * file, so every window boundary below is decided by the test, never by timing.
 */
const FIXTURE = `
import { existsSync } from "node:fs";
const speak = process.env.BARO_TEST_SPEAK;
const stop = process.env.BARO_TEST_STOP;
let spoken = false;
const tick = setInterval(() => {
    if (!spoken && existsSync(speak)) { spoken = true; process.stdout.write("awake\\n"); }
    if (existsSync(stop)) { clearInterval(tick); process.exit(0); }
}, 10);
`

/** Multi-handle clock: every armed window is addressable by its duration. */
class ManualClock {
    private readonly armed = new Map<number, { ms: number; fire: () => void }>()
    private nextHandle = 1

    setTimeout(callback: () => void, ms: number): unknown {
        const handle = this.nextHandle++
        this.armed.set(handle, { ms, fire: callback })
        return handle
    }

    clearTimeout(handle: unknown): void {
        this.armed.delete(handle as number)
    }

    armedFor(ms: number): number {
        return [...this.armed.values()].filter((entry) => entry.ms === ms).length
    }

    async fire(ms: number): Promise<void> {
        const deadline = Date.now() + SPAWNED_FIXTURE_DEADLINE_MS
        for (;;) {
            const entry = [...this.armed.entries()].find(([, e]) => e.ms === ms)
            if (entry) {
                this.armed.delete(entry[0])
                entry[1].fire()
                return
            }
            if (Date.now() >= deadline) throw new Error(`no ${ms}ms window armed`)
            await delay(5)
        }
    }

    async waitForArm(ms: number, atLeast = 1): Promise<void> {
        const deadline = Date.now() + SPAWNED_FIXTURE_DEADLINE_MS
        while (this.armedFor(ms) < atLeast) {
            if (Date.now() >= deadline) throw new Error(`no ${ms}ms window armed`)
            await delay(5)
        }
    }
}

function sample(totalCpuMs: number | null, observed = true): CpuActivitySample {
    return { at: Date.now(), totalCpuMs, observed }
}

interface Harness {
    readonly run: Promise<{ stdout: string; stderr: string }>
    readonly clock: ManualClock
    readonly probeCalls: Array<CpuActivitySample | null>
    speak(): void
    stop(): void
}

async function withFixture(
    prefix: string,
    probe: CpuActivityProbe | undefined,
    options: { timeout?: number } = {},
    body: (harness: Harness) => Promise<void>,
): Promise<void> {
    await withTempDir(prefix, async (dir) => {
        const bin = join(dir, "silent-cli.mjs")
        writeFileSync(bin, `#!/usr/bin/env node\n${FIXTURE}`)
        chmodSync(bin, 0o755)
        const speakPath = join(dir, "speak")
        const stopPath = join(dir, "stop")
        const clock = new ManualClock()
        const probeCalls: Array<CpuActivitySample | null> = []
        const run = execFileCli(bin, [], {
            env: {
                ...process.env,
                BARO_TEST_SPEAK: speakPath,
                BARO_TEST_STOP: stopPath,
            },
            idleTimeoutMs: IDLE_MS,
            terminationGraceMs: 75,
            timers: clock,
            ...(options.timeout ? { timeout: options.timeout } : {}),
            ...(probe
                ? {
                      cpuActivityProbe: (rootPid, previous) => {
                          probeCalls.push(previous)
                          return probe(rootPid, previous)
                      },
                  }
                : {}),
        })
        try {
            await body({
                run,
                clock,
                probeCalls,
                speak: () => writeFileSync(speakPath, ""),
                stop: () => writeFileSync(stopPath, ""),
            })
        } finally {
            writeFileSync(stopPath, "")
            await run.catch(() => undefined)
        }
    })
}

describe("execFileCli CPU-aware idle watchdog", () => {
    it("extends the window for a silent process whose tree is still burning CPU", async () => {
        const samples = [sample(4_000), sample(9_000)]
        await withFixture(
            "baro-exec-cpu-busy-",
            async (_pid, previous) => ({
                active: true,
                sample: samples[previous === null ? 0 : 1]!,
            }),
            {},
            async ({ run, clock, probeCalls, stop }) => {
                await clock.fire(IDLE_MS)
                await clock.waitForArm(IDLE_MS)
                assert.deepEqual(probeCalls, [null], "first expiry has no baseline")

                await clock.fire(IDLE_MS)
                await clock.waitForArm(IDLE_MS)
                assert.equal(probeCalls.length, 2)
                assert.equal(
                    probeCalls[1],
                    samples[0],
                    "the previous expiry's sample is carried into the next probe",
                )

                stop()
                const result = await run
                assert.equal(result.stdout, "", "the fixture never spoke, yet lived")
            },
        )
    })

    it("kills a silent process once a later probe measures no CPU advance", async () => {
        let expiry = 0
        await withFixture(
            "baro-exec-cpu-idle-",
            async () => ({ active: expiry++ > 0 ? false : true, sample: sample(4_000) }),
            {},
            async ({ run, clock }) => {
                await clock.fire(IDLE_MS)
                await clock.waitForArm(IDLE_MS)

                await clock.fire(IDLE_MS)
                await assert.rejects(
                    run,
                    (error: Error & { killed?: boolean }) => {
                        assert.equal(error.killed, true)
                        assert.match(
                            error.message,
                            new RegExp(
                                ` produced no output for ${IDLE_MS}ms — presumed hung$`,
                                "u",
                            ),
                        )
                        return true
                    },
                )
            },
        )
    })

    it("kills at the first expiry when the real default probe measures no CPU advance", async () => {
        await withFixture(
            "baro-exec-cpu-default-",
            undefined,
            {},
            async ({ run, clock }) => {
                await clock.fire(IDLE_MS)
                await assert.rejects(
                    run,
                    (error: Error & { killed?: boolean }) => {
                        assert.equal(error.killed, true)
                        assert.match(
                            error.message,
                            new RegExp(
                                ` produced no output for ${IDLE_MS}ms — presumed hung$`,
                                "u",
                            ),
                        )
                        return true
                    },
                )
            },
        )
    })

    it("treats a hung probe as busy once its own race window expires", async () => {
        await withFixture(
            "baro-exec-cpu-hung-probe-",
            () => new Promise(() => {}),
            {},
            async ({ run, clock, stop }) => {
                await clock.fire(IDLE_MS)
                await clock.waitForArm(CPU_PROBE_TIMEOUT_MS)

                await clock.fire(CPU_PROBE_TIMEOUT_MS)
                await clock.waitForArm(IDLE_MS)
                assert.equal(
                    clock.armedFor(CPU_PROBE_TIMEOUT_MS),
                    0,
                    "the race window must not outlive the probe it bounded",
                )

                stop()
                await run
            },
        )
    })

    it("treats a rejecting probe as busy", async () => {
        await withFixture(
            "baro-exec-cpu-probe-throws-",
            async () => {
                throw new Error("ps exploded")
            },
            {},
            async ({ run, clock, stop }) => {
                await clock.fire(IDLE_MS)
                await clock.waitForArm(IDLE_MS)

                stop()
                await run
            },
        )
    })

    it("does not kill on a probe verdict overtaken by real output", async () => {
        let release: ((verdict: { active: boolean; sample: CpuActivitySample }) => void) | undefined
        await withFixture(
            "baro-exec-cpu-late-verdict-",
            () => new Promise((resolve) => { release = resolve }),
            {},
            async ({ run, clock, speak, stop }) => {
                await clock.fire(IDLE_MS)
                while (!release) await delay(5)

                // Output lands mid-probe, so the in-flight verdict is stale.
                speak()
                await clock.waitForArm(IDLE_MS)

                release({ active: false, sample: sample(4_000) })
                await delay(50)

                stop()
                const result = await run
                assert.equal(result.stdout, "awake\n")
            },
        )
    })

    it("terminates at the absolute ceiling even while the probe says busy", async () => {
        await withFixture(
            "baro-exec-cpu-ceiling-",
            async () => ({ active: true, sample: sample(4_000) }),
            { timeout: 600_000 },
            async ({ run, clock }) => {
                await clock.fire(IDLE_MS)
                await clock.waitForArm(IDLE_MS)

                await clock.fire(600_000)
                await assert.rejects(
                    run,
                    (error: Error & { killed?: boolean }) => {
                        assert.equal(error.killed, true)
                        assert.match(
                            error.message,
                            /timed out after 600000ms — exceeded the absolute command ceiling$/u,
                        )
                        return true
                    },
                )
            },
        )
    })

    it("never probes a command that finishes inside its window", async () => {
        await withFixture(
            "baro-exec-cpu-quiet-exit-",
            async () => ({ active: true, sample: sample(4_000) }),
            {},
            async ({ run, clock, probeCalls, stop }) => {
                stop()
                await run
                assert.deepEqual(probeCalls, [])
                assert.equal(clock.armedFor(IDLE_MS), 0, "settling clears the window")
            },
        )
    })
})
