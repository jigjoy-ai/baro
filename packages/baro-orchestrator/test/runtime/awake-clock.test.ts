import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AWAKE_SPLIT_MAX_DELAY_MS,
    SUSPENSION_GAP_THRESHOLD_MS,
    createAwakeDeadline,
    createFakeAwakeClock,
    type AwakeClock,
    type FakeAwakeClock,
} from "../../src/runtime/awake-clock.js"

const HOUR_MS = 60 * 60_000
const START_WALL_MS = 1_700_000_000_000

/** The two properties that must hold after every single clock operation. */
function assertNeverAheadOfWall(clock: AwakeClock, previousAbsorbedMs: number): number {
    const absorbed = clock.absorbedGapMs()
    assert.ok(absorbed >= 0, `absorbed gap went negative: ${absorbed}`)
    assert.ok(
        absorbed >= previousAbsorbedMs,
        `absorbed gap shrank: ${previousAbsorbedMs} -> ${absorbed}`,
    )
    assert.ok(
        clock.awakeNow() <= clock.wallNow(),
        `awake time ran ahead of wall time`,
    )
    return absorbed
}

describe("awake clock", () => {
    it("(a) tracks wall time exactly and absorbs nothing when nothing suspends", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })

        assert.equal(clock.wallNow(), START_WALL_MS)
        assert.equal(clock.awakeNow(), START_WALL_MS)
        assert.equal(clock.absorbedGapMs(), 0)

        for (const step of [1, 500, 60_000, 30 * 60_000, 3 * HOUR_MS]) {
            clock.advance(step)
            assert.equal(clock.sample(), null)
            assert.equal(clock.awakeNow(), clock.wallNow())
            assert.equal(clock.absorbedGapMs(), 0)
        }

        assert.equal(clock.wallNow(), START_WALL_MS + 1 + 500 + 60_000 + 30 * 60_000 + 3 * HOUR_MS)
    })

    it("(a) ignores drift below the suspension threshold", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })

        for (let i = 0; i < 10; i += 1) {
            clock.suspend(SUSPENSION_GAP_THRESHOLD_MS - 1)
            assert.equal(clock.sample(), null)
            assert.equal(clock.absorbedGapMs(), 0)
            assert.equal(clock.awakeNow(), clock.wallNow())
        }
    })

    it("(b) absorbs one multi-hour suspension whole in a single sample", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        clock.advance(1_000)
        const awakeBeforeSuspend = clock.awakeNow()
        let absorbed = assertNeverAheadOfWall(clock, 0)

        clock.suspend(5 * HOUR_MS)
        const gap = clock.sample()

        assert.ok(gap !== null)
        assert.equal(gap.gapMs, 5 * HOUR_MS)
        assert.equal(gap.detectedAtWallMs, clock.wallNow())
        assert.equal(clock.absorbedGapMs(), 5 * HOUR_MS)
        // The whole suspension is subtracted, so no awake time passed.
        assert.equal(clock.awakeNow(), awakeBeforeSuspend)
        absorbed = assertNeverAheadOfWall(clock, absorbed)

        // Already-absorbed time is not counted a second time.
        assert.equal(clock.sample(), null)
        assert.equal(clock.absorbedGapMs(), 5 * HOUR_MS)
        assertNeverAheadOfWall(clock, absorbed)
    })

    it("(c) accumulates repeated above-threshold gaps additively and ignores the drift between them", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        let absorbed = 0
        let expectedAbsorbed = 0

        for (let i = 0; i < 6; i += 1) {
            clock.advance(100)
            assert.equal(clock.sample(), null)
            absorbed = assertNeverAheadOfWall(clock, absorbed)

            clock.suspend(SUSPENSION_GAP_THRESHOLD_MS - 1)
            assert.equal(clock.sample(), null)
            absorbed = assertNeverAheadOfWall(clock, absorbed)

            clock.suspend(3_000)
            const gap = clock.sample()
            assert.ok(gap !== null)
            assert.equal(gap.gapMs, 3_000)
            expectedAbsorbed += 3_000
            assert.equal(clock.absorbedGapMs(), expectedAbsorbed)
            absorbed = assertNeverAheadOfWall(clock, absorbed)
        }

        assert.equal(clock.absorbedGapMs(), 18_000)
        // Awake elapsed counts the six 100ms advances plus the six ignored
        // sub-threshold drifts, and none of the six absorbed gaps.
        assert.equal(
            clock.awakeNow() - START_WALL_MS,
            6 * 100 + 6 * (SUSPENSION_GAP_THRESHOLD_MS - 1),
        )
    })

    it("reports absorbed gaps to subscribers until they unsubscribe", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const seen: number[] = []
        const unsubscribe = clock.onGapAbsorbed((gap) => seen.push(gap.gapMs))

        clock.suspend(4_000)
        clock.sample()
        clock.suspend(SUSPENSION_GAP_THRESHOLD_MS - 1)
        clock.sample()
        assert.deepEqual(seen, [4_000])

        unsubscribe()
        clock.suspend(9_000)
        clock.sample()
        assert.deepEqual(seen, [4_000])
        assert.equal(clock.absorbedGapMs(), 13_000)
    })
})

