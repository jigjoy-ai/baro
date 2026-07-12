import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    ClaudeStreamChunk,
    ModelInvocationMeasured,
} from "../../../src/semantic-events.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type ModelInvocationMeasuredData,
} from "../../../src/model-telemetry.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { TokenUsageForwarder } from "../../../src/participants/forwarders/token-usage.js"
import { captureStdout, source } from "../helpers.js"

function parseEvents(lines: string[]): BaroEvent[] {
    return lines.map((line) => JSON.parse(line) as BaroEvent)
}

describe("TokenUsageForwarder", () => {
    it("projects only known normalized totals into legacy token_usage", async () => {
        const forwarder = new TokenUsageForwarder()
        const agent = source("S1")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                ModelInvocationMeasured.create(measurement("known", {
                    inputTotal: knownMetric(101, "derived"),
                    outputTotal: knownMetric(7, "provider_response"),
                    equivalentUsd: knownMetric(0.012, "cli_result"),
                })),
            )
            await forwarder.onExternalEvent(
                agent,
                ModelInvocationMeasured.create(measurement("unknown", {
                    inputTotal: unknownMetric("not_reported"),
                    outputTotal: knownMetric(5, "provider_response"),
                    equivalentUsd: unknownMetric("not_reported"),
                })),
            )
            const gateway = measurement("gateway", {
                inputTotal: knownMetric(101, "provider_response"),
                outputTotal: knownMetric(7, "provider_response"),
                equivalentUsd: knownMetric(0.01, "gateway_rate_card"),
            })
            await forwarder.onExternalEvent(
                agent,
                ModelInvocationMeasured.create({
                    ...gateway,
                    invocationId: "i-known",
                    evidence: { ...gateway.evidence, producer: "gateway" },
                }),
            )
        }))

        assert.deepEqual(events.map((event) => event.type), [
            "model_usage",
            "token_usage",
            "model_usage",
            "model_usage",
        ])
        assert.deepEqual(events[1], {
            type: "token_usage",
            id: "S1",
            input_tokens: 101,
            output_tokens: 7,
            cost_usd: 0.012,
        })
    })

    it("emits live token_progress events for Claude stream chunks", async () => {
        const forwarder = new TokenUsageForwarder()
        const agent = source("S1")

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                agent,
                ClaudeStreamChunk.create({
                    agentId: "S1",
                    raw: {
                        event: {
                            type: "message_start",
                            message: { usage: { output_tokens: 4 } },
                        },
                    },
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "token_progress",
                id: "S1",
                input_tokens: 0,
                output_tokens: 4,
            },
        ])
    })
})

function measurement(
    suffix: string,
    values: {
        inputTotal: ReturnType<typeof knownMetric> | ReturnType<typeof unknownMetric>
        outputTotal: ReturnType<typeof knownMetric> | ReturnType<typeof unknownMetric>
        equivalentUsd: ReturnType<typeof knownMetric> | ReturnType<typeof unknownMetric>
    },
): ModelInvocationMeasuredData {
    return {
        schemaVersion: 1,
        measurementId: `m-${suffix}`,
        invocationId: `i-${suffix}`,
        runId: "run-1",
        phase: "story",
        storyId: "S1",
        attempt: 1,
        turn: 1,
        round: null,
        backend: "claude",
        provider: null,
        requestedModel: null,
        resolvedModel: "sonnet",
        status: "succeeded",
        durationMs: unknownMetric("not_reported"),
        tokens: {
            inputTotal: values.inputTotal,
            cachedInput: unknownMetric("not_reported"),
            cacheWriteInput: unknownMetric("not_reported"),
            outputTotal: values.outputTotal,
            reasoningOutput: notApplicableMetric(),
            total: unknownMetric("not_reported"),
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: values.equivalentUsd,
        },
        evidence: {
            producer: "runner",
            providerRequestId: null,
            rateCardVersion: null,
            granularity: "process",
        },
    }
}
