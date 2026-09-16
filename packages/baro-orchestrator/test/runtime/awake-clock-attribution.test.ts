import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { IdleWatchdog } from "../../src/harness/liveness.js"
import {
    createAwakeDeadline,
    createFakeAwakeClock,
    type AwakeDeadline,
} from "../../src/runtime/awake-clock.js"
import { installAwakeGapReporter } from "../../src/runtime/awake-clock-log.js"

const HOUR_MS = 60 * 60_000

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

function armed(
    clock: ReturnType<typeof createFakeAwakeClock>,
    budget: "architect-phase" | "board-soft-deadline" | "verification-gate",
    timeoutMs: number,
): AwakeDeadline {
    return createAwakeDeadline({
        budget,
        timeoutMs,
        onExpired: () => assert.fail(`${budget} must not expire on a suspend`),
        clock,
    })
}

describe("absorbed gaps name the budget they hit", () => {
    it("names an armed deadline no adopter registered by hand", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        const gate = armed(clock, "verification-gate", 10 * 60_000)

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.budget, "verification-gate")
            assert.equal(lines[0]!.gap_ms, 3 * HOUR_MS)
        } finally {
            gate.close()
        }
    })

    it("names the armed budget closest to expiry when several are live", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        const deadlines = [
            armed(clock, "architect-phase", 30 * 60_000),
            armed(clock, "board-soft-deadline", 20 * 60_000),
            armed(clock, "verification-gate", 10 * 60_000),
        ]

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.budget, "verification-gate")
        } finally {
            for (const deadline of deadlines) deadline.close()
        }
    })

    it("reports * again once every deadline is closed", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        armed(clock, "board-soft-deadline", 20 * 60_000).close()

        // Nothing is armed, so no timer fire samples the clock for us.
        const lines = captureStream(() => {
            clock.suspend(3 * HOUR_MS)
            clock.sample()
        })
        assert.equal(lines.length, 1)
        assert.equal(lines[0]!.budget, "*")
    })

    it("keeps attributing across a close-and-rebuild re-arm", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        // The board's split hop: the handle is closed and rebuilt on every
        // re-arm, so a registration that outlived its handle would pin the
        // attribution at a dead deadline with 0 remaining.
        let board = armed(clock, "board-soft-deadline", 20 * 60_000)
        for (let hop = 0; hop < 3; hop += 1) {
            clock.advance(60_000)
            board.close()
            board = armed(clock, "board-soft-deadline", 20 * 60_000 - 60_000 * (hop + 1))
        }
        const phase = armed(clock, "architect-phase", 30 * 60_000)

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(
                lines[0]!.budget,
                "board-soft-deadline",
                "the live hop must win, not a closed one frozen at 0 remaining",
            )
        } finally {
            board.close()
            phase.close()
        }
    })

    it("lets a live budget win after a shorter one has already expired", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        let expired = 0
        const short = createAwakeDeadline({
            budget: "goal-review",
            timeoutMs: 60_000,
            onExpired: () => {
                expired += 1
            },
            clock,
        })
        const phase = armed(clock, "architect-phase", 30 * 60_000)

        try {
            clock.advance(60_000)
            assert.equal(expired, 1, "the short budget really was spent")
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.equal(lines[0]!.budget, "architect-phase")
        } finally {
            short.close()
            phase.close()
        }
    })

    it("names a real adopter's budget end to end", () => {
        const clock = createFakeAwakeClock()
        installAwakeGapReporter(clock)
        const watchdog = new IdleWatchdog(
            30 * 60_000,
            () => assert.fail("a suspend is not idleness the subprocess owes"),
            clock,
        )

        try {
            const lines = captureStream(() => clock.suspend(3 * HOUR_MS))
            assert.equal(lines.length, 1)
            assert.deepEqual(
                {
                    type: lines[0]!.type,
                    gap_ms: lines[0]!.gap_ms,
                    budget: lines[0]!.budget,
                },
                {
                    type: "suspension_gap_absorbed",
                    gap_ms: 3 * HOUR_MS,
                    budget: "harness-liveness",
                },
            )
        } finally {
            watchdog.dispose()
        }

        const afterDispose = captureStream(() => {
            clock.suspend(2 * HOUR_MS)
            clock.sample()
        })
        assert.equal(afterDispose.length, 1)
        assert.equal(afterDispose[0]!.budget, "*")
    })
})