describe("createAwakeDeadline", () => {
    const armDeadline = (clock: FakeAwakeClock, timeoutMs: number) => {
        const expiries: number[] = []
        const deadline = createAwakeDeadline({
            budget: "architect-phase",
            timeoutMs,
            onExpired: () => expiries.push(clock.awakeNow()),
            clock,
        })
        return { deadline, expiries }
    }

    it("(d) a suspend landing exactly on the deadline does not expire it; the next awake millisecond does", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const { deadline, expiries } = armDeadline(clock, 10_000)
        assert.equal(deadline.budget, "architect-phase")
        assert.equal(deadline.timeoutMs, 10_000)

        // Exactly the remaining wall time: the armed timer is due and fires,
        // but every millisecond of it was suspension.
        clock.suspend(10_000)
        assert.equal(expiries.length, 0)
        assert.equal(deadline.expired(), false)
        assert.equal(deadline.awakeRemainingMs(), 10_000)
        assert.equal(clock.absorbedGapMs(), 10_000)

        clock.advance(9_999)
        assert.equal(expiries.length, 0)
        assert.equal(deadline.expired(), false)
        assert.equal(deadline.awakeRemainingMs(), 1)

        clock.advance(1)
        assert.equal(expiries.length, 1)
        assert.equal(deadline.expired(), true)
        assert.equal(deadline.awakeRemainingMs(), 0)

        // No re-arm survives expiry, so nothing can fire onExpired twice.
        assert.deepEqual(clock.pendingDelays(), [])
        clock.advance(HOUR_MS)
        clock.runPending()
        assert.equal(expiries.length, 1)
    })

    it("re-arms within the split cap and fires exactly once at the end of a long budget", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const timeoutMs = 30 * 60_000
        const { deadline, expiries } = armDeadline(clock, timeoutMs)

        assert.deepEqual(clock.pendingDelays(), [AWAKE_SPLIT_MAX_DELAY_MS])

        for (let hop = 1; hop < timeoutMs / AWAKE_SPLIT_MAX_DELAY_MS; hop += 1) {
            clock.advance(AWAKE_SPLIT_MAX_DELAY_MS)
            assert.equal(expiries.length, 0)
            assert.equal(deadline.awakeRemainingMs(), timeoutMs - hop * AWAKE_SPLIT_MAX_DELAY_MS)
            for (const delay of clock.pendingDelays()) {
                assert.ok(
                    delay <= AWAKE_SPLIT_MAX_DELAY_MS,
                    `armed delay ${delay} exceeded the split cap`,
                )
            }
        }

        clock.advance(AWAKE_SPLIT_MAX_DELAY_MS)
        assert.equal(expiries.length, 1)
        assert.equal(expiries[0], START_WALL_MS + timeoutMs)
        assert.equal(deadline.expired(), true)
        assert.deepEqual(clock.pendingDelays(), [])
    })

    it("defers expiry across a multi-hour suspension inside a 30-minute budget", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const timeoutMs = 30 * 60_000
        const { deadline, expiries } = armDeadline(clock, timeoutMs)

        clock.advance(10 * 60_000)
        clock.suspend(5 * HOUR_MS)

        assert.equal(expiries.length, 0)
        assert.equal(deadline.expired(), false)
        assert.equal(deadline.awakeRemainingMs(), 20 * 60_000)
        assert.equal(clock.absorbedGapMs(), 5 * HOUR_MS)

        // The same awake elapsed without a suspension still trips the budget.
        clock.advance(20 * 60_000)
        assert.equal(expiries.length, 1)
        assert.equal(expiries[0], START_WALL_MS + timeoutMs)
    })

    it("close() is idempotent and suppresses every later fire", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const { deadline, expiries } = armDeadline(clock, 60_000)

        deadline.close()
        deadline.close()
        assert.deepEqual(clock.pendingDelays(), [])

        clock.advance(2 * HOUR_MS)
        clock.runPending()
        assert.equal(expiries.length, 0)

        // close() only stops the callback; the pure re-check still reports truth.
        assert.equal(deadline.expired(), true)
    })

    it("close() after expiry stays a no-op", () => {
        const clock = createFakeAwakeClock({ startWallMs: START_WALL_MS })
        const { deadline, expiries } = armDeadline(clock, 5_000)

        clock.advance(5_000)
        assert.equal(expiries.length, 1)

        deadline.close()
        deadline.close()
        clock.advance(5_000)
        clock.runPending()
        assert.equal(expiries.length, 1)
    })
})
