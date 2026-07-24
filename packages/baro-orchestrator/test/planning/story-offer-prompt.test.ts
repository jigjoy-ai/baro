import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    buildRecoveryPromptSection,
    buildStoryOfferPrompt,
} from "../../src/planning/story-offer-prompt.js"
import type { PrdStory } from "../../src/prd.js"

const STORY: PrdStory = {
    id: "S1",
    priority: 1,
    title: "Implement the change",
    description: "Do the work.",
    dependsOn: [],
    retries: 2,
    acceptance: ["The change is observable."],
    tests: ["npm test"],
    passes: false,
    completedAt: null,
    durationSecs: null,
    goalInvariantIds: ["G-A1"],
}

describe("story offer prompt assembly", () => {
    it("orders goal contract, decision baseline, amendments, then the story", () => {
        const prompt = buildStoryOfferPrompt(
            {
                goalEnvelope: {
                    objective: "Keep the boundary observable.",
                    acceptanceCriteria: ["The behavior stays observable."],
                    constraints: [],
                    nonGoals: [],
                    assumptions: [],
                },
                decisionDocument: "## ADR-001: Keep it\n**Status:** Accepted",
                runtimeGraph: {
                    runId: "run-1",
                    version: 2,
                    dynamicStories: 1,
                    policyStories: 0,
                    appliedDecisions: [
                        {
                            fingerprint: "fp-1",
                            origin: "worker",
                            applied: {
                                runId: "run-1",
                                proposalId: "proposal-1",
                                sourceStoryId: "S0",
                                leaseId: "lease-1",
                                generation: 1,
                                baseGraphVersion: 1,
                                previousGraphVersion: 1,
                                graphVersion: 2,
                                reason: "a discovered follow-up",
                                mutation: {
                                    addedStories: [],
                                    removedStoryIds: [],
                                    modifiedDeps: {},
                                },
                            },
                        },
                    ],
                },
            },
            STORY,
        )

        const order = [
            "## Global goal contract",
            "## Current shared design decision",
            "## Accepted runtime architecture and plan amendments",
            "Implement the change",
        ].map((marker) => prompt.indexOf(marker))
        assert.ok(order.every((index) => index >= 0), prompt.slice(0, 300))
        assert.deepEqual(order, [...order].sort((a, b) => a - b))
    })

    it("omits absent sections and keeps a bare story prompt working", () => {
        const prompt = buildStoryOfferPrompt(null, STORY)
        assert.doesNotMatch(prompt, /Global goal contract/)
        assert.doesNotMatch(prompt, /shared design decision/)
        assert.match(prompt, /Implement the change/)
    })

    it("renders dependency resumes and failure recoveries differently", () => {
        const resumed = buildRecoveryPromptSection({
            kind: "dependency",
            reason: "waited on S0",
        })
        assert.match(resumed, /Resumed after dependency integration/)
        assert.match(resumed, /cooperatively paused: waited on S0/)

        const retried = buildRecoveryPromptSection({
            kind: "execution",
            reason: "tests failed",
            branch: "baro-recovery/run/S1/1",
        })
        assert.match(retried, /Recovery attempt/)
        assert.match(retried, /execution attempt failed: tests failed/)
        assert.match(retried, /baro-recovery\/run\/S1\/1/)
        assert.match(retried, /Do not merge or cherry-pick the backup wholesale/)
    })
})
