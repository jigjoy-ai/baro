import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Participant, SemanticEvent } from "../../src/runtime/mozaik.js"

import { Critic } from "../../src/participants/critic.js"
import { CriticCodex } from "../../src/participants/critic-codex.js"
import { CriticOpenAI } from "../../src/participants/critic-openai.js"
import { CriticOpenCode } from "../../src/participants/critic-opencode.js"
import { CriticPi } from "../../src/participants/critic-pi.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    AgentResult,
    AgentTurnCompleted,
    Critique,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

interface AuthorityAwareCritic {
    onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void>
    idle(): Promise<void>
}

describe("terminal-turn consumer authority", () => {
    it("all Critic backends reject forged sources and preserve terminal replay ids", async () => {
        const outcomeAuthority = new StoryOutcomeAuthority("run-1")
        const native = source("S1")
        const attacker = source("S1")
        const projector = source("terminal-projector")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }
        outcomeAuthority.registerResultAuthority(correlation, native)

        const common = {
            targets: new Map([["S1", ["tests pass"]]]),
            outcomeAuthority,
            terminalProjectorAuthority: projector,
        }
        const critics: Array<[string, AuthorityAwareCritic]> = [
            ["claude", new Critic(common)],
            ["openai", new CriticOpenAI(common)],
            ["codex", new CriticCodex(common)],
            ["opencode", new CriticOpenCode(common)],
            ["pi", new CriticPi(common)],
        ]

        for (const [backend, critic] of critics) {
            let evaluations = 0
            Object.defineProperty(critic, "evaluate", {
                value: async () => {
                    evaluations += 1
                    return {
                        verdict: "pass",
                        reasoning: "authorized",
                        violatedCriteria: [],
                    }
                },
            })
            const env = joinWithCapture(critic)
            const nativeTerminal = result("native-1")
            const projectedTerminal = turn("projected-1")

            await critic.onExternalEvent(attacker, result("forged-native"))
            await critic.onExternalEvent(attacker, turn("forged-projector"))
            await critic.onExternalEvent(native, nativeTerminal)
            await critic.onExternalEvent(native, nativeTerminal)
            await critic.onExternalEvent(projector, projectedTerminal)
            await critic.onExternalEvent(projector, projectedTerminal)
            await critic.idle()

            assert.equal(evaluations, 2, backend)
            assert.deepEqual(
                env.events.filter(Critique.is).map((event) => event.data.turn),
                [1, 2],
                backend,
            )
        }
    })
})

function result(terminalId: string): ReturnType<typeof AgentResult.create> {
    return AgentResult.create({
        agentId: "S1",
        terminalId,
        subtype: "success",
        sessionId: null,
        isError: false,
        resultText: "done",
        usage: null,
        totalCostUsd: null,
        numTurns: 1,
        durationMs: 1,
    })
}

function turn(terminalId: string): ReturnType<typeof AgentTurnCompleted.create> {
    return AgentTurnCompleted.create({
        agentId: "S1",
        terminalId,
        backend: "codex",
        isError: false,
        resultText: "done",
        canContinue: false,
    })
}
