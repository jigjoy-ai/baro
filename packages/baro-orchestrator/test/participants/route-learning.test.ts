import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { RouteLearner } from "../../src/participants/route-learning.js"

describe("RouteLearner", () => {
    it("learns suspension latency without counting a quality success or failure", () => {
        const learner = new RouteLearner({
            expectedCostUsd: 0.1,
            estimatedSuccessProbability: 0.8,
            estimatedLatencyMs: 1_000,
            estimateSource: "configured",
        })
        learner.beginLease("lease-1", "S1", 100)

        const snapshot = learner.completeLease(
            "S1",
            "lease-1",
            "dependency_blocked",
            300,
        )

        assert.equal(snapshot.verifiedSuccesses, 0)
        assert.equal(snapshot.workFailures, 0)
        assert.equal(snapshot.observations, 1)
        assert.equal(snapshot.estimate.estimatedSuccessProbability, 0.8)
        assert.equal(snapshot.estimate.estimatedLatencyMs, (2_000 + 200) / 3)
        assert.equal(snapshot.estimate.estimateSource, "historical")
    })
})
