import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    buildSurgeonPrompt,
    CritiqueLog,
    type PrdSnapshot,
} from "../src/participants/surgeon.js"
import { formatRoute, resolveStoryRoute } from "../src/routing.js"
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
