import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createAwakeDeadline,
    createFakeAwakeClock,
} from "../../src/runtime/awake-clock.js"
import {
    installAwakeGapReporter,
    trackAwakeBudget,
} from "../../src/runtime/awake-clock-log.js"

const HOUR_MS = 60 * 60_000
const START_WALL_MS = 1_700_000_000_000

/** Captures the protocol lines a synchronous action writes to stdout. */
function captureStream(action: () => void): Array<Record<string, unknown>> {
    const written: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string) => {
        written.push(String(chunk))
        return true
    }) as typeof process.stdout.write
    try {
        action()
    } finally {
        process.stdout.write = original
    }
    return written.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("installAwakeGapReporter", () => {
    it("reports one absorbed gap as one event carrying the gap and both elapsed times", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        installAwakeGapReporter(clock)

        clock.advance(60_000)
        const lines = captureStream(() => {
            clock.suspend(3 * HOUR_MS)
            clock.sample()
        })

        assert.equal(lines.length, 1)
        const { ts, ...event } = lines[0]!
        assert.equal(typeof ts, "string")
        assert.deepEqual(event, {
            type: "suspension_gap_absorbed",
            gap_ms: 3 * HOUR_MS,
            // No adopter registered a budget, so the gap is unattributed.
            budget: "*",
            awake_elapsed_ms: 60_000,
            wall_elapsed_ms: 60_000 + 3 * HOUR_MS,
        })
    })

    it("names the armed budget closest to expiry", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        installAwakeGapReporter(clock)

        const phase = createAwakeDeadline({
            budget: "architect-phase",
            timeoutMs: 30 * 60_000,
            onExpired: () => assert.fail("phase budget must not expire"),
            clock,
        })
        const gate = createAwakeDeadline({
            budget: "verification-gate",
            timeoutMs: 5 * 60_000,
            onExpired: () => assert.fail("gate budget must not expire"),
            clock,
        })
        const releases = [trackAwakeBudget(phase), trackAwakeBudget(gate)]

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.budget, "verification-gate")
            assert.equal(lines[0]!.gap_ms, 3 * HOUR_MS)
        } finally {
            for (const release of releases) release()
            phase.close()
            gate.close()
        }
    })

    it("ignores a spent registration rather than letting it own every later gap", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        installAwakeGapReporter(clock)

        // A handle its owner closed without releasing the registration: its
        // remaining time is frozen at 0, which must not beat a live budget.
        const spent = createAwakeDeadline({
            budget: "goal-review",
            timeoutMs: 60_000,
            onExpired: () => {},
            clock,
        })
        clock.advance(60_000)
        spent.close()
        const live = createAwakeDeadline({
            budget: "harness-liveness",
            timeoutMs: 30 * 60_000,
            onExpired: () => assert.fail("live budget must not expire on a suspend"),
            clock,
        })
        const releases = [trackAwakeBudget(spent), trackAwakeBudget(live)]

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.budget, "harness-liveness")
        } finally {
            for (const release of releases) release()
            live.close()
        }
    })

    it("emits once for a gap spanning several armed deadlines, and installs once per clock", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const uninstall = installAwakeGapReporter(clock)
        assert.equal(
            installAwakeGapReporter(clock),
            uninstall,
            "a second install must return the existing unsubscribe",
        )

        const deadlines = (
            [
                ["architect-phase", 30 * 60_000],
                ["board-soft-deadline", 20 * 60_000],
                ["verification-gate", 10 * 60_000],
            ] as const
        ).map(([budget, timeoutMs]) =>
            createAwakeDeadline({
                budget,
                timeoutMs,
                onExpired: () => assert.fail(`${budget} must not expire on a suspend`),
                clock,
            }),
        )

        try {
            // Every armed deadline re-checks the clock as it fires, but only
            // the first read absorbs the gap, so only one line is written.
            const lines = captureStream(() => {
                clock.suspend(3 * HOUR_MS)
                clock.sample()
            })
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.type, "suspension_gap_absorbed")
        } finally {
            for (const deadline of deadlines) deadline.close()
            uninstall()
        }
    })

    it("writes nothing when no drift crosses the suspension threshold", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        installAwakeGapReporter(clock)

        const lines = captureStream(() => {
            for (const step of [1, 500, 60_000, 30 * 60_000]) {
                clock.advance(step)
                clock.sample()
            }
            clock.suspend(1_999)
            clock.sample()
        })

        assert.deepEqual(lines, [])
        assert.equal(clock.absorbedGapMs(), 0)
    })

    it("stops reporting once uninstalled", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const uninstall = installAwakeGapReporter(clock)
        uninstall()

        const lines = captureStream(() => {
            clock.suspend(3 * HOUR_MS)
            clock.sample()
        })

        assert.deepEqual(lines, [])
        // A later install re-subscribes rather than reusing the dead entry.
        const reinstall = installAwakeGapReporter(clock)
        try {
            const reported = captureStream(() => {
                clock.suspend(2 * HOUR_MS)
                clock.sample()
            })
            assert.equal(reported.length, 1)
            assert.equal(reported[0]!.gap_ms, 2 * HOUR_MS)
        } finally {
            reinstall()
        }
    })
})
