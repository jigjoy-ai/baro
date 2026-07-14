import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { CriticPi } from "../../src/participants/critic-pi.js"
import {
    AgentResult,
    AgentTargetedMessage,
    AgentTurnCompleted,
    Critique,
    ModelInvocationMeasured,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("CriticPi", () => {
    it("emits critiques while bounding corrective messages", async () => {
        await withTempDir("baro-critic-pi-", async (dir) => {
            const piBin = join(dir, "pi")
            writeFileSync(
                piBin,
                [
                    "#!/bin/sh",
                    "cat <<'JSON'",
                    "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"{\\\"verdict\\\":\\\"fail\\\",\\\"reasoning\\\":\\\"Missing tests\\\",\\\"violated_criteria\\\":[\\\"must include tests\\\"]}\"}]}}",
                    "JSON",
                ].join("\n") + "\n",
            )
            chmodSync(piBin, 0o755)

            const critic = new CriticPi({
                targets: new Map([["agent-a", ["must include tests"]]]),
                maxEmissionsPerAgent: 2,
                piBin,
                // Fresh temp executables can incur a one-time macOS scan;
                // leave enough headroom when the full test suite is spawning
                // many fixture processes concurrently.
                timeoutMs: 60_000,
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
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.equal(critiques[0]!.data.status, "evaluated")
            assert.equal(critiques[0]!.data.modelUsed, "pi-default")
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [
                "must include tests",
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
    })

    it("emits a deterministic fail critique when the backend cannot start", async () => {
        await withTempDir("baro-critic-pi-", async (dir) => {
            const critic = new CriticPi({
                targets: new Map([["agent-a", ["must include tests"]]]),
                model: "fake-pi-model",
                piBin: join(dir, "missing-pi"),
                timeoutMs: 5_000,
            })
            const env = joinWithCapture(critic)

            await critic.onExternalEvent(source("runner"), resultEvent())
            await critic.idle()

            const critiques = env.events.filter(Critique.is)
            const messages = env.events.filter(AgentTargetedMessage.is)

            assert.equal(critiques.length, 1)
            assert.equal(critiques[0]!.data.verdict, "fail")
            assert.equal(critiques[0]!.data.status, "inconclusive")
            assert.equal(critiques[0]!.data.modelUsed, "fake-pi-model")
            assert.match(
                critiques[0]!.data.reasoning,
                /CriticPi LLM call failed: spawn .*missing-pi ENOENT/,
            )
            assert.deepEqual(critiques[0]!.data.violatedCriteria, [
                "[critic error — could not evaluate]",
            ])
            assert.equal(messages.length, 0)
        })
    })

    it("critiques one-shot turns without sending unusable corrections", async () => {
        const critic = new CriticPi({
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
                backend: "pi",
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

async function emitResultTurns(critic: CriticPi, turns: number): Promise<void> {
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
