import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    InputTokenDetails,
    ModelMessageItem,
    OutputTokenDetails,
    TokenUsage,
} from "@mozaik-ai/core"

import { knownMetric, unknownMetric } from "../../src/model-telemetry.js"
import { AgentTurnProjector } from "../../src/participants/agent-turn-projector.js"
import { CriticOpenAI } from "../../src/participants/critic-openai.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    AgentResult,
    AgentTargetedMessage,
    AgentTurnCompleted,
    Critique,
    ModelInvocationMeasured,
    StoryQualityReverificationRequested,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { captureEnv, joinWithCapture, source } from "./helpers.js"

describe("CriticOpenAI", () => {
    it("emits critiques while bounding corrective messages", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([["agent-a", ["must include tests"]]]),
            maxEmissionsPerAgent: 2,
            model: "fake-openai-model",
        })
        Object.defineProperty(critic, "evaluate", {
            value: async () => ({
                verdict: "fail",
                reasoning: "Missing tests",
                violatedCriteria: ["must include tests"],
            }),
        })
        const env = joinWithCapture(critic)

        await emitResultTurns(critic, 3)
        await critic.idle()

        const critiques = env.events.filter(Critique.is)
        const messages = env.events.filter(AgentTargetedMessage.is)

        assert.equal(critiques.length, 3)
        assert.deepEqual(
            critiques.map((event) => event.data.turn),
            [1, 2, 3],
        )
        assert.equal(critiques[0]!.data.verdict, "fail")
        assert.equal(critiques[0]!.data.modelUsed, "fake-openai-model")
        assert.deepEqual(critiques[0]!.data.violatedCriteria, [
            "must include tests",
        ])

        assert.equal(messages.length, 2)
        assert.deepEqual(
            messages.map((event) => event.data.metadata.emissionIndex),
            [1, 2],
        )
        assert.ok(messages.every((event) => event.data.recipientId === "agent-a"))
    })

    it("ignores non-actionable events without evaluating", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([["agent-a", ["must include tests"]]]),
            model: "fake-openai-model",
        })
        Object.defineProperty(critic, "evaluate", {
            value: async () => {
                throw new Error("evaluate should not be called")
            },
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(
            source("runner"),
            AgentTargetedMessage.create({
                recipientId: "agent-a",
                text: "please revise",
                metadata: {},
            }),
        )
        await critic.onExternalEvent(
            source("runner"),
            resultEvent({ agentId: "unwatched-agent" }),
        )
        await critic.onExternalEvent(
            source("runner"),
            resultEvent({ isError: true }),
        )
        await critic.onExternalEvent(
            source("runner"),
            resultEvent({ resultText: null }),
        )
        await critic.idle()

        assert.equal(env.events.filter(Critique.is).length, 0)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
    })

    it("critiques one-shot turns without sending unusable corrections", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([["agent-a", ["must include tests"]]]),
            model: "fake-openai-model",
        })
        Object.defineProperty(critic, "evaluate", {
            value: async () => ({
                verdict: "fail",
                reasoning: "Missing tests",
                violatedCriteria: ["must include tests"],
            }),
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(
            source("projector"),
            AgentTurnCompleted.create({
                agentId: "agent-a",
                backend: "opencode",
                isError: false,
                resultText: "implemented feature without enough tests",
                canContinue: false,
            }),
        )
        await critic.idle()

        assert.equal(env.events.filter(Critique.is).length, 1)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
    })

    it("publishes exactly one OpenAI TokenUsage measurement before its critique", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([[
                "agent-a",
                ["must include tests"],
            ]]),
            model: "fake-openai-model",
            runId: "run-openai-critic",
        })
        stubRound(critic, {
            text: JSON.stringify({
                verdict: "pass",
                reasoning: "criteria satisfied",
                violated_criteria: [],
            }),
            usage: new TokenUsage(
                21,
                8,
                29,
                new InputTokenDetails(5),
                new OutputTokenDetails(3),
            ),
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(source("runner"), resultEvent())
        await critic.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        const critiques = env.events.filter(Critique.is)
        assert.equal(measured.length, 1)
        assert.equal(critiques.length, 1)
        assert.ok(
            env.events.indexOf(measured[0]!) < env.events.indexOf(critiques[0]!),
        )

        const item = measured[0]!.data
        assert.equal(
            item.invocationId,
            "run-openai-critic:critic:agent-a:1",
        )
        assert.equal(
            item.measurementId,
            "run-openai-critic:critic:agent-a:1:runner",
        )
        assert.equal(item.runId, "run-openai-critic")
        assert.equal(item.phase, "critic")
        assert.equal(item.status, "succeeded")
        assert.equal(item.backend, "openai")
        assert.equal(item.provider, null)
        assert.equal(item.evidence.providerRequestId, null)
        assert.deepEqual(
            item.tokens.inputTotal,
            knownMetric(21, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.cachedInput,
            knownMetric(5, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.outputTotal,
            knownMetric(8, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.reasoningOutput,
            knownMetric(3, "provider_response"),
        )
        assert.deepEqual(
            item.tokens.total,
            knownMetric(29, "provider_response"),
        )
        assert.deepEqual(
            item.cost.providerUsd,
            unknownMetric("pending_gateway_meter"),
        )
        assert.deepEqual(
            item.cost.customerUsd,
            unknownMetric("pending_gateway_meter"),
        )
    })

    it("preserves projector-authoritative lease correlation in reverification billing telemetry", async () => {
        const runId = "run-openai-reverification"
        const storyId = "agent-a"
        const broker = source("broker")
        const gate = source("acceptance-gate")
        const worker = source(storyId)
        const attacker = source("agent-turn-projector")
        const correlation = {
            runId,
            storyId,
            leaseId: "lease-reverification",
            generation: 7,
        }
        const outcomeAuthority = new StoryOutcomeAuthority(runId)
        outcomeAuthority.registerResultAuthority(correlation, worker)

        const projector = new AgentTurnProjector({ outcomeAuthority })
        projector.setLeaseAuthority(broker)
        projector.setReverificationAuthority(gate)
        const env = captureEnv()
        projector.join(env)

        env.deliverSemanticEvent(
            broker,
            WorkLeaseGranted.create({
                runId,
                offerId: "offer-reverification",
                leaseId: correlation.leaseId,
                workerId: "worker-1",
                generation: correlation.generation,
                request: {
                    storyId,
                    prompt: "implement the candidate",
                    model: "standard",
                    retries: 0,
                    timeoutSecs: 60,
                },
            }),
        )
        env.deliverSemanticEvent(
            worker,
            AgentResult.create({
                agentId: storyId,
                terminalId: "candidate-terminal-1",
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: "candidate bytes",
                usage: null,
                totalCostUsd: null,
                numTurns: 1,
                durationMs: 1,
            }),
        )

        const critic = new CriticOpenAI({
            targets: new Map([[storyId, ["must include tests"]]]),
            model: "fake-openai-model",
            runId,
            outcomeAuthority,
            terminalProjectorAuthority: projector,
        })
        let billedCorrelation: {
            runId: string
            storyId: string
            leaseId: string
            generation: number
        } | null = null
        Object.defineProperty(critic, "runRound", {
            value: async (
                _context: unknown,
                _agentId: string,
                _turn: number,
                resolved: typeof billedCorrelation,
            ) => {
                billedCorrelation = resolved
                return {
                    items: [
                        ModelMessageItem.rehydrate({
                            text: JSON.stringify({
                                verdict: "pass",
                                reasoning: "criteria satisfied",
                                violated_criteria: [],
                            }),
                        }),
                    ],
                    usage: undefined,
                }
            },
        })
        critic.join(env)

        // A source that merely claims to be the projector cannot obtain
        // correlation or trigger evaluation.
        env.deliverSemanticEvent(
            attacker,
            AgentTurnCompleted.create({
                agentId: storyId,
                terminalId: "forged-reverification",
                backend: "codex",
                isError: false,
                resultText: "forged bytes",
                canContinue: false,
            }),
        )
        await critic.idle()
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)

        env.deliverSemanticEvent(
            gate,
            StoryQualityReverificationRequested.create({
                runId,
                requestId: "reverify-billing-1",
                previousEvaluationId: "quality-1",
                evaluationId: "quality-2",
                storyId,
                leaseId: correlation.leaseId,
                generation: correlation.generation,
                targetTurn: 1,
                terminalId: "candidate-terminal-1",
                attempt: 1,
                reason: "critic unavailable",
            }),
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
        await critic.idle()

        const replay = env.events
            .filter(AgentTurnCompleted.is)
            .find((event) => event.data.terminalId?.startsWith("reverification:"))
        assert.ok(replay)
        assert.deepEqual(
            projector.terminalCorrelationFor(
                storyId,
                replay.data.terminalId,
            ),
            correlation,
        )
        assert.deepEqual(billedCorrelation, correlation)

        const measured = env.events.filter(ModelInvocationMeasured.is)
        assert.equal(measured.length, 1)
        assert.equal(measured[0]!.data.runId, runId)
        assert.equal(measured[0]!.data.storyId, storyId)
        assert.equal(measured[0]!.data.leaseId, correlation.leaseId)
        assert.equal(measured[0]!.data.generation, correlation.generation)
        assert.equal(env.events.filter(Critique.is).length, 1)
    })

    it("keeps successful telemetry when OpenAI returns a malformed verdict", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([[
                "agent-a",
                ["must include tests"],
            ]]),
            model: "fake-openai-model",
        })
        stubRound(critic, {
            text: "not a verdict object",
            usage: new TokenUsage(
                2,
                1,
                3,
                new InputTokenDetails(0),
                new OutputTokenDetails(0),
            ),
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(source("runner"), resultEvent())
        await critic.idle()

        const measured = env.events.filter(ModelInvocationMeasured.is)
        const critiques = env.events.filter(Critique.is)
        assert.equal(measured.length, 1)
        assert.equal(measured[0]!.data.status, "succeeded")
        assert.deepEqual(
            measured[0]!.data.tokens.total,
            knownMetric(3, "provider_response"),
        )
        assert.equal(critiques.length, 1)
        assert.equal(critiques[0]!.data.verdict, "fail")
        assert.equal(critiques[0]!.data.status, "inconclusive")
        assert.match(critiques[0]!.data.reasoning, /no JSON object found/)
    })

    it("reports provider failures and timeouts once without invented zeros", async () => {
        const cases = [
            {
                name: "provider failure",
                error: new Error("provider unavailable"),
                status: "failed" as const,
                reason: "not_reported" as const,
            },
            {
                name: "timeout",
                error: Object.assign(new Error("request timed out"), {
                    code: "ETIMEDOUT",
                }),
                status: "timed_out" as const,
                reason: "timed_out" as const,
            },
        ]

        for (const item of cases) {
            const critic = new CriticOpenAI({
                targets: new Map([[
                    "agent-a",
                    ["must include tests"],
                ]]),
                model: "fake-openai-model",
            })
            Object.defineProperty(critic, "runRound", {
                value: async () => {
                    throw item.error
                },
            })
            const env = joinWithCapture(critic)
            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const measured = env.events.filter(ModelInvocationMeasured.is)
            const critiques = env.events.filter(Critique.is)
            const messages = env.events.filter(AgentTargetedMessage.is)
            assert.equal(measured.length, 1, item.name)
            assert.equal(measured[0]!.data.status, item.status, item.name)
            assert.deepEqual(
                measured[0]!.data.tokens.inputTotal,
                unknownMetric(item.reason),
                item.name,
            )
            assert.deepEqual(
                measured[0]!.data.tokens.total,
                unknownMetric(item.reason),
                item.name,
            )
            assert.equal(critiques[0]?.data.status, "inconclusive", item.name)
            assert.equal(messages.length, 0, item.name)
        }
    })

    it("skips the evaluator and corrective message when evidence is inconclusive", async () => {
        const critic = new CriticOpenAI({
            targets: new Map([["agent-a", ["must include tests"]]]),
            model: "fake-openai-model",
            evidence: {
                resolveRepositoryTarget: () => null,
            },
        })
        let evaluations = 0
        Object.defineProperty(critic, "evaluate", {
            value: async () => {
                evaluations += 1
                return {
                    verdict: "fail",
                    reasoning: "should not run",
                    violatedCriteria: ["must include tests"],
                }
            },
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(source("runner"), resultEvent())
        await critic.idle()

        const critiques = env.events.filter(Critique.is)
        assert.equal(evaluations, 0)
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
        assert.equal(critiques.length, 1)
        assert.equal(critiques[0]!.data.status, "inconclusive")
        assert.equal(critiques[0]!.data.verdict, "fail")
        assert.match(critiques[0]!.data.reasoning, /repository evidence is unavailable/)
    })
})

async function emitResultTurns(
    critic: CriticOpenAI,
    turns: number,
): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await critic.onExternalEvent(
            source("runner"),
            resultEvent({ numTurns: turn + 1 }),
        )
    }
}

function resultEvent(
    overrides: Partial<Parameters<typeof AgentResult.create>[0]> = {},
): ReturnType<typeof AgentResult.create> {
    return AgentResult.create({
        agentId: "agent-a",
        subtype: "success",
        sessionId: null,
        isError: false,
        resultText: "implemented feature without enough tests",
        usage: null,
        totalCostUsd: null,
        numTurns: null,
        durationMs: null,
        ...overrides,
    })
}

function stubRound(
    critic: CriticOpenAI,
    response: { text: string; usage: TokenUsage | undefined },
): void {
    Object.defineProperty(critic, "runRound", {
        value: async () => ({
            items: [ModelMessageItem.rehydrate({ text: response.text })],
            usage: response.usage,
        }),
    })
}
