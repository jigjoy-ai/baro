import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    BARO_COAUTHOR_TRAILER,
    buildDefaultStoryPrompt,
    markStoryPassed,
    normalizePrd,
    type PrdFile,
    type PrdStory,
} from "../src/prd.js"

function story(overrides: Partial<PrdStory> = {}): PrdStory {
    return {
        id: "S1",
        priority: 1,
        title: "Test PRD helpers",
        description: "Add focused tests for PRD helper behavior.",
        dependsOn: [],
        retries: 2,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: undefined,
        ...overrides,
    }
}

describe("normalizePrd", () => {
    it("applies defaults and filters story string arrays", () => {
        const prd = normalizePrd(
            {
                userStories: [
                    {
                        id: "S1",
                        priority: 7,
                        title: "Story one",
                        description: "Has mixed array values.",
                        dependsOn: ["S0", 1, "S00"],
                        retries: 3.9,
                        acceptance: ["works", false, "ships"],
                        tests: ["npm test", null, "cargo test"],
                        passes: "yes",
                        completedAt: 42,
                        durationSecs: "fast",
                        model: 5,
                    },
                    {},
                ],
            } as unknown as Partial<PrdFile>,
            "prd.json",
        )

        assert.equal(prd.project, "")
        assert.equal(prd.branchName, "")
        assert.equal(prd.description, "")
        assert.deepEqual(prd.userStories[0], {
            id: "S1",
            priority: 7,
            title: "Story one",
            description: "Has mixed array values.",
            dependsOn: ["S0", "S00"],
            retries: 3,
            acceptance: ["works", "ships"],
            tests: ["npm test", "cargo test"],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: undefined,
        })
        assert.deepEqual(prd.userStories[1], {
            id: "S2",
            priority: 0,
            title: "",
            description: "",
            dependsOn: [],
            retries: 2,
            acceptance: [],
            tests: [],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: undefined,
        })
    })

    it("canonicalizes doubled baro/baro branch prefixes", () => {
        const prd = normalizePrd(
            {
                branchName: "baro/baro/baro/feature-prd-tests",
                userStories: [],
            },
            "prd.json",
        )

        assert.equal(prd.branchName, "baro/feature-prd-tests")
    })

    it("preserves decision and execution metadata", () => {
        const executionMode = {
            mode: "parallel" as const,
            reason: "independent stories",
            confidence: 0.9,
            maxStories: 4,
            parallelism: 2,
            source: "llm",
        }
        const prd = normalizePrd(
            {
                decisionDocument: "Use the existing PRD schema.",
                executionMode,
                userStories: [],
            },
            "prd.json",
        )

        assert.equal(prd.decisionDocument, "Use the existing PRD schema.")
        assert.deepEqual(prd.executionMode, executionMode)
    })
})

describe("markStoryPassed", () => {
    it("returns an immutable PRD update for the matching story", () => {
        const prd = normalizePrd(
            {
                project: "baro",
                branchName: "baro/prd-tests",
                description: "Test PRD helpers.",
                userStories: [
                    story({ id: "S1", title: "First" }),
                    story({ id: "S2", title: "Second" }),
                ],
            },
            "prd.json",
        )
        const before = Date.now()

        const updated = markStoryPassed(prd, "S2", 12.5)
        const after = Date.now()

        assert.notEqual(updated, prd)
        assert.notEqual(updated.userStories, prd.userStories)
        assert.deepEqual(updated.userStories[0], prd.userStories[0])
        assert.deepEqual(prd.userStories[1], story({ id: "S2", title: "Second" }))
        assert.equal(updated.userStories[1].passes, true)
        assert.equal(updated.userStories[1].durationSecs, 12.5)
        assert.equal(typeof updated.userStories[1].completedAt, "string")
        const completedAt = Date.parse(updated.userStories[1].completedAt!)
        assert.ok(completedAt >= before)
        assert.ok(completedAt <= after)
    })
})

describe("buildDefaultStoryPrompt", () => {
    it("includes acceptance criteria, test commands, and coauthor trailer", () => {
        const prompt = buildDefaultStoryPrompt(
            story({
                id: "S7",
                title: "Prompt coverage",
                description: "Verify the default prompt content.",
                acceptance: ["Normalize PRD defaults", "Keep metadata"],
                tests: ["npm test -- prd.test.ts", "npm run build"],
            }),
        )

        assert.ok(prompt.includes("You are working on story S7: Prompt coverage"))
        assert.ok(
            prompt.includes(
                "ACCEPTANCE CRITERIA:\n1. Normalize PRD defaults\n2. Keep metadata",
            ),
        )
        assert.ok(
            prompt.includes("TEST COMMANDS:\n- npm test -- prd.test.ts\n- npm run build"),
        )
        assert.ok(prompt.includes(BARO_COAUTHOR_TRAILER))
    })
})
