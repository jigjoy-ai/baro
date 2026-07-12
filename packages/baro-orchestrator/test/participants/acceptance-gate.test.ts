import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AcceptanceGate,
    DEFAULT_ACCEPTANCE_TIMEOUT_MS,
} from "../../src/participants/acceptance-gate.js"
import {
    AgentResult,
    AgentTurnCompleted,
    Critique,
    StoryQualityCompleted,
    StoryQualityTimedOut,
    StoryResult,
    WorkLeaseGranted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("AcceptanceGate", () => {
    it("keeps the default gate open for a bounded Critic evaluation", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        assert.equal(DEFAULT_ACCEPTANCE_TIMEOUT_MS, 240_000)

        const gate = new AcceptanceGate({
            runId: "run-default-timeout",
            targets: new Map([["S1", ["tests"]]]),
        })
        const env = joinWithCapture(gate)
        grantLease(env, "run-default-timeout", "S1", "lease-1", 1)
        deliverAgentResult(env, "S1", "done")
        deliverStoryResult(env, "run-default-timeout", "S1", "lease-1", 1)
        await gate.idle()

        t.mock.timers.tick(DEFAULT_ACCEPTANCE_TIMEOUT_MS - 1)
        await gate.idle()
        assert.equal(env.events.filter(StoryQualityTimedOut.is).length, 0)
        assert.equal(env.events.filter(StoryQualityCompleted.is).length, 0)

        deliverCritique(env, "S1", 1, "pass", "criteria satisfied")
        await gate.idle()
        const quality = env.events.find(StoryQualityCompleted.is)
        assert.ok(quality)
        assert.equal(quality.data.status, "passed")
    })

    it("resolves a passing critique that arrives after the successful result", async () => {
        const gate = targetedGate("run-after", 200)
        const env = joinWithCapture(gate)
        grantLease(env, "run-after", "S1", "lease-1", 1)
        deliverAgentResult(env, "S1", "done")
        deliverStoryResult(env, "run-after", "S1", "lease-1", 1)
        await gate.idle()
        assert.equal(env.events.filter(StoryQualityCompleted.is).length, 0)

        deliverCritique(env, "S1", 1, "pass", "criteria satisfied")
        const quality = await qualityResult(env)

        assert.equal(quality.data.status, "passed")
        assert.equal(quality.data.targetTurn, 1)
        assert.equal(quality.data.leaseId, "lease-1")
        assert.equal(quality.data.critique?.verdict, "pass")
    })

    it("resolves a buffered critique that arrives before the successful result", async () => {
        const gate = targetedGate("run-before", 200)
        const env = joinWithCapture(gate)
        grantLease(env, "run-before", "S1", "lease-1", 1)
        deliverAgentTurn(env, "S1", "codex", "done")
        deliverCritique(env, "S1", 1, "pass", "criteria satisfied")
        deliverStoryResult(env, "run-before", "S1", "lease-1", 1)

        const quality = await qualityResult(env)
        assert.equal(quality.data.status, "passed")
        assert.equal(quality.data.targetTurn, 1)
        assert.equal(quality.data.critique?.turn, 1)
    })

    it("fails quality when the terminal-turn critique fails", async () => {
        const gate = targetedGate("run-fail", 200)
        const env = joinWithCapture(gate)
        grantLease(env, "run-fail", "S1", "lease-1", 1)
        deliverAgentTurn(env, "S1", "opencode", "done")
        deliverCritique(env, "S1", 1, "fail", "tests are missing")
        deliverStoryResult(env, "run-fail", "S1", "lease-1", 1)

        const quality = await qualityResult(env)
        assert.equal(quality.data.status, "failed")
        assert.equal(quality.data.reason, "tests are missing")
        assert.deepEqual(quality.data.critique?.violatedCriteria, ["tests"])
    })

    it("passes immediately when no acceptance criteria are configured", async () => {
        const gate = new AcceptanceGate({
            runId: "run-no-target",
            targets: new Map(),
            timeoutMs: 20,
        })
        const env = joinWithCapture(gate)
        grantLease(env, "run-no-target", "S1", "lease-1", 1)
        deliverStoryResult(env, "run-no-target", "S1", "lease-1", 1)

        const quality = await qualityResult(env)
        assert.equal(quality.data.status, "passed")
        assert.equal(quality.data.targetTurn, null)
        assert.equal(quality.data.reason, "no acceptance criteria configured")
        assert.equal(env.events.filter(StoryQualityTimedOut.is).length, 0)
    })

    it("fails closed when no terminal turn arrives", async () => {
        const gate = targetedGate("run-no-turn", 10)
        const env = joinWithCapture(gate)
        grantLease(env, "run-no-turn", "S1", "lease-1", 1)
        deliverStoryResult(env, "run-no-turn", "S1", "lease-1", 1)

        const quality = await qualityResult(env)
        assert.equal(env.events.filter(StoryQualityTimedOut.is).length, 1)
        assert.equal(quality.data.status, "failed")
        assert.equal(quality.data.targetTurn, null)
        assert.match(quality.data.reason, /no terminal agent turn/)
    })

    it("fails closed when the terminal turn has no critique", async () => {
        const gate = targetedGate("run-no-critique", 10)
        const env = joinWithCapture(gate)
        grantLease(env, "run-no-critique", "S1", "lease-1", 1)
        deliverAgentResult(env, "S1", "done")
        deliverStoryResult(env, "run-no-critique", "S1", "lease-1", 1)

        const quality = await qualityResult(env)
        assert.equal(env.events.filter(StoryQualityTimedOut.is).length, 1)
        assert.equal(quality.data.status, "failed")
        assert.equal(quality.data.targetTurn, 1)
        assert.match(quality.data.reason, /no critique for terminal turn 1/)
    })

    it("deduplicates replay and ignores stale run, lease, generation, and timeout", async () => {
        const gate = targetedGate("run-current", 200)
        const env = joinWithCapture(gate)
        grantLease(env, "run-current", "S1", "lease-current", 2)

        deliverAgentTurn(env, "S1", "pi", "same terminal output")
        deliverAgentTurn(env, "S1", "pi", "same terminal output")
        deliverCritique(env, "S1", 1, "pass", "criteria satisfied")
        deliverCritique(env, "S1", 1, "fail", "replayed conflict")

        deliverStoryResult(env, "other-run", "S1", "lease-current", 2)
        deliverStoryResult(env, "run-current", "S1", "lease-stale", 2)
        deliverStoryResult(env, "run-current", "S1", "lease-current", 1)
        await gate.idle()
        assert.equal(env.events.filter(StoryQualityCompleted.is).length, 0)

        deliverStoryResult(env, "run-current", "S1", "lease-current", 2)
        deliverStoryResult(env, "run-current", "S1", "lease-current", 2)
        const quality = await qualityResult(env)
        assert.equal(quality.data.status, "passed")
        assert.equal(quality.data.targetTurn, 1)

        env.deliverSemanticEvent(
            gate,
            StoryQualityTimedOut.create({
                runId: "run-current",
                evaluationId: quality.data.evaluationId,
                storyId: "S1",
                leaseId: "lease-current",
                generation: 2,
                targetTurn: 1,
                timeoutMs: 200,
            }),
        )
        deliverStoryResult(env, "run-current", "S1", "lease-current", 2)
        await gate.idle()
        assert.equal(env.events.filter(StoryQualityCompleted.is).length, 1)
    })
})

