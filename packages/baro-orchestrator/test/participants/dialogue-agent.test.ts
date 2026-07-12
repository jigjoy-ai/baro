import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type ModelInvocationStatus,
    type UnknownMetricReason,
} from "../../src/model-telemetry.js"
import {
    DialogueAgent,
    DialogueResponderInvocationError,
    type DialogueResponderInvocation,
} from "../../src/participants/dialogue-agent.js"
import {
    AgentTargetedMessage,
    ConversationFailed,
    ConversationRequested,
    ConversationResponded,
    ModelInvocationMeasured,
    StoryRouted,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("DialogueAgent", () => {
    it("is idle without user input, source-binds requests, deduplicates replay, and messages only active workers", async () => {
        const operator = source("operator")
        const broker = source("broker")
        const observer = source("observer")
        let calls = 0
        const dialogue = new DialogueAgent({
            runId: "run-dialogue",
            operatorAuthority: operator,
            leaseAuthority: broker,
            responder: async (input) => {
                calls += 1
                assert.match(input.userPrompt, /ACTIVE WORKERS: S1/)
                assert.doesNotMatch(input.userPrompt, /secret prompt contents/)
                return JSON.stringify({
                    message: "S1 is active; I sent it a concise check.",
                    messages: [
                        { recipient_id: "S1", text: "Please run the focused test." },
                        { recipient_id: "S2", text: "This inactive worker must not receive anything." },
                    ],
                })
            },
        })
        const env = joinWithCapture(dialogue)
        await dialogue.idle()
        assert.equal(calls, 0)
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)

        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId: "run-dialogue",
                offerId: "offer-S1",
                leaseId: "lease-S1",
                workerId: "worker-1",
                generation: 1,
                request: {
                    storyId: "S1",
                    prompt: "secret prompt contents",
                    model: "standard",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )
        env.deliverSemanticEvent(
            source("factory"),
            StoryRouted.create({
                storyId: "S1",
                backend: "claude",
                model: "sonnet",
            }),
        )
        const request = ConversationRequested.create({
            runId: "run-dialogue",
            messageId: "message-1",
            text: "What is happening?",
            source: "user",
        })
        env.deliverSemanticEvent(observer, request)
        env.deliverSemanticEvent(operator, request)
        env.deliverSemanticEvent(operator, request)
        await dialogue.idle()

        assert.equal(calls, 1)
        const replies = env.events.filter(ConversationResponded.is)
        assert.equal(replies.length, 1)
        assert.deepEqual(replies[0]?.data.actions, [
            { kind: "message", recipientId: "S1", text: "Please run the focused test." },
        ])
        const messages = env.events.filter(AgentTargetedMessage.is)
        assert.equal(messages.length, 1)
        assert.equal(messages[0]?.data.recipientId, "S1")
        // Plain injected responders retain their old string-only ergonomics;
        // without attributable provider evidence, no measurement is invented.
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
    })

    it("publishes a stable dialogue measurement before the response", async () => {
        const operator = source("operator")
        const dialogue = new DialogueAgent({
            runId: "run-measured",
            operatorAuthority: operator,
            responder: async () => ({
                text: JSON.stringify({ message: "The run is healthy.", messages: [] }),
                invocation: measuredInvocation(),
            }),
        })
        const env = joinWithCapture(dialogue)
        env.deliverSemanticEvent(
            operator,
            ConversationRequested.create({
                runId: "run-measured",
                messageId: "message-7",
                text: "status?",
                source: "user",
            }),
        )
        await dialogue.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        const responded = env.events.filter(ConversationResponded.is)
        assert.equal(measured.length, 1)
        assert.equal(responded.length, 1)
        assert.ok(
            env.events.indexOf(measured[0]!) < env.events.indexOf(responded[0]!),
        )
        assert.equal(
            measured[0]!.data.invocationId,
            "run-measured:dialogue:message-7:provider:1",
        )
        assert.equal(
            measured[0]!.data.measurementId,
            "run-measured:dialogue:message-7:provider:1:runner",
        )
        assert.equal(measured[0]!.data.phase, "dialogue")
        assert.equal(measured[0]!.data.storyId, null)
        assert.equal(measured[0]!.data.backend, "claude")
        assert.equal(measured[0]!.data.requestedModel, "haiku")
        assert.equal(measured[0]!.data.evidence.providerRequestId, null)
    })

    it("measures attributable provider failures and agent-owned timeouts once", async () => {
        const operator = source("operator")
        const failing = new DialogueAgent({
            runId: "run-provider-failure",
            operatorAuthority: operator,
            responder: async () => {
                throw new DialogueResponderInvocationError(
                    "provider unavailable",
                    unknownInvocation("failed", "not_reported"),
                )
            },
        })
        const failureEnv = joinWithCapture(failing)
        failureEnv.deliverSemanticEvent(
            operator,
            ConversationRequested.create({
                runId: "run-provider-failure",
                messageId: "message-provider-failure",
                text: "status?",
                source: "user",
            }),
        )
        await failing.idle()

        const failureMeasurements = failureEnv.events.filter(
            ModelInvocationMeasured.is,
        )
        const failures = failureEnv.events.filter(ConversationFailed.is)
        assert.equal(failureMeasurements.length, 1)
        assert.equal(failures.length, 1)
        assert.equal(failureMeasurements[0]!.data.status, "failed")
        assert.deepEqual(
            failureMeasurements[0]!.data.tokens.total,
            unknownMetric("not_reported"),
        )
        assert.ok(
            failureEnv.events.indexOf(failureMeasurements[0]!)
                < failureEnv.events.indexOf(failures[0]!),
        )

        const hangingResponder = Object.assign(
            (_input: unknown, _signal: AbortSignal) => new Promise<string>(() => {}),
            {
                telemetry: {
                    failureInvocation(
                        status: Extract<ModelInvocationStatus, "failed" | "timed_out">,
                        reason: UnknownMetricReason,
                    ): DialogueResponderInvocation {
                        return unknownInvocation(status, reason)
                    },
                },
            },
        )
        const timingOut = new DialogueAgent({
            runId: "run-provider-timeout",
            operatorAuthority: operator,
            timeoutMs: 10,
            responder: hangingResponder,
        })
        const timeoutEnv = joinWithCapture(timingOut)
        timeoutEnv.deliverSemanticEvent(
            operator,
            ConversationRequested.create({
                runId: "run-provider-timeout",
                messageId: "message-provider-timeout",
                text: "status?",
                source: "user",
            }),
        )
        await timingOut.idle()
        const timeoutMeasurements = timeoutEnv.events.filter(
            ModelInvocationMeasured.is,
        )
        const timeouts = timeoutEnv.events.filter(ConversationFailed.is)
        assert.equal(timeoutMeasurements.length, 1)
        assert.equal(timeouts.length, 1)
        assert.equal(timeoutMeasurements[0]!.data.status, "timed_out")
        assert.deepEqual(
            timeoutMeasurements[0]!.data.durationMs,
            unknownMetric("timed_out"),
        )
        assert.ok(
            timeoutEnv.events.indexOf(timeoutMeasurements[0]!)
                < timeoutEnv.events.indexOf(timeouts[0]!),
        )
    })

    it("fails safely and aborts an in-flight response when removed", async () => {
        const operator = source("operator")
        const failing = new DialogueAgent({
            runId: "run-failure",
            operatorAuthority: operator,
            timeoutMs: 20,
            responder: async () => {
                throw new Error("provider URL and credentials must not reach the bus")
            },
        })
        const failureEnv = joinWithCapture(failing)
        failureEnv.deliverSemanticEvent(
            operator,
            ConversationRequested.create({
                runId: "run-failure",
                messageId: "message-failure",
                text: "status?",
                source: "user",
            }),
        )
        await failing.idle()
        const failures = failureEnv.events.filter(ConversationFailed.is)
        assert.equal(failures.length, 1)
        assert.equal(failures[0]?.data.error, "responder failed")

        let aborted = false
        const hanging = new DialogueAgent({
            runId: "run-abort",
            operatorAuthority: operator,
            responder: (_input, signal) => new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    aborted = true
                    reject(new Error("aborted"))
                }, { once: true })
            }),
        })
        const abortEnv = joinWithCapture(hanging)
        abortEnv.deliverSemanticEvent(
            operator,
            ConversationRequested.create({
                runId: "run-abort",
                messageId: "message-abort",
                text: "status?",
                source: "user",
            }),
        )
        await Promise.resolve()
        await Promise.resolve()
        hanging.leave(abortEnv)
        await hanging.idle()
        assert.equal(aborted, true)
        assert.equal(abortEnv.events.filter(ConversationResponded.is).length, 0)
        assert.equal(abortEnv.events.filter(ConversationFailed.is).length, 0)
    })
})

