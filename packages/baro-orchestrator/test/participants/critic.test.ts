import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Critic } from "../../src/participants/critic.js"
import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

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
})

async function emitResultTurns(critic: Critic, turns: number): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await critic.onExternalEvent(source("runner"), resultEvent())
    }
}

function resultEvent(): ReturnType<typeof AgentResult.create> {
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
    })
}