function targetedGate(runId: string, timeoutMs: number): AcceptanceGate {
    return new AcceptanceGate({
        runId,
        targets: new Map([["S1", ["tests"]]]),
        timeoutMs,
    })
}

function grantLease(
    env: ReturnType<typeof joinWithCapture>,
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
): void {
    env.deliverSemanticEvent(
        source("broker"),
        WorkLeaseGranted.create({
            runId,
            offerId: `offer-${storyId}`,
            leaseId,
            workerId: "worker",
            generation,
            request: {
                storyId,
                prompt: storyId,
                model: "standard",
                retries: 0,
                timeoutSecs: 60,
            },
        }),
    )
}

function deliverAgentResult(
    env: ReturnType<typeof joinWithCapture>,
    agentId: string,
    resultText: string,
): void {
    env.deliverSemanticEvent(
        source("agent"),
        AgentResult.create({
            agentId,
            subtype: "success",
            sessionId: "session-1",
            isError: false,
            resultText,
            usage: null,
            totalCostUsd: null,
            numTurns: 1,
            durationMs: 1,
        }),
    )
}

function deliverAgentTurn(
    env: ReturnType<typeof joinWithCapture>,
    agentId: string,
    backend: string,
    resultText: string,
): void {
    env.deliverSemanticEvent(
        source("projector"),
        AgentTurnCompleted.create({
            agentId,
            backend,
            isError: false,
            resultText,
            canContinue: false,
        }),
    )
}

function deliverCritique(
    env: ReturnType<typeof joinWithCapture>,
    agentId: string,
    turn: number,
    verdict: "pass" | "fail",
    reasoning: string,
): void {
    env.deliverSemanticEvent(
        source("critic"),
        Critique.create({
            agentId,
            verdict,
            reasoning,
            violatedCriteria: verdict === "fail" ? ["tests"] : [],
            turn,
            modelUsed: "test-critic",
        }),
    )
}

function deliverStoryResult(
    env: ReturnType<typeof joinWithCapture>,
    runId: string,
    storyId: string,
    leaseId: string,
    generation: number,
): void {
    env.deliverSemanticEvent(
        source("story"),
        StoryResult.create({
            storyId,
            success: true,
            attempts: 1,
            durationSecs: 1,
            error: null,
            runId,
            leaseId,
            generation,
        }),
    )
}

async function qualityResult(
    env: ReturnType<typeof joinWithCapture>,
): Promise<ReturnType<typeof StoryQualityCompleted.create>> {
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
        const event = env.events.find(StoryQualityCompleted.is)
        if (event) return event
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error("timed out waiting for story quality result")
}
