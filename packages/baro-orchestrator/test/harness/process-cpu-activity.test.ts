import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    CPU_ACTIVE_MIN_FRACTION,
    CPU_ADVANCE_MIN_DELTA_MS,
    CPU_PROBE_TIMEOUT_MS,
    cpuAdvanced,
    sampleProcessTreeCpu,
    type ProcessCpuRow,
} from "../../src/harness/process-cpu-activity.js"

const table = (...rows: ProcessCpuRow[]) => async () => rows

describe("process CPU activity sampling", () => {
    it("sums the root and every descendant, ignoring unrelated processes", async () => {
        const sample = await sampleProcessTreeCpu(
            100,
            table(
                { pid: 100, parentPid: 1, cpuMs: 1_000 },
                { pid: 200, parentPid: 100, cpuMs: 2_000 },
                { pid: 300, parentPid: 200, cpuMs: 4_000 },
                { pid: 400, parentPid: 1, cpuMs: 8_000 },
            ),
        )

        assert.equal(sample.observed, true)
        assert.equal(sample.totalCpuMs, 7_000)
    })

    it("reports an observed zero for a root that has already vanished", async () => {
        const sample = await sampleProcessTreeCpu(
            999,
            table({ pid: 100, parentPid: 1, cpuMs: 1_000 }),
        )

        assert.equal(sample.observed, true)
        assert.equal(sample.totalCpuMs, 0)
    })

    it("treats an unreadable process table as unobservable, never as idle", async () => {
        const unreadable = await sampleProcessTreeCpu(100, async () => null)
        const threw = await sampleProcessTreeCpu(100, async () => {
            throw new Error("ps exploded")
        })

        for (const sample of [unreadable, threw]) {
            assert.equal(sample.observed, false)
            assert.equal(sample.totalCpuMs, null)
        }
        // The watchdog asks cpuAdvanced, so "cannot tell" must read as busy in
        // either position — a stale-but-observed baseline must not kill either.
        const observed = { at: 0, totalCpuMs: 5_000, observed: true }
        assert.equal(cpuAdvanced(unreadable, observed), true)
        assert.equal(cpuAdvanced(observed, unreadable), true)
        assert.equal(cpuAdvanced(unreadable, threw), true)
    })

    it("counts advance only at or above the minimum delta", async () => {
        const previous = { at: 0, totalCpuMs: 10_000, observed: true }

        assert.equal(
            cpuAdvanced(previous, { at: 1, totalCpuMs: 10_999, observed: true }),
            false,
        )
        assert.equal(
            cpuAdvanced(previous, {
                at: 1,
                totalCpuMs: 10_000 + CPU_ADVANCE_MIN_DELTA_MS,
                observed: true,
            }),
            true,
        )
        // A tree that lost its busiest child goes backwards; that is not advance.
        assert.equal(
            cpuAdvanced(previous, { at: 1, totalCpuMs: 0, observed: true }),
            false,
        )
        assert.equal(
            cpuAdvanced(previous, { at: 1, totalCpuMs: 10_500, observed: true }, 500),
            true,
        )
    })

    it("scales the bar with the window, so a near-idle long window reads idle", () => {
        const previous = { at: 0, totalCpuMs: 10_000, observed: true }
        const longWindow = 300_000

        assert.equal(
            cpuAdvanced(previous, {
                at: longWindow,
                totalCpuMs: 10_000 + 5_000,
                observed: true,
            }),
            false,
            "5s of CPU across 5 minutes is a near-idle tree",
        )
        assert.equal(
            cpuAdvanced(previous, {
                at: longWindow,
                totalCpuMs: 10_000 + longWindow * CPU_ACTIVE_MIN_FRACTION,
                observed: true,
            }),
            true,
        )
    })

    it(
        "reads and parses real ps output for this very process",
        { skip: process.platform === "win32" },
        async () => {
            const sample = await sampleProcessTreeCpu(process.pid)

            assert.equal(sample.observed, true, "default ps reader returned no table")
            assert.ok(
                typeof sample.totalCpuMs === "number" && sample.totalCpuMs > 0,
                `this process has burnt CPU, got ${sample.totalCpuMs}`,
            )
        },
    )

    it("bounds the probe with the same window the watchdog races against", () => {
        assert.equal(CPU_PROBE_TIMEOUT_MS, 5_000)
        assert.equal(CPU_ADVANCE_MIN_DELTA_MS, 1_000)
    })
})
