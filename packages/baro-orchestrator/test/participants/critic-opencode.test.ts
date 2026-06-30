import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { CriticOpenCode } from "../../src/participants/critic-opencode.js"
import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("CriticOpenCode", () => {
    it("emits critiques while bounding corrective messages", async () => {
        const critic = new CriticOpenCode({
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
        assert.equal(critiques[0]!.data.modelUsed, "opencode-default")
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
})

async function emitResultTurns(
    critic: CriticOpenCode,
    turns: number,
): Promise<void> {
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
