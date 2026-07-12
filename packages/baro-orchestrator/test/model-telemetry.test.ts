import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    knownMetric,
    mergeMetric,
    notApplicableMetric,
    reduceModelTelemetry,
    unknownMetric,
    type Metric,
    type ModelInvocationMeasuredData,
} from "../src/model-telemetry.js"
import { ModelInvocationMeasured } from "../src/semantic-events.js"

const unknown = () => unknownMetric("not_reported")

function measurement(
    measurementId: string,
    invocationId: string,
    overrides: Partial<ModelInvocationMeasuredData> = {},
): ModelInvocationMeasuredData {
    return {
        schemaVersion: 1,
        measurementId,
        invocationId,
        runId: "run-1",
        phase: "story",
        storyId: "S1",
        attempt: 1,
        turn: 1,
        round: null,
        backend: "openai",
        provider: null,
        requestedModel: "baro-story",
        resolvedModel: null,
        status: "succeeded",
        durationMs: unknown(),
        tokens: {
            inputTotal: unknown(),
            cachedInput: unknown(),
            cacheWriteInput: notApplicableMetric(),
            outputTotal: unknown(),
            reasoningOutput: unknown(),
            total: unknown(),
        },
        cost: {
            providerUsd: unknownMetric("pending_gateway_meter"),
            customerUsd: unknownMetric("pending_gateway_meter"),
            equivalentUsd: notApplicableMetric(),
        },
        evidence: {
            producer: "runner",
            providerRequestId: null,
            rateCardVersion: null,
            granularity: "round",
        },
        ...overrides,
    }
}

describe("model telemetry metrics", () => {
    it("keeps a reported zero distinct from unknown and not-applicable", () => {
        const zero = knownMetric(0, "provider_response")

        assert.deepEqual(zero, {
            state: "known",
            value: 0,
            source: "provider_response",
        })
        assert.deepEqual(mergeMetric(unknown(), zero), zero)
        assert.deepEqual(
            mergeMetric(notApplicableMetric(), unknownMetric("not_supported")),
            unknownMetric("not_supported"),
        )
        assert.throws(
            () => knownMetric(-1, "derived"),
            /finite non-negative/,
        )
        assert.throws(
            () => knownMetric(Number.NaN, "derived"),
            /finite non-negative/,
        )
    })

    it("prefers higher-authority known measurements without summing observations", () => {
        assert.deepEqual(
            mergeMetric(
                knownMetric(9, "derived"),
                knownMetric(11, "provider_response"),
            ),
            knownMetric(11, "provider_response"),
        )
        assert.deepEqual(
            mergeMetric(
                knownMetric(11, "provider_response"),
                knownMetric(11, "cli_result"),
            ),
            knownMetric(11, "provider_response"),
        )
    })

    it("marks equal-authority disagreement as unknown instead of guessing", () => {
        assert.deepEqual(
            mergeMetric(
                knownMetric(10, "cli_result"),
                knownMetric(12, "cli_result"),
            ),
            unknownMetric("conflicting_measurements"),
        )
    })
})

