import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    OneShotTurnReview,
    oneShotSurgicalRevisionPrompt,
} from "../../src/participants/one-shot-turn-review.js"
import { AgentTurnCompleted, Critique } from "../../src/semantic-events.js"
import { source } from "./helpers.js"

describe("OneShotTurnReview", () => {
    const projector = source("projector")
    const critic = source("critic")

    it("waits for the exact latest projected terminal and ignores stale reviews", async () => {
        const review = controller()
        review.beginCandidate()
        review.observe(projector, terminal("S1", "terminal-1"))
        review.observe(projector, terminal("S1", "terminal-2"))
        review.observe(critic, critique("S1", "terminal-1", "pass", 1))
        review.observe(critic, critique("S1", "stale-terminal", "pass", 1))

        const waiting = review.reviewNext()
        review.observe(critic, critique("S1", "terminal-2", "fail", 2))

        const result = await waiting
        assert.equal(result.kind, "revise")
        if (result.kind === "revise") {
            assert.equal(result.review.terminalId, "terminal-2")
            assert.match(result.feedback, /authoritative review rejected/i)
        }
    })

    it("hands an exhausted rejected candidate to AcceptanceGate", async () => {
        const review = controller({ maxSurgicalRevisions: 1 })

        review.beginCandidate()
        review.observe(projector, terminal("S1", "terminal-1"))
        review.observe(critic, critique("S1", "terminal-1", "fail", 1))
        assert.equal((await review.reviewNext()).kind, "revise")

        review.beginCandidate()
        review.observe(projector, terminal("S1", "terminal-2"))
        review.observe(critic, critique("S1", "terminal-2", "fail", 2))
        assert.equal((await review.reviewNext()).kind, "handoff")
    })

    it("never hands off a process that produced no correlated terminal", async () => {
        const review = controller({ timeoutMs: 0 })
        review.beginCandidate()

        const result = await review.reviewNext()
        assert.deepEqual(result, {
            kind: "failure",
            error: "quality review requires a stable projected terminal for S1",
            failure: {
                kind: "infrastructure",
                code: "review_uncorrelated",
            },
        })
    })

    it("preserves an immediate zero-timeout review when the exact verdict is queued", async () => {
        const review = controller({ timeoutMs: 0 })
        review.beginCandidate()
        review.observe(projector, terminal("S1", "terminal-immediate"))
        review.observe(
            critic,
            critique("S1", "terminal-immediate", "pass", 1),
        )

        assert.equal((await review.reviewNext()).kind, "pass")
    })

    it("fails closed when exact authorities are missing", () => {
        assert.throws(
            () =>
                new OneShotTurnReview({
                    agentId: "S1",
                    requiresReview: true,
                    authority: critic,
                    timeoutMs: 100,
                    maxSurgicalRevisions: 1,
                }),
            /exact terminal and review authorities/,
        )
    })

    it("builds a fresh-process repair prompt with contract and review", () => {
        const prompt = oneShotSurgicalRevisionPrompt(
            "Implement cancellation and run its race test.",
            {
                agentId: "S1",
                terminalId: "terminal-1",
                status: "evaluated",
                verdict: "fail",
                reasoning: "The abort signal is not forwarded.",
                violatedCriteria: ["forward the exact request signal"],
                turn: 1,
                modelUsed: "test-critic",
            },
        )
        assert.match(prompt, /previous process has exited/)
        assert.match(prompt, /Implement cancellation and run its race test/)
        assert.match(prompt, /abort signal is not forwarded/)
        assert.match(prompt, /narrow surgical repair/)
    })

    function controller(
        overrides: Partial<ConstructorParameters<typeof OneShotTurnReview>[0]> = {},
    ): OneShotTurnReview {
        return new OneShotTurnReview({
            agentId: "S1",
            requiresReview: true,
            terminalAuthority: projector,
            authority: critic,
            timeoutMs: 1_000,
            handoffInconclusiveToAcceptanceGate: true,
            maxSurgicalRevisions: 2,
            ...overrides,
        })
    }
})

function terminal(agentId: string, terminalId: string) {
    return AgentTurnCompleted.create({
        agentId,
        terminalId,
        backend: "codex",
        isError: false,
        resultText: `candidate ${terminalId}`,
        canContinue: false,
    })
}

function critique(
    agentId: string,
    terminalId: string,
    verdict: "pass" | "fail",
    turn: number,
) {
    return Critique.create({
        agentId,
        terminalId,
        status: "evaluated",
        verdict,
        reasoning: verdict === "pass" ? "accepted" : "missing edge case",
        violatedCriteria: verdict === "pass" ? [] : ["handle cancellation"],
        turn,
        modelUsed: "test-critic",
    })
}
