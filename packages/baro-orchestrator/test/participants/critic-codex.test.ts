import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CriticCodex } from "../../src/participants/critic-codex.js"
import {
    AgentResult,
    AgentTargetedMessage,
    AgentTurnCompleted,
    Critique,
    ModelInvocationMeasured,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("CriticCodex", () => {
    it("emits evaluated fail critiques while bounding corrective messages", async () => {
        await withTempDir("baro-critic-codex-", async (dir) => {
            const critic = new CriticCodex({
                targets: new Map([["agent-a", ["must include tests"]]]),
                maxEmissionsPerAgent: 2,
                model: "fake-codex-model",
                codexBin: writeFakeCodex(dir, {
                    verdict: {
                        verdict: "fail",
                        reasoning: "Missing tests",
                        violated_criteria: ["must include tests"],
                    },
                }),
                timeoutMs: 60_000,
                runId: "run-critic-codex",
            })
            const env = joinWithCapture(critic)

            await emitResultTurns(critic, 3)
            await critic.idle()

            const critiques = env.events.filter(Critique.is)
            const messages = env.events.filter(AgentTargetedMessage.is)
            const measurements = env.events.filter(ModelInvocationMeasured.is)

            assert.equal(critiques.length, 3)
            assert.equal(measurements.length, 3)
            assert.ok(
                env.events.findIndex(ModelInvocationMeasured.is) <
                    env.events.findIndex(Critique.is),
            )
            assert.deepEqual(
                critiques.map((event) => event.data.turn),
                [1, 2, 3],
            )
            assert.ok(
                critiques.every((event) => event.data.status === "evaluated"),
            )
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.equal(critiques[0]!.data.modelUsed, "fake-codex-model")
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [
                "must include tests",
            ])

            assert.equal(measurements[0]!.data.runId, "run-critic-codex")
            assert.equal(measurements[0]!.data.phase, "critic")
            assert.equal(measurements[0]!.data.storyId, "agent-a")
            assert.equal(measurements[0]!.data.backend, "codex")
            assert.equal(measurements[0]!.data.requestedModel, "fake-codex-model")
            assert.equal(measurements[0]!.data.resolvedModel, "fake-resolved-model")

            assert.equal(messages.length, 2)
            assert.deepEqual(
                messages.map((event) => event.data.metadata.emissionIndex),
                [1, 2],
            )
            assert.ok(
                messages.every((event) => event.data.recipientId === "agent-a"),
            )
        })
    })

    it("accepts a valid pass verdict without emitting a correction", async () => {
        await withTempDir("baro-critic-codex-pass-", async (dir) => {
            const critic = new CriticCodex({
                targets: new Map([["agent-a", ["must include tests"]]]),
                codexBin: writeFakeCodex(dir, {
                    verdict: {
                        verdict: "pass",
                        reasoning: "Captured evidence satisfies the criterion",
                        violated_criteria: [],
                    },
                }),
                timeoutMs: 60_000,
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critiques = env.events.filter(Critique.is)
            assert.equal(critiques.length, 1)
            assert.equal(critiques[0]!.data.status, "evaluated")
            assert.equal(critiques[0]!.data.verdict, "pass")
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [])
            assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
            assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 1)
        })
    })

    it("fails closed when the backend cannot start", async () => {
        await withTempDir("baro-critic-codex-missing-", async (dir) => {
            const critic = new CriticCodex({
                targets: new Map([["agent-a", ["must include tests"]]]),
                codexBin: join(dir, "missing-codex"),
                timeoutMs: 5_000,
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critiques = env.events.filter(Critique.is)
            const measurements = env.events.filter(ModelInvocationMeasured.is)
            assert.equal(critiques.length, 1)
            assert.equal(measurements.length, 1)
            assert.equal(measurements[0]!.data.status, "failed")
            assert.equal(critiques[0]!.data.status, "inconclusive")
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.match(
                critiques[0]!.data.reasoning,
                /CriticCodex LLM call failed: spawn .*missing-codex ENOENT/,
            )
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [
                "[critic error — could not evaluate]",
            ])
            assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
        })
    })

    it("fails closed on a malformed verdict without sending a correction", async () => {
        await withTempDir("baro-critic-codex-invalid-", async (dir) => {
            const critic = new CriticCodex({
                targets: new Map([["agent-a", ["must include tests"]]]),
                codexBin: writeFakeCodex(dir, {
                    verdict: {
                        verdict: "pass",
                        reasoning: "contradictory pass",
                        violated_criteria: ["must include tests"],
                    },
                }),
                timeoutMs: 60_000,
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critique = env.events.filter(Critique.is)[0]!
            assert.equal(critique.data.status, "inconclusive")
            assert.equal(critique.data.verdict, "fail")
            assert.match(critique.data.reasoning, /invalid verdict object/)
            assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
            assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 1)
        })
    })

    it("emits an immediate inconclusive verdict when evidence preparation fails", async () => {
        await withTempDir("baro-critic-codex-evidence-failure-", async (dir) => {
            const critic = new CriticCodex({
                targets: new Map([["agent-a", [`criterion-${"x".repeat(3_000)}`]]]),
                codexBin: join(dir, "must-not-launch"),
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critique = env.events.filter(Critique.is)[0]!
            assert.equal(critique.data.status, "inconclusive")
            assert.equal(critique.data.verdict, "fail")
            assert.match(critique.data.reasoning, /could not prepare bounded acceptance evidence/)
            assert.deepEqual(critique.data.violatedCriteria, [
                "[critic evidence preparation failed]",
            ])
            assert.equal(env.events.filter(ModelInvocationMeasured.is).length, 0)
            assert.equal(env.events.filter(AgentTargetedMessage.is).length, 0)
        })
    })

    it("critiques one-shot turns without sending unusable corrections", async () => {
        const critic = new CriticCodex({
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
})

async function emitResultTurns(
    critic: CriticCodex,
    turns: number,
): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await critic.onExternalEvent(source("runner"), resultEvent(turn + 1))
    }
}

function resultEvent(numTurns: number | null = null): ReturnType<typeof AgentResult.create> {
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
    })
}

function writeFakeCodex(
    dir: string,
    opts: { verdict: Record<string, unknown> },
): string {
    const codexBin = join(dir, "fake-codex.mjs")
    const response = JSON.stringify(opts.verdict)
    writeFileSync(
        codexBin,
        `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(response)} } }));
console.log(JSON.stringify({
  type: "turn.completed",
  model: "fake-resolved-model",
  usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8, reasoning_output_tokens: 2 }
}));
`,
    )
    chmodSync(codexBin, 0o755)
    return codexBin
}
