import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    ClaudeStreamChunk,
    ModelInvocationMeasured,
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../../src/semantic-events.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type ModelInvocationMeasuredData,
} from "../../../src/model-telemetry.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { TokenUsageForwarder } from "../../../src/participants/forwarders/token-usage.js"
import { StoryOutcomeAuthority } from "../../../src/runtime/story-outcome-authority.js"
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

    it("binds collective measurements and deduplicates additive totals", async () => {
        const forwarder = new TokenUsageForwarder(true)
        const broker = source("broker")
        const collector = source("telemetry")
        const critic = source("critic")
        const forger = source("telemetry")
        const outcomes = new StoryOutcomeAuthority("run-1")
        const measured = ModelInvocationMeasured.create(measurement("bound", {
            inputTotal: knownMetric(10, "provider_response"),
            outputTotal: knownMetric(2, "provider_response"),
            equivalentUsd: knownMetric(0.1, "cli_result"),
        }))

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(collector, measured)
            forwarder.sealCollectiveAuthorities({
                runId: "run-1",
                broker,
                outcomeAuthority: outcomes,
                measurementAuthorities: [
                    { source: collector, phases: ["story"] },
                    { source: critic, phases: ["critic"] },
                ],
            })
            await forwarder.onExternalEvent(forger, measured)
            await forwarder.onExternalEvent(collector, measured)
            await forwarder.onExternalEvent(collector, measured)
            await forwarder.onExternalEvent(
                critic,
                ModelInvocationMeasured.create({
                    ...measurement("critic-wrong-phase", {
                        inputTotal: knownMetric(99, "provider_response"),
                        outputTotal: knownMetric(99, "provider_response"),
                        equivalentUsd: knownMetric(9, "cli_result"),
                    }),
                    phase: "story",
                }),
            )
            await forwarder.onExternalEvent(
                critic,
                ModelInvocationMeasured.create({
                    ...measurement("critic", {
                        inputTotal: knownMetric(4, "provider_response"),
                        outputTotal: knownMetric(1, "provider_response"),
                        equivalentUsd: knownMetric(0.02, "cli_result"),
                    }),
                    phase: "critic",
                }),
            )
        }))

        assert.deepEqual(events.map((event) => event.type), [
            "model_usage",
            "token_usage",
            "model_usage",
            "token_usage",
        ])
        assert.deepEqual(
            events.filter((event) => event.type === "token_usage"),
            [
                {
                    type: "token_usage",
                    id: "S1",
                    input_tokens: 10,
                    output_tokens: 2,
                    cost_usd: 0.1,
                },
                {
                    type: "token_usage",
                    id: "S1",
                    input_tokens: 4,
                    output_tokens: 1,
                    cost_usd: 0.02,
                },
            ],
        )
    })

    it("rejects same-label and released collective stream sources", async () => {
        const forwarder = new TokenUsageForwarder(true)
        const broker = source("broker")
        const collector = source("telemetry")
        const worker = source("S1")
        const forger = source("S1")
        const outcomes = new StoryOutcomeAuthority("run-1")
        const grant = WorkLeaseGranted.create({
            runId: "run-1",
            offerId: "offer-1",
            leaseId: "lease-1",
            workerId: "worker-1",
            generation: 1,
            request: {
                storyId: "S1",
                prompt: "work",
                model: "standard",
                retries: 1,
                timeoutSecs: 60,
            },
        })
        const chunk = ClaudeStreamChunk.create({
            agentId: "S1",
            raw: {
                event: {
                    type: "message_start",
                    message: { usage: { output_tokens: 3 } },
                },
            },
        })

        const events = parseEvents(await captureStdout(async () => {
            forwarder.sealCollectiveAuthorities({
                runId: "run-1",
                broker,
                outcomeAuthority: outcomes,
                measurementAuthorities: [
                    { source: collector, phases: ["story"] },
                ],
            })
            await forwarder.onExternalEvent(broker, grant)
            outcomes.registerResultAuthority(
                {
                    runId: "run-1",
                    storyId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                },
                worker,
            )
            await forwarder.onExternalEvent(forger, chunk)
            await forwarder.onExternalEvent(worker, chunk)
            await forwarder.onExternalEvent(
                broker,
                WorkLeaseReleased.create({
                    runId: "run-1",
                    offerId: "offer-1",
                    leaseId: "lease-1",
                    storyId: "S1",
                    workerId: "worker-1",
                    reason: "integrated",
                }),
            )
            await forwarder.onExternalEvent(worker, chunk)
        }))

        assert.deepEqual(events, [
            {
                type: "token_progress",
                id: "S1",
                input_tokens: 0,
                output_tokens: 3,
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
