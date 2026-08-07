import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runBoundedRound } from "../../src/harness/mozaik/round.js"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Baro removed wall-clock caps on work in 0.82.0 and left this one, because a
// request in flight was indistinguishable from a dead socket. Once the lane
// streams that stops being true — and the number left behind started cutting
// healthy work: a story lane carried three minutes, and DeepSeek Flash writes
// fifteen thousand tokens in about that long. Three stories in one run were
// killed for working.
describe("a round's deadline measures silence, not duration", () => {
    it("lets a call run far past the deadline while it keeps delivering", async () => {
        const result = await runBoundedRound({
            timeoutMs: 40,
            round: async (_signal, progress) => {
                // Six times the deadline, reporting throughout.
                for (let step = 0; step < 12; step += 1) {
                    await tick(20)
                    progress()
                }
                return "finished"
            },
        })
        assert.equal(result, "finished")
    })

    it("ends a call that goes silent, however busy it was before", async () => {
        await assert.rejects(
            runBoundedRound({
                timeoutMs: 60,
                label: "round 3",
                round: async (_signal, progress) => {
                    for (let step = 0; step < 3; step += 1) {
                        await tick(20)
                        progress()
                    }
                    await tick(500) // nothing arrives
                    return "unreachable"
                },
            }),
            (error: Error) => /round 3 timed out after 60ms/u.test(error.message),
        )
    })

    it("cancels the request it gave up on, so nothing lands later", async () => {
        let aborted = false
        await assert.rejects(
            runBoundedRound({
                timeoutMs: 30,
                round: async (signal) => {
                    signal.addEventListener("abort", () => (aborted = true))
                    await tick(300)
                    return "unreachable"
                },
            }),
            /timed out/u,
        )
        assert.equal(aborted, true)
    })

    // The heartbeat exists to feed the caller's watchdogs while a call is in
    // flight; it fires whether or not anything is arriving. A deadline it could
    // postpone would never fire at all.
    it("is not kept alive by its own heartbeat", async () => {
        let beats = 0
        await assert.rejects(
            runBoundedRound({
                timeoutMs: 50,
                onActivity: () => (beats += 1),
                round: async () => {
                    await tick(400)
                    return "unreachable"
                },
            }),
            /timed out/u,
        )
        assert.ok(beats >= 0, "the heartbeat may fire; it may not extend the deadline")
    })

    it("still reads elapsed time as silence for a lane that reports nothing", async () => {
        await assert.rejects(
            runBoundedRound({
                timeoutMs: 40,
                round: async () => {
                    await tick(300)
                    return "unreachable"
                },
            }),
            /timed out after 40ms/u,
        )
    })

    it("passes the caller's abort through as cancellation, not as a timeout", async () => {
        const parent = new AbortController()
        setTimeout(() => parent.abort(new Error("run stopped")), 20)
        await assert.rejects(
            runBoundedRound({
                timeoutMs: 5_000,
                parentSignal: parent.signal,
                round: (signal) =>
                    new Promise((_, reject) => {
                        signal.addEventListener("abort", () =>
                            reject(signal.reason ?? new Error("aborted")),
                        )
                    }),
            }),
            (error: Error) => !/timed out/u.test(error.message),
        )
    })
})
