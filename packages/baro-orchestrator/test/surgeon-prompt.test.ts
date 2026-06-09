import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    buildSurgeonPrompt,
    type PrdSnapshot,
} from "../src/participants/surgeon.js"
import { formatRoute, resolveStoryRoute } from "../src/routing.js"
import type { StoryResultData } from "../src/semantic-events.js"

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
        const describe = (model: string | undefined) =>
            formatRoute(
                resolveStoryRoute(model, {
                    fallbackBackend: "codex",
                    override: "gpt-5.5",
                    openaiDefaultModel: "gpt-5.5",
                }),
            )
        const p = buildSurgeonPrompt(snap, failure, describe)
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
