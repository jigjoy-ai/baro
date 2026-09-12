import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    execFileCli,
    type ExecFileCliTimers,
} from "../../src/harness/exec-file-cli.js"
import {
    CPU_PROBE_TIMEOUT_MS,
    type CpuActivitySample,
} from "../../src/harness/process-cpu-activity.js"
import {
    createFakeAwakeClock,
    type FakeAwakeClock,
} from "../../src/runtime/awake-clock.js"
import { withTempDir } from "../execution/helpers.js"

const IDLE_MS = 900
const CEILING_MS = 30_000
const SUSPEND_MS = 3 * 60 * 60 * 1_000

/** Silent and long-lived: every window below is closed by the fake clock. */
const FIXTURE = `setTimeout(() => process.exit(0), 120_000).unref?.(); setInterval(() => {}, 10_000);`

function writeCli(dir: string): string {
    const path = join(dir, "silent-cli.mjs")
    writeFileSync(path, `#!/usr/bin/env node\n${FIXTURE}`)
    chmodSync(path, 0o755)
    return path
}

/** Arms through the fake clock so `advance`/`suspend` drive the real windows,
 *  and records what each window asked for. */
function recordingTimers(clock: FakeAwakeClock): {
    timers: ExecFileCliTimers
    windowArms: () => number[]
} {
    const arms: number[] = []
    return {
        timers: {
            setTimeout: (callback, ms) => {
                arms.push(ms)
                return clock.setTimeout(callback, ms)
            },
            clearTimeout: (handle) => clock.clearTimeout(handle),
        },
        // The CPU probe's race bound is not one of the windows under test.
        windowArms: () => arms.filter((ms) => ms !== CPU_PROBE_TIMEOUT_MS),
    }
}

describe("execFileCli windows across a suspension", () => {
    it("re-arms the idle window across a suspend and expires at the original awake elapsed", async () => {
        await withTempDir("baro-exec-awake-idle-", async (dir) => {
            const bin = writeCli(dir)
            const clock = createFakeAwakeClock()
            const { timers, windowArms } = recordingTimers(clock)
            const probeCalls: Array<CpuActivitySample | null> = []
            const run = execFileCli(bin, [], {
                idleTimeoutMs: IDLE_MS,
                terminationGraceMs: 75,
                timers,
                awakeClock: clock,
                cpuActivityProbe: async (_pid, previous) => {
                    probeCalls.push(previous)
                    return {
                        active: false,
                        sample: { at: clock.awakeNow(), totalCpuMs: 0, observed: true },
                    }
                },
            })

            clock.advance(400)
            clock.suspend(SUSPEND_MS)

            assert.deepEqual(probeCalls, [], "sleep is not silence the child owes")
            assert.deepEqual(
                windowArms(),
                [IDLE_MS, IDLE_MS - 400],
                "the fired window re-arms for the awake time it still owes",
            )

            clock.advance(IDLE_MS - 400 - 1)
            assert.deepEqual(probeCalls, [], "one awake millisecond short of the window")

            clock.advance(1)
            await assert.rejects(
                run,
                new RegExp(
                    ` produced no output for ${IDLE_MS}ms — presumed hung$`,
                    "u",
                ),
            )
            assert.equal(probeCalls.length, 1, "expired exactly once")
            assert.deepEqual(
                windowArms(),
                [IDLE_MS, IDLE_MS - 400],
                "the absorbed gap bought no extra awake silence",
            )
        })
    })

    it("re-arms the absolute ceiling across a suspend and expires at the original awake elapsed", async () => {
        await withTempDir("baro-exec-awake-ceiling-", async (dir) => {
            const bin = writeCli(dir)
            const clock = createFakeAwakeClock()
            const { timers, windowArms } = recordingTimers(clock)
            const run = execFileCli(bin, [], {
                timeout: CEILING_MS,
                terminationGraceMs: 75,
                timers,
                awakeClock: clock,
            })

            clock.advance(1_000)
            clock.suspend(SUSPEND_MS)

            assert.deepEqual(
                windowArms(),
                [CEILING_MS, CEILING_MS - 1_000],
                "the ceiling re-arms rather than killing a slept-through child",
            )

            clock.advance(CEILING_MS - 1_000 - 1)
            assert.deepEqual(windowArms(), [CEILING_MS, CEILING_MS - 1_000])

            clock.advance(1)
            await assert.rejects(
                run,
                (error: Error & { killed?: boolean }) => {
                    assert.equal(error.killed, true)
                    assert.match(
                        error.message,
                        new RegExp(
                            ` timed out after ${CEILING_MS}ms — exceeded the absolute command ceiling$`,
                            "u",
                        ),
                    )
                    return true
                },
            )
        })
    })

    it("arms each window exactly once and expires at the same awake elapsed with no suspension", async () => {
        await withTempDir("baro-exec-awake-nogap-", async (dir) => {
            const bin = writeCli(dir)
            const clock = createFakeAwakeClock()
            const { timers, windowArms } = recordingTimers(clock)
            const probeCalls: Array<CpuActivitySample | null> = []
            const run = execFileCli(bin, [], {
                idleTimeoutMs: IDLE_MS,
                timeout: CEILING_MS,
                terminationGraceMs: 75,
                timers,
                awakeClock: clock,
                cpuActivityProbe: async (_pid, previous) => {
                    probeCalls.push(previous)
                    return {
                        active: false,
                        sample: { at: clock.awakeNow(), totalCpuMs: 0, observed: true },
                    }
                },
            })

            clock.advance(IDLE_MS - 1)
            assert.deepEqual(probeCalls, [])

            clock.advance(1)
            await assert.rejects(
                run,
                new RegExp(
                    ` produced no output for ${IDLE_MS}ms — presumed hung$`,
                    "u",
                ),
            )
            assert.equal(clock.absorbedGapMs(), 0, "nothing suspended")
            assert.deepEqual(
                windowArms(),
                [CEILING_MS, IDLE_MS],
                "no gap, no re-arm: each window is armed once for its full delay",
            )
        })
    })
})