function measuredInvocation(): DialogueResponderInvocation {
    return {
        backend: "claude",
        requestedModel: "haiku",
        observation: {
            sequence: 1,
            granularity: "process",
            status: "succeeded",
            durationMs: knownMetric(12, "cli_result"),
            tokens: {
                inputTotal: knownMetric(10, "provider_response"),
                cachedInput: knownMetric(2, "provider_response"),
                cacheWriteInput: knownMetric(0, "provider_response"),
                outputTotal: knownMetric(4, "provider_response"),
                reasoningOutput: notApplicableMetric(),
                total: knownMetric(14, "provider_response"),
            },
            cost: {
                providerUsd: notApplicableMetric(),
                customerUsd: notApplicableMetric(),
                equivalentUsd: knownMetric(0.001, "cli_result"),
            },
            provider: null,
            resolvedModel: "claude-haiku",
            providerRequestId: null,
        },
    }
}

function unknownInvocation(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
): DialogueResponderInvocation {
    return {
        backend: "claude",
        requestedModel: "haiku",
        observation: {
            sequence: 1,
            granularity: "process",
            status,
            durationMs: unknownMetric(reason),
            tokens: {
                inputTotal: unknownMetric(reason),
                cachedInput: unknownMetric(reason),
                cacheWriteInput: unknownMetric(reason),
                outputTotal: unknownMetric(reason),
                reasoningOutput: notApplicableMetric(),
                total: unknownMetric(reason),
            },
            cost: {
                providerUsd: notApplicableMetric(),
                customerUsd: notApplicableMetric(),
                equivalentUsd: unknownMetric(reason),
            },
            provider: null,
            resolvedModel: null,
            providerRequestId: null,
        },
    }
}
