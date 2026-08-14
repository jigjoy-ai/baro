import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { OperationalRecoveryPolicy } from "../../src/execution/operational-recovery.js"

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

    it("refuses a repeat that would re-enter the same environment", () => {
        // Run 47: three identical `infrastructure/command_timeout` results
        // spent 115 of the run's 118 minutes, because the environment could
        // not run the story's tests and no attempt could differ from the last.
        const policy = new OperationalRecoveryPolicy({
            maxRetriesPerStory: 5,
            marketRouteIds: new Set(["route-a"]),
            isRouteUnavailable: () => false,
        })

        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            signature: "infrastructure:command_timeout",
        }), true, "the first incident is worth one retry")
        policy.startRetry("S1")
        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            signature: "infrastructure:command_timeout",
        }), false, "the same failure on the only route is not recovery")
        assert.equal(policy.isPending("S1"), false)
    })

    it("still retries when the repeat can land somewhere else", () => {
        const policy = new OperationalRecoveryPolicy({
            maxRetriesPerStory: 5,
            marketRouteIds: new Set(["route-a", "route-b", "route-c"]),
            isRouteUnavailable: () => false,
        })

        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            signature: "provider:unavailable",
        }), true)
        policy.startRetry("S1")
        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-b",
            signature: "provider:unavailable",
        }), true, "an identical failure still had an untried route to reach")
    })

    it("still honours a provider that asked us to wait", () => {
        const policy = new OperationalRecoveryPolicy({
            maxRetriesPerStory: 5,
            marketRouteIds: new Set(["route-a"]),
            isRouteUnavailable: () => false,
        })

        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            signature: "provider:rate_limited",
            retryAfterMs: 1_000,
            now: 0,
        }), true)
        policy.startRetry("S1")
        assert.equal(policy.prepare("S1", {
            failedRouteId: "route-a",
            signature: "provider:rate_limited",
            retryAfterMs: 1_000,
            now: 2_000,
        }), true, "a backoff the provider named is a change, not a repeat")
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
