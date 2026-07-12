import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { knownMetric, unknownMetric } from "../../src/model-telemetry.js"
import { ModelTelemetryCollector } from "../../src/participants/model-telemetry-collector.js"
import {
    AgentResult,
    CodexTurnEvent,
    ModelInvocationMeasured,
    OpenCodeSystem,
    PiTurnEvent,
    StoryRouted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("ModelTelemetryCollector", () => {
    it("normalizes all five story backends without double-counting subsets", async () => {
        const collector = new ModelTelemetryCollector({ runId: "run-1" })
        const env = joinWithCapture(collector)
        const route = (storyId: string, backend: string, model: string) =>
            env.deliverSemanticEvent(
                source("factory"),
                StoryRouted.create({ storyId, backend, model }),
            )

        route("C", "claude", "sonnet")
        route("O", "openai", "gpt-5.5")
        route("X", "codex", "gpt-5.3-codex")
        route("OC", "opencode", "glm-5")
        route("P", "pi", "deepseek-v4")

        env.deliverSemanticEvent(
            source("C"),
            AgentResult.create({
                agentId: "C",
                subtype: "success",
                sessionId: "claude-session",
                isError: false,
                resultText: "done",
                usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 90,
                    cache_creation_input_tokens: 5,
                    output_tokens: 7,
                },
                totalCostUsd: 0.1,
                numTurns: 1,
                durationMs: 25,
            }),
        )
        // Exact terminal replay must not become a second paid invocation.
        env.deliverSemanticEvent(
            source("C-replay"),
            AgentResult.create({
                agentId: "C",
                subtype: "success",
                sessionId: "claude-session",
                isError: false,
                resultText: "done",
                usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 90,
                    cache_creation_input_tokens: 5,
                    output_tokens: 7,
                },
                totalCostUsd: 0.1,
                numTurns: 1,
                durationMs: 25,
            }),
        )
        env.deliverSemanticEvent(
            source("O"),
            AgentResult.create({
                agentId: "O",
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: "done",
                usage: {
                    input_tokens: 100,
                    cached_input_tokens: 80,
                    output_tokens: 20,
                    reasoning_tokens: 5,
                    total_tokens: 120,
                },
                totalCostUsd: null,
                numTurns: 1,
                durationMs: null,
            }),
        )
        env.deliverSemanticEvent(
            source("X"),
            CodexTurnEvent.create({
                agentId: "X",
                phase: "completed",
                raw: {
                    usage: {
                        input_tokens: 13,
                        cached_input_tokens: 10,
                        output_tokens: 5,
                        reasoning_output_tokens: 3,
                    },
                },
            }),
        )
        env.deliverSemanticEvent(
            source("OC"),
            OpenCodeSystem.create({
                agentId: "OC",
                subtype: "step_finish",
                raw: {
                    sessionID: "oc-session",
                    part: {
                        tokens: {
                            total: 100,
                            input: 70,
                            output: 7,
                            reasoning: 3,
                            cache: { read: 20, write: 0 },
                        },
                        cost: 0.001,
                    },
                },
            }),
        )
        env.deliverSemanticEvent(
            source("P"),
            PiTurnEvent.create({
                agentId: "P",
                turnType: "message_end",
                raw: {
                    message: {
                        role: "assistant",
                        provider: "deepseek",
                        model: "deepseek-v4-live",
                        responseId: "provider-response-1",
                        usage: {
                            input: 10,
                            output: 5,
                            cacheRead: 4,
                            cacheWrite: 1,
                            totalTokens: 20,
                            cost: { total: 0.002 },
                        },
                    },
                },
            }),
        )
        await collector.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        assert.equal(measured.length, 5)
        const byStory = new Map(measured.map((event) => [event.data.storyId, event.data]))

        assert.deepEqual(byStory.get("C")?.tokens.inputTotal, knownMetric(105, "derived"))
        assert.deepEqual(byStory.get("C")?.tokens.cachedInput, knownMetric(90, "provider_response"))
        assert.deepEqual(byStory.get("C")?.cost.equivalentUsd, knownMetric(0.1, "cli_result"))
        assert.equal(byStory.get("C")?.evidence.providerRequestId, null)

        assert.deepEqual(byStory.get("O")?.tokens.inputTotal, knownMetric(100, "provider_response"))
        assert.deepEqual(byStory.get("O")?.cost.providerUsd, unknownMetric("pending_gateway_meter"))

        // Reasoning is a reported subset, not something to add to outputTotal.
        assert.deepEqual(byStory.get("X")?.tokens.outputTotal, knownMetric(5, "provider_response"))
        assert.deepEqual(byStory.get("X")?.tokens.reasoningOutput, knownMetric(3, "provider_response"))

        assert.deepEqual(byStory.get("OC")?.tokens.total, knownMetric(100, "provider_response"))
        assert.deepEqual(byStory.get("OC")?.tokens.inputTotal, knownMetric(90, "derived"))
        assert.deepEqual(byStory.get("OC")?.tokens.outputTotal, knownMetric(10, "derived"))
        assert.deepEqual(byStory.get("OC")?.tokens.cacheWriteInput, knownMetric(0, "provider_response"))
        assert.deepEqual(byStory.get("OC")?.cost.equivalentUsd, knownMetric(0.001, "cli_result"))
        assert.equal(byStory.get("OC")?.evidence.providerRequestId, null)
        assert.deepEqual(byStory.get("P")?.tokens.inputTotal, knownMetric(15, "derived"))
        assert.equal(byStory.get("P")?.provider, "deepseek")
        assert.equal(byStory.get("P")?.resolvedModel, "deepseek-v4-live")
        assert.equal(byStory.get("P")?.evidence.providerRequestId, "provider-response-1")
        assert.deepEqual(byStory.get("P")?.cost.equivalentUsd, knownMetric(0.002, "cli_result"))
    })

    it("keeps incomplete Claude cache accounting unknown instead of calling it zero", async () => {
        const collector = new ModelTelemetryCollector({ runId: "run-2" })
        const env = joinWithCapture(collector)
        env.deliverSemanticEvent(
            source("factory"),
            StoryRouted.create({ storyId: "S1", backend: "claude", model: "sonnet" }),
        )
        env.deliverSemanticEvent(
            source("S1"),
            AgentResult.create({
                agentId: "S1",
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: "done",
                usage: { input_tokens: 1, output_tokens: 2 },
                totalCostUsd: null,
                numTurns: null,
                durationMs: null,
            }),
        )
        await collector.idle()

        const measurement = env.events.find(ModelInvocationMeasured.is)
        assert.deepEqual(
            measurement?.data.tokens.inputTotal,
            unknownMetric("not_reported"),
        )
    })
})
