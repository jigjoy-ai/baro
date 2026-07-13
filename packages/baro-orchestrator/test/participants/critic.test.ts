import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { knownMetric, unknownMetric } from "../../src/model-telemetry.js"
import { Critic } from "../../src/participants/critic.js"
import {
    AgentResult,
    AgentTargetedMessage,
    AgentTurnCompleted,
    Critique,
    ModelInvocationMeasured,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Critic", () => {
    it("emits critiques while bounding corrective messages", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
            maxEmissionsPerAgent: 2,
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
        assert.equal(critiques[0]!.data.reasoning, "Missing tests")
        assert.deepEqual(critiques[0]!.data.violatedCriteria, [
            "must include tests",
        ])

        assert.equal(messages.length, 2)
        assert.deepEqual(
            messages.map((event) => event.data.metadata.emissionIndex),
            [1, 2],
        )
        assert.deepEqual(
            messages.map((event) => event.data.recipientId),
            ["agent-a", "agent-a"],
        )
        assert.match(messages[0]!.data.text, /Missing tests/)
    })

    it("emits pass critiques without corrective messages", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
            model: "fake-claude-model",
        })
        Object.defineProperty(critic, "evaluate", {
            value: async () => ({
                verdict: "pass",
                reasoning: "All criteria satisfied",
                violatedCriteria: [],
            }),
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(source("runner"), resultEvent())
        await critic.idle()

        const critiques = env.events.filter(Critique.is)
        const messages = env.events.filter(AgentTargetedMessage.is)

        assert.equal(critiques.length, 1)
        assert.equal(critiques[0]!.data.agentId, "agent-a")
        assert.equal(critiques[0]!.data.verdict, "pass")
        assert.equal(critiques[0]!.data.reasoning, "All criteria satisfied")
        assert.deepEqual(critiques[0]!.data.violatedCriteria, [])
        assert.equal(critiques[0]!.data.modelUsed, "fake-claude-model")
        assert.equal(messages.length, 0)
    })

    it("critiques one-shot turns without sending unusable corrections", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
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
                backend: "codex",
                isError: false,
                resultText: "implemented feature without enough tests",
                canContinue: false,
            }),
        )
        await critic.idle()

        assert.equal(env.events.filter(Critique.is).length, 1)
        assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
    })

    it("does not pay for or publish a second critique on Claude terminal replay", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
        })
        let evaluations = 0
        Object.defineProperty(critic, "evaluate", {
            value: async () => {
                evaluations += 1
                return {
                    verdict: "pass",
                    reasoning: "done",
                    violatedCriteria: [],
                }
            },
        })
        const env = joinWithCapture(critic)
        const terminal = resultEvent(1)

        await critic.onExternalEvent(source("runner"), terminal)
        await critic.onExternalEvent(source("replay"), terminal)
        await critic.idle()

        assert.equal(evaluations, 1)
        assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 1)
        assert.equal(env.events.filter(Critique.is).length, 1)
    })

    it("does not collapse two real identity-less terminal turns with identical payloads", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
        })
        let evaluations = 0
        Object.defineProperty(critic, "evaluate", {
            value: async () => {
                evaluations += 1
                return {
                    verdict: "pass",
                    reasoning: "done",
                    violatedCriteria: [],
                }
            },
        })
        const env = joinWithCapture(critic)

        await critic.onExternalEvent(source("turn-1"), resultEvent())
        await critic.onExternalEvent(source("turn-2"), resultEvent())
        await critic.idle()

        assert.equal(evaluations, 2)
        assert.deepEqual(
            env.events.filter(Critique.is).map((event) => event.data.turn),
            [1, 2],
        )
    })

    it("deduplicates a replay carrying an explicit producer terminal id", async () => {
        const critic = new Critic({
            targets: new Map([["agent-a", ["must include tests"]]]),
        })
        let evaluations = 0
        Object.defineProperty(critic, "evaluate", {
            value: async () => {
                evaluations += 1
                return {
                    verdict: "pass",
                    reasoning: "done",
                    violatedCriteria: [],
                }
            },
        })
        const env = joinWithCapture(critic)
        const terminal = resultEvent(null, { terminalId: "openai-terminal-1" })

        await critic.onExternalEvent(source("native-openai"), terminal)
        await critic.onExternalEvent(source("audit-replay"), terminal)
        await critic.idle()

        assert.equal(evaluations, 1)
        assert.equal(env.events.filter(Critique.is).length, 1)
    })

    it("publishes exactly one trustworthy Claude measurement before its critique", async () => {
        await withTempDir("baro-critic-telemetry-", async (dir) => {
            const wrapper = {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: "conversation-id-not-a-provider-request-id",
                duration_ms: 321,
                total_cost_usd: 0.0125,
                usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 5,
                    cache_creation_input_tokens: 3,
                    output_tokens: 7,
                },
                result: JSON.stringify({
                    verdict: "pass",
                    reasoning: "criteria satisfied",
                    violated_criteria: [],
                }),
            }
            const critic = new Critic({
                targets: new Map([[
                    "agent-a",
                    ["must include tests"],
                ]]),
                claudeBin: writeFakeClaude(dir, wrapper),
                model: "claude-test",
                runId: "run-critic",
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const measured = env.events.filter(ModelInvocationMeasured.is)
            const critiques = env.events.filter(Critique.is)
            assert.equal(measured.length, 1)
            assert.equal(critiques.length, 1)
            assert.ok(
                env.events.indexOf(measured[0]!) <
                    env.events.indexOf(critiques[0]!),
            )

            const item = measured[0]!.data
            assert.equal(item.invocationId, "run-critic:critic:agent-a:1")
            assert.equal(
                item.measurementId,
                "run-critic:critic:agent-a:1:runner",
            )
            assert.equal(item.runId, "run-critic")
            assert.equal(item.phase, "critic")
            assert.equal(item.status, "succeeded")
            assert.equal(item.backend, "claude")
            assert.equal(item.provider, null)
            assert.equal(item.evidence.providerRequestId, null)
            assert.deepEqual(item.durationMs, knownMetric(321, "cli_result"))
            assert.deepEqual(
                item.tokens.inputTotal,
                knownMetric(18, "derived"),
            )
            assert.deepEqual(
                item.tokens.cachedInput,
                knownMetric(5, "provider_response"),
            )
            assert.deepEqual(
                item.tokens.cacheWriteInput,
                knownMetric(3, "provider_response"),
            )
            assert.deepEqual(
                item.tokens.outputTotal,
                knownMetric(7, "provider_response"),
            )
            assert.deepEqual(item.tokens.total, knownMetric(25, "derived"))
            assert.deepEqual(
                item.cost.equivalentUsd,
                knownMetric(0.0125, "cli_result"),
            )
        })
    })

    it("keeps successful telemetry when Claude returns a malformed verdict", async () => {
        await withTempDir("baro-critic-malformed-", async (dir) => {
            const critic = new Critic({
                targets: new Map([[
                    "agent-a",
                    ["must include tests"],
                ]]),
                claudeBin: writeFakeClaude(dir, {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    duration_ms: 8,
                    total_cost_usd: 0.001,
                    usage: {
                        input_tokens: 2,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        output_tokens: 1,
                    },
                    result: "not a verdict object",
                }),
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
                knownMetric(3, "derived"),
            )
            assert.equal(critiques.length, 1)
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.match(critiques[0]!.data.reasoning, /no JSON object found/)
        })
    })

    it("reports spawn failures and timeouts once without invented zeros", async () => {
        await withTempDir("baro-critic-failures-", async (dir) => {
            const cases = [
                {
                    name: "spawn failure",
                    bin: join(dir, "does-not-exist"),
                    timeoutMs: 1_000,
                    status: "failed" as const,
                    reason: "not_reported" as const,
                },
                {
                    name: "timeout",
                    bin: writeShell(dir, "slow-claude", "sleep 1"),
                    timeoutMs: 10,
                    status: "timed_out" as const,
                    reason: "timed_out" as const,
                },
            ]

            for (const item of cases) {
                const critic = new Critic({
                    targets: new Map([[
                        "agent-a",
                        ["must include tests"],
                    ]]),
                    claudeBin: item.bin,
                    timeoutMs: item.timeoutMs,
                })
                const env = joinWithCapture(critic)
                await critic.onExternalEvent(source("runner"), resultEvent())
                await critic.idle()

                const measured = env.events.filter(ModelInvocationMeasured.is)
                assert.equal(measured.length, 1, item.name)
                assert.equal(measured[0]!.data.status, item.status, item.name)
                assert.deepEqual(
                    measured[0]!.data.tokens.inputTotal,
                    unknownMetric(item.reason),
                    item.name,
                )
                assert.deepEqual(
                    measured[0]!.data.cost.equivalentUsd,
                    unknownMetric(item.reason),
                    item.name,
                )
            }
        })
    })
})

async function emitResultTurns(critic: Critic, turns: number): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await critic.onExternalEvent(source("runner"), resultEvent(turn + 1))
    }
}

function resultEvent(
    numTurns: number | null = null,
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
        numTurns,
        durationMs: null,
        ...overrides,
    })
}

function writeFakeClaude(
    dir: string,
    wrapper: Record<string, unknown>,
): string {
    const json = JSON.stringify(wrapper).replaceAll("'", "'\"'\"'")
    return writeShell(dir, "fake-claude", `printf '%s\\n' '${json}'`)
}

function writeShell(dir: string, name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
}
