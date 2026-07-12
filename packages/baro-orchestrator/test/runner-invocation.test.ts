import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { notApplicableMetric, unknownMetric } from "../src/model-telemetry.js"
import {
    RunnerInvocationTracker,
    type RunnerInvocationObservation,
    type UnsequencedRunnerInvocationObservation,
} from "../src/runner-invocation.js"

function fallback(
    status: "succeeded" | "failed" = "failed",
): UnsequencedRunnerInvocationObservation {
    const missing = unknownMetric("not_reported")
    return {
        granularity: "process",
        status,
        durationMs: missing,
        tokens: {
            inputTotal: missing,
            cachedInput: missing,
            cacheWriteInput: missing,
            outputTotal: missing,
            reasoningOutput: missing,
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider: null,
        resolvedModel: null,
        providerRequestId: null,
    }
}

describe("RunnerInvocationTracker", () => {
    it("emits a no-terminal fallback exactly once across competing finishes", () => {
        const observations: RunnerInvocationObservation[] = []
        const tracker = new RunnerInvocationTracker((item) =>
            observations.push(item),
        )

        assert.equal(tracker.finish(fallback("failed")), true)
        assert.equal(tracker.finish(fallback("succeeded")), false)
        assert.equal(tracker.observe(fallback("succeeded")), false)
        assert.equal(observations.length, 1)
        assert.equal(observations[0]!.sequence, 1)
        assert.equal(observations[0]!.status, "failed")
    })

    it("does not add a fallback after terminal observations", () => {
        const observations: RunnerInvocationObservation[] = []
        const tracker = new RunnerInvocationTracker((item) =>
            observations.push(item),
        )

        assert.equal(tracker.observe(fallback("succeeded")), true)
        assert.equal(tracker.observe(fallback("succeeded")), true)
        assert.equal(tracker.finish(fallback("failed")), true)
        assert.deepEqual(
            observations.map((item) => [item.sequence, item.status]),
            [
                [1, "succeeded"],
                [2, "succeeded"],
            ],
        )
    })

    it("isolates observer exceptions from tracking", () => {
        const tracker = new RunnerInvocationTracker(() => {
            throw new Error("telemetry sink unavailable")
        })

        assert.doesNotThrow(() => tracker.observe(fallback("succeeded")))
        assert.equal(tracker.observationCount, 1)
        assert.doesNotThrow(() => tracker.finish(fallback("failed")))
        assert.equal(tracker.observationCount, 1)
    })
})
