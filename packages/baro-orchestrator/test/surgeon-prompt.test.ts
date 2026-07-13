import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    buildSurgeonPrompt,
    CritiqueLog,
    SURGEON_SYSTEM_PROMPT,
    type PrdSnapshot,
} from "../src/participants/surgeon.js"
import { formatRoute, resolveStoryRoute } from "../src/routing.js"
import {
    resolveSurgeonEscalationRoute,
    validateCollectiveWorkers,
} from "../src/orchestrate.js"
import { Critique, type StoryResultData } from "../src/semantic-events.js"

const snap: PrdSnapshot = {
    project: "demo",
    description: "d",
    stories: [
        { id: "S1", title: "broad story", description: "does a lot", dependsOn: [], passes: false, model: "sonnet" },
    ],
}

const failure: StoryResultData = {
    storyId: "S1",
    success: false,
    attempts: 3,
    durationSecs: 42,
    error: "exit 1",
}

describe("buildSurgeonPrompt — names the model that actually ran (#48)", () => {
    it("shows only the planner tier when no route describer is wired", () => {
        const p = buildSurgeonPrompt(snap, failure)
        assert.match(p, /Tier that just failed: sonnet/)
        assert.doesNotMatch(p, /Model that actually ran/)
    })

    it("adds the actual model and tells the LLM to cite it, keeping the tier line", () => {
        // Mirrors orchestrate(): --story-llm codex --story-model gpt-5.5.
        const routeDescriber = (model: string | undefined) =>
            formatRoute(
                resolveStoryRoute(model, {
                    fallbackBackend: "codex",
                    override: "gpt-5.5",
                    openaiDefaultModel: "gpt-5.5",
                }),
            )
        const p = buildSurgeonPrompt(snap, failure, routeDescriber)
        assert.match(p, /Model that actually ran: codex:gpt-5\.5/)
        assert.match(p, /refer to THIS model in your reason, not the tier/)
        // The planner tier stays (the escalation rule depends on it).
        assert.match(p, /Tier that just failed: sonnet/)
    })

    it("omits the actual-model line when the describer can't resolve a route", () => {
        const p = buildSurgeonPrompt(snap, failure, () => null)
        assert.doesNotMatch(p, /Model that actually ran/)
        assert.match(p, /Tier that just failed: sonnet/)
    })
})

describe("buildSurgeonPrompt — Critic verdicts feed the replan decision", () => {
    function critique(turn: number, reasoning: string, violated: string[] = []) {
        return Critique.create({
            agentId: "S1",
            verdict: "fail" as const,
            reasoning,
            violatedCriteria: violated,
            turn,
            modelUsed: "haiku",
        })
    }

    it("includes the story's recent critiques with violated criteria", () => {
        const log = new CritiqueLog()
        log.record(critique(1, "tests missing", ["A1"]))
        log.record(critique(2, "still no tests", ["A1", "A2"]))
        const p = buildSurgeonPrompt(snap, failure, undefined, undefined, log.forStory("S1"))
        assert.match(p, /# Critic verdicts on this story/)
        assert.match(p, /turn 1: FAIL — tests missing \(violated: A1\)/)
        assert.match(p, /turn 2: FAIL — still no tests \(violated: A1; A2\)/)
    })

    it("keeps only the latest N critiques and separates stories", () => {
        const log = new CritiqueLog(2)
        log.record(critique(1, "first"))
        log.record(critique(2, "second"))
        log.record(critique(3, "third"))
        assert.deepEqual(
            log.forStory("S1").map((c) => c.turn),
            [2, 3],
        )
        assert.deepEqual(log.forStory("S2"), [])
    })

    it("omits the section when there are no critiques", () => {
        const p = buildSurgeonPrompt(snap, failure, undefined, undefined, [])
        assert.doesNotMatch(p, /Critic verdicts/)
    })
})

describe("Surgeon execution escalation routing", () => {
    it("keeps recovery on the semantic heavy lane when Surgeon reasoning uses GLM", () => {
        assert.equal(
            resolveSurgeonEscalationRoute({
                surgeonLlm: "openai",
                surgeonModel: "glm-5.2",
                tierMap: {
                    default: "openai:deepseek-v4-flash",
                    heavy: "openai:deepseek-v4-pro",
                },
            }),
            "heavy",
        )
    })

    it("preserves explicit backend escalation when no tier router exists", () => {
        assert.equal(
            resolveSurgeonEscalationRoute({
                surgeonLlm: "openai",
                surgeonModel: "glm-5.2",
            }),
            "openai:glm-5.2",
        )
    })

    it("uses the heavy selector only when the worker market has a heavy lane", () => {
        assert.equal(
            resolveSurgeonEscalationRoute({
                surgeonLlm: "openai",
                surgeonModel: "glm-5.2",
                collectiveWorkers: [
                    { tiers: ["default", "light", "standard"] },
                    { tiers: ["heavy"] },
                ],
            }),
            "heavy",
        )
        assert.equal(
            resolveSurgeonEscalationRoute({
                surgeonLlm: "openai",
                surgeonModel: "glm-5.2",
                collectiveWorkers: [
                    { tiers: ["default", "light", "standard"] },
                ],
            }),
            undefined,
        )
    })

    it("does not call a partial tier map an available heavy route", () => {
        assert.equal(
            resolveSurgeonEscalationRoute({
                surgeonLlm: "openai",
                surgeonModel: "glm-5.2",
                tierMap: { default: "openai:deepseek-v4-flash" },
            }),
            "openai:glm-5.2",
        )
    })

    it("fails fast when a restricted worker market leaves a story tier uncovered", () => {
        const estimate = {
            expectedCostUsd: 0.01,
            estimatedSuccessProbability: 0.8,
            estimatedLatencyMs: 1_000,
            estimateSource: "configured" as const,
        }
        assert.throws(
            () =>
                validateCollectiveWorkers(
                    [
                        {
                            workerId: "flash",
                            routeId: "flash-route",
                            route: "openai:deepseek-v4-flash",
                            tiers: ["default", "light", "standard"],
                            estimate,
                        },
                    ],
                    "collective",
                    undefined,
                ),
            /required story tier 'heavy'/,
        )
        assert.doesNotThrow(() =>
            validateCollectiveWorkers(
                [
                    {
                        workerId: "flash",
                        routeId: "flash-route",
                        route: "openai:deepseek-v4-flash",
                        tiers: ["default", "light", "standard"],
                        estimate,
                    },
                    {
                        workerId: "pro",
                        routeId: "pro-route",
                        route: "openai:deepseek-v4-pro",
                        tiers: ["heavy"],
                        estimate,
                    },
                ],
                "collective",
                undefined,
            ),
        )
    })

    it("gives the model one consistent exact-selector instruction", () => {
        const prompt = buildSurgeonPrompt(
            snap,
            failure,
            undefined,
            "heavy",
        )
        assert.match(prompt, /Escalation selector/)
        assert.match(prompt, /model" to EXACTLY: heavy/)
        assert.match(SURGEON_SYSTEM_PROMPT, /semantic tier "heavy"/)
        assert.doesNotMatch(SURGEON_SYSTEM_PROMPT, /Do NOT use planner tier names/)
    })
})