describe("reduceModelTelemetry", () => {
    it("deduplicates measurementId and fuses runner plus gateway observations", () => {
        const runner = measurement("runner-1", "invocation-1", {
            tokens: {
                inputTotal: knownMetric(120, "provider_response"),
                cachedInput: knownMetric(80, "provider_response"),
                cacheWriteInput: notApplicableMetric(),
                outputTotal: knownMetric(30, "provider_response"),
                reasoningOutput: knownMetric(5, "provider_response"),
                total: knownMetric(150, "provider_response"),
            },
        })
        const gateway = measurement("gateway-1", "invocation-1", {
            provider: "deepseek",
            resolvedModel: "deepseek-v4-flash",
            durationMs: knownMetric(250, "gateway_rate_card"),
            tokens: {
                inputTotal: unknownMetric("not_reported"),
                cachedInput: unknownMetric("not_reported"),
                cacheWriteInput: notApplicableMetric(),
                outputTotal: unknownMetric("not_reported"),
                reasoningOutput: unknownMetric("not_supported"),
                total: unknownMetric("not_reported"),
            },
            cost: {
                // A genuine zero must survive; it must not look like missing cost.
                providerUsd: knownMetric(0, "gateway_rate_card"),
                customerUsd: knownMetric(0, "cloud_charge"),
                equivalentUsd: notApplicableMetric(),
            },
            evidence: {
                producer: "gateway",
                providerRequestId: "response-1",
                rateCardVersion: "2026-07",
                granularity: "round",
            },
        })
        const other = measurement("runner-2", "invocation-2", {
            cost: {
                providerUsd: knownMetric(0.2, "gateway_rate_card"),
                customerUsd: unknownMetric("not_reported"),
                equivalentUsd: notApplicableMetric(),
            },
        })

        const reduced = reduceModelTelemetry([
            runner,
            gateway,
            gateway,
            other,
        ])

        assert.equal(reduced.invocations.size, 2)
        assert.deepEqual(reduced.duplicateMeasurementIds, ["gateway-1"])

        const invocation = reduced.invocations.get("invocation-1")
        assert.ok(invocation)
        assert.deepEqual(invocation.measurementIds, ["runner-1", "gateway-1"])
        assert.equal(invocation.measurements.length, 2)
        assert.deepEqual(
            invocation.tokens.inputTotal,
            knownMetric(120, "provider_response"),
        )
        assert.deepEqual(
            invocation.cost.providerUsd,
            knownMetric(0, "gateway_rate_card"),
        )
        assert.deepEqual(
            invocation.cost.customerUsd,
            knownMetric(0, "cloud_charge"),
        )
    })

    it("does not turn entirely missing measurements into numeric totals", () => {
        const reduced = reduceModelTelemetry([
            measurement("runner-1", "invocation-1"),
        ])
        const invocation = reduced.invocations.get("invocation-1")

        assert.ok(invocation)
        assert.deepEqual(
            invocation.tokens.inputTotal,
            unknownMetric("not_reported"),
        )
        assert.deepEqual(
            invocation.cost.providerUsd,
            unknownMetric("pending_gateway_meter"),
        )
    })

    it("resolves all observations independently of stream order", () => {
        const ten = measurement("measurement-10", "invocation-1", {
            tokens: {
                inputTotal: knownMetric(10, "cli_result"),
                cachedInput: unknown(),
                cacheWriteInput: notApplicableMetric(),
                outputTotal: unknown(),
                reasoningOutput: unknown(),
                total: unknown(),
            },
        })
        const twelve = measurement("measurement-12", "invocation-1", {
            tokens: {
                inputTotal: knownMetric(12, "cli_result"),
                cachedInput: unknown(),
                cacheWriteInput: notApplicableMetric(),
                outputTotal: unknown(),
                reasoningOutput: unknown(),
                total: unknown(),
            },
        })
        const lowerAuthority = measurement("measurement-derived", "invocation-1", {
            tokens: {
                inputTotal: knownMetric(10, "derived"),
                cachedInput: unknown(),
                cacheWriteInput: notApplicableMetric(),
                outputTotal: unknown(),
                reasoningOutput: unknown(),
                total: unknown(),
            },
        })

        const forward = reduceModelTelemetry([ten, twelve, lowerAuthority])
            .invocations.get("invocation-1")
        const reverse = reduceModelTelemetry([lowerAuthority, twelve, ten])
            .invocations.get("invocation-1")

        assert.ok(forward)
        assert.ok(reverse)
        assert.deepEqual(
            forward.tokens.inputTotal,
            unknownMetric("conflicting_measurements"),
        )
        assert.deepEqual(reverse.tokens.inputTotal, forward.tokens.inputTotal)
    })

    it("rejects empty correlation identifiers", () => {
        assert.throws(
            () => reduceModelTelemetry([measurement("", "invocation-1")]),
            /measurementId must not be empty/,
        )
        assert.throws(
            () => reduceModelTelemetry([measurement("measurement-1", "")]),
            /invocationId must not be empty/,
        )
    })
})

describe("ModelInvocationMeasured semantic event", () => {
    it("round-trips through JSON with its tagged metrics intact", () => {
        const data = measurement("runner-1", "invocation-1", {
            durationMs: knownMetric(0, "cli_result"),
        })
        const event = ModelInvocationMeasured.create(data)
        const roundTrip = JSON.parse(JSON.stringify(event)) as {
            type: string
            data: ModelInvocationMeasuredData
        }

        assert.equal(event.type, "model_invocation_measured")
        assert.equal(ModelInvocationMeasured.is(event), true)
        assert.equal(roundTrip.type, "model_invocation_measured")
        assert.deepEqual(roundTrip.data.durationMs, knownMetric(0, "cli_result"))
        assert.deepEqual(
            roundTrip.data.cost.providerUsd,
            unknownMetric("pending_gateway_meter"),
        )
    })
})
