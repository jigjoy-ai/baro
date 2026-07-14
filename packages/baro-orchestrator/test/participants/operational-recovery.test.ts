import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { OperationalRecoveryPolicy } from "../../src/participants/operational-recovery.js"

describe("OperationalRecoveryPolicy", () => {
    it("honours retry-after without spending the retry before it is ready", () => {
        const policy = new OperationalRecoveryPolicy({
            maxRetriesPerStory: 2,
            marketRouteIds: new Set(["route-a", "route-b"]),
            isRouteUnavailable: () => false,
        })

        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            retryAfterMs: 500,
            now: 1_000,
        }), true)
        assert.equal(policy.isReady("S1", 1_499), false)
        assert.equal(policy.nextReadyDelay(["S1"], 1_100), 400)
        assert.equal(policy.isReady("S1", 1_500), true)
        assert.deepEqual(policy.exclusions("S1"), ["route-a"])
        assert.equal(policy.attempts("S1"), 0)
    })

    it("does not exclude a successful worker route for evaluator incidents", () => {
        const policy = new OperationalRecoveryPolicy({
            maxRetriesPerStory: 1,
            marketRouteIds: new Set(["route-a", "route-b"]),
            isRouteUnavailable: () => false,
        })

        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            excludeFailedRoute: false,
        }), true)
        assert.deepEqual(policy.exclusions("S1"), [])
        assert.equal(policy.startRetry("S1"), 1)
        assert.equal(policy.prepare("S1"), false)
    })
})
