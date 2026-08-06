import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { plannerTurnMeasurement } from "../../src/planning/adapters/planner-bus-session.js"
import type { AgentResultData } from "../../src/semantic-events.js"

function turn(usage: Record<string, unknown> | null): AgentResultData {
    return {
        agentId: "planner:run-1",
        subtype: "success",
        sessionId: null,
        isError: false,
        resultText: "the plan",
        usage,
        totalCostUsd: null,
        numTurns: null,
        durationMs: null,
    }
}

// The planner is the one phase whose lane was assumed rather than read: every
// turn was reported as Claude, so a DeepSeek run's planner tokens were priced
// on Anthropic's card and the measurement said nothing about which model the
// run was actually testing.
describe("a planner turn is measured on the lane that answered it", () => {
    it("reads a native turn as its rounds, summed", () => {
        const measurement = plannerTurnMeasurement({
            runId: "run-1",
            backend: "jigjoy",
            requestedModel: "glm-5.2",
            turn: 1,
            result: turn({
                input_tokens: 120_000,
                output_tokens: 4_000,
                total_tokens: 124_000,
                cached_input_tokens: 90_000,
                reasoning_tokens: 800,
                rounds: 3,
            }),
        })

        assert.equal(measurement.backend, "jigjoy")
        assert.equal(measurement.requestedModel, "glm-5.2")
        assert.equal(measurement.tokens.inputTotal.value, 120_000)
        assert.equal(measurement.tokens.cachedInput.value, 90_000)
        assert.equal(measurement.tokens.outputTotal.value, 4_000)
        assert.equal(measurement.evidence.granularity, "turn")
    })

    it("still reads a Claude turn through the wrapper's own shape", () => {
        const measurement = plannerTurnMeasurement({
            runId: "run-1",
            backend: "claude",
            requestedModel: "opus",
            turn: 2,
            result: {
                ...turn({
                    input_tokens: 1_000,
                    output_tokens: 200,
                    cache_read_input_tokens: 40_000,
                }),
                totalCostUsd: 1.25,
            },
        })

        assert.equal(measurement.backend, "claude")
        assert.equal(measurement.tokens.cachedInput.value, 40_000)
        assert.equal(measurement.tokens.outputTotal.value, 200)
        // The wrapper reports what the turn cost; a native lane never can.
        assert.equal(measurement.cost.equivalentUsd.value, 1.25)
        assert.equal(measurement.evidence.granularity, "process")
    })

    it("reports a failed turn as failed rather than as missing", () => {
        const measurement = plannerTurnMeasurement({
            runId: "run-1",
            backend: "jigjoy",
            requestedModel: "glm-5.2",
            turn: 3,
            result: { ...turn(null), isError: true },
        })
        assert.equal(measurement.status, "failed")
    })
})
