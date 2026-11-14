import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import {
    buildRecoveryPromptSection,
    buildStoryOfferPrompt,
    readRunGoalText,
} from "../../../src/planning/domain/story-offer-prompt.js"
import type { PrdStory } from "../../../src/prd.js"

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

    it("places the full goal text after the goal contract and before the decision baseline", () => {
        const prd = {
            goalEnvelope: {
                objective: "Keep the boundary observable.",
                acceptanceCriteria: ["The behavior stays observable."],
                constraints: [],
                nonGoals: [],
                assumptions: [],
            },
            decisionDocument: "## ADR-001: Keep it\n**Status:** Accepted",
        }
        const fullGoal = `${"long goal paragraph. ".repeat(600)}THE TAIL MARKER`
        const prompt = buildStoryOfferPrompt(prd, STORY, `\n\n${fullGoal}\n\n`)

        const order = [
            "## Global goal contract",
            "## Full goal text",
            "## Current shared design decision",
            "Implement the change",
        ].map((marker) => prompt.indexOf(marker))
        assert.ok(order.every((index) => index >= 0), prompt.slice(0, 300))
        assert.deepEqual(order, [...order].sort((a, b) => a - b))
        assert.ok(prompt.includes(
            "## Full goal text\n\n" +
                "The intake saw only the head of this goal; this is the complete text the user supplied.\n\n" +
                `${fullGoal.trim()}\n\n---\n\n`,
        ))
    })

    it("keeps the prompt byte-for-byte unchanged without a non-empty full goal", () => {
        const prd = {
            goalEnvelope: {
                objective: "Keep the boundary observable.",
                acceptanceCriteria: ["The behavior stays observable."],
                constraints: [],
                nonGoals: [],
                assumptions: [],
            },
            decisionDocument: "## ADR-001: Keep it\n**Status:** Accepted",
        }
        const baseline = buildStoryOfferPrompt(prd, STORY)
        assert.equal(buildStoryOfferPrompt(prd, STORY, null), baseline)
        assert.equal(buildStoryOfferPrompt(prd, STORY, " \n\t "), baseline)
        assert.doesNotMatch(baseline, /Full goal text/)
    })
})

describe("run goal text beside prd.json", () => {
    function withRunDir(body: (dir: string) => void): void {
        const dir = mkdtempSync(join(tmpdir(), "baro-run-goal-"))
        try {
            body(dir)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    it("returns null when goal.md is missing", () => {
        withRunDir((dir) => {
            assert.equal(readRunGoalText(join(dir, "prd.json")), null)
        })
    })

    it("returns null when goal.md holds only whitespace", () => {
        withRunDir((dir) => {
            writeFileSync(join(dir, "goal.md"), "  \n\t\n")
            assert.equal(readRunGoalText(join(dir, "prd.json")), null)
        })
    })

    it("returns the file text when goal.md is present", () => {
        withRunDir((dir) => {
            const text = `${"x".repeat(12_000)}\n`
            writeFileSync(join(dir, "goal.md"), text)
            assert.equal(readRunGoalText(join(dir, "prd.json")), text)
        })
    })

    it("rethrows read errors other than a missing file", () => {
        withRunDir((dir) => {
            mkdirSync(join(dir, "goal.md"))
            assert.throws(
                () => readRunGoalText(join(dir, "prd.json")),
                (error: unknown) =>
                    error instanceof Error && "code" in error && error.code === "EISDIR",
            )
        })
    })
})
