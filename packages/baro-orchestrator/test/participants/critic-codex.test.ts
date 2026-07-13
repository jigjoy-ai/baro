import assert from "node:assert/strict"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
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
    it("fails closed while bounding corrective messages", async () => {
        const critic = new CriticCodex({
            targets: new Map([["agent-a", ["must include tests"]]]),
            maxEmissionsPerAgent: 2,
        })
        const env = joinWithCapture(critic)

        await emitResultTurns(critic, 3)
        await critic.idle()

        const critiques = env.events.filter(Critique.is)
        const messages = env.events.filter(AgentTargetedMessage.is)
        const measurements = env.events.filter(ModelInvocationMeasured.is)

        assert.equal(critiques.length, 3)
        assert.equal(measurements.length, 0, "no model process was invoked")
        assert.deepEqual(
            critiques.map((event) => event.data.turn),
            [1, 2, 3],
        )
        assert.equal(critiques[0]!.data.verdict, "fail")
        assert.equal(critiques[0]!.data.modelUsed, "codex-default")
        assert.match(critiques[0]!.data.reasoning, /no tool-less inference mode/)
        assert.deepEqual(critiques[0]!.data.violatedCriteria, [
            "[critic backend unavailable — tool-less evaluation required]",
        ])

        assert.equal(messages.length, 2)
        assert.deepEqual(
            messages.map((event) => event.data.metadata.emissionIndex),
            [1, 2],
        )
        assert.ok(
            messages.every((event) => event.data.recipientId === "agent-a"),
        )
    })

    it("never launches the configured Codex binary", async () => {
        await withTempDir("baro-critic-codex-", async (dir) => {
            const codexBin = join(dir, "codex")
            const sentinel = join(dir, "codex-was-launched")
            writeFileSync(
                codexBin,
                `#!/bin/sh\nprintf unsafe > ${JSON.stringify(sentinel)}\n`,
            )
            chmodSync(codexBin, 0o755)

            const critic = new CriticCodex({
                targets: new Map([["agent-a", ["must include tests"]]]),
                codexBin,
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critiques = env.events.filter(Critique.is)
            const messages = env.events.filter(AgentTargetedMessage.is)

            assert.equal(existsSync(sentinel), false)
            assert.equal(critiques.length, 1)
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.match(
                critiques[0]!.data.reasoning,
                /no tool-less inference mode/,
            )
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [
                "[critic backend unavailable — tool-less evaluation required]",
            ])
            assert.equal(messages.length, 1)
            assert.equal(messages[0]!.data.recipientId, "agent-a")
            assert.equal(messages[0]!.data.metadata.criticTurn, 1)
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
