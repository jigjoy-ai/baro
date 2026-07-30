import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    MAX_CRITIC_CALL_TIMEOUT_MS,
    MIN_CRITIC_CALL_TIMEOUT_MS,
    criticCallTimeoutMs,
} from "../../src/harness/one-shot/critic.js"

describe("Critic call budget follows the fleet width", () => {
    // A live 14-story run lost S2, S4, S9 and S11 — all finished, all passing
    // their own tests — because the Critic's fixed 60s budget was written when
    // one agent ran at a time. With ten workers on one machine every
    // evaluation overran it, and the gate's rechecks each got the same budget
    // under the same load.
    it("gives a lone worker the historical budget", () => {
        assert.equal(criticCallTimeoutMs(1), MIN_CRITIC_CALL_TIMEOUT_MS)
    })

    it("buys more time as more workers compete for the machine", () => {
        const solo = criticCallTimeoutMs(1)
        const busy = criticCallTimeoutMs(12)
        assert.ok(busy > solo, "a wider fleet must not get a tighter reviewer")
        // The run that lost work had ten workers and a 60s budget.
        assert.ok(criticCallTimeoutMs(10) >= 180_000)
    })

    it("treats unlimited parallelism as busy, never as quiet", () => {
        assert.equal(criticCallTimeoutMs(0), criticCallTimeoutMs(12))
        assert.equal(criticCallTimeoutMs(undefined), criticCallTimeoutMs(12))
    })

    it("stays inside its bounds however wide the fleet gets", () => {
        for (const workers of [1, 2, 8, 12, 64, 1000]) {
            const budget = criticCallTimeoutMs(workers)
            assert.ok(budget >= MIN_CRITIC_CALL_TIMEOUT_MS)
            assert.ok(budget <= MAX_CRITIC_CALL_TIMEOUT_MS)
        }
    })
})
