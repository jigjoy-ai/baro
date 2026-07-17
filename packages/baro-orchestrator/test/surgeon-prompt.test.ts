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
        {
            id: "S1",
            title: "broad story",
            description: "does a lot",
            acceptance: ["The shared capability is available."],
            tests: ["npm test -- shared-capability"],
            dependsOn: [],
            passes: false,
            model: "sonnet",
        },
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

describe("buildSurgeonPrompt — dependent-aware rewiring", () => {
    it("snapshots each direct dependent's semantic and capability context", () => {
        const dependentSnapshot: PrdSnapshot = {
            ...snap,
            stories: [
                ...snap.stories,
                {
                    id: "S2",
                    title: "HTTP cancellation consumer",
                    description: "Forwards cooperative cancellation to providers.",
                    acceptance: [
                        "An aborted request reaches the active provider signal.",
                    ],
                    tests: ["npm test -- provider-cancellation"],
                    dependsOn: ["S1", "S-existing"],
                    passes: false,
                    model: "heavy",
                },
                {
                    id: "S3",
                    title: "Event cancellation consumer",
                    description: "Publishes the terminal cancellation event.",
                    acceptance: ["Exactly one terminal cancellation event is emitted."],
                    tests: ["npm test -- cancellation-events"],
                    dependsOn: ["S1"],
                    passes: false,
                    model: "standard",
                },
                {
                    id: "S4",
                    title: "Indirect consumer",
                    description: "Depends on S2 rather than directly on S1.",
                    acceptance: ["Indirect work stays ordered."],
                    tests: ["npm test -- indirect"],
                    dependsOn: ["S2"],
                    passes: false,
                },
            ],
        }
        const prompt = buildSurgeonPrompt(
            dependentSnapshot,
            failure,
            (model) => model ? `codex:${model}` : null,
        )
        const section = prompt
            .split("# Direct dependents of S1\n", 2)[1]!
            .split("\n# Failure", 1)[0]!
        const snapshots = section
            .split("\n")
            .filter((line) => line.startsWith("  - {"))
            .map((line) => JSON.parse(line.slice(4)) as Record<string, unknown>)

        assert.deepEqual(snapshots, [
            {
                id: "S2",
                title: "HTTP cancellation consumer",
                description: "Forwards cooperative cancellation to providers.",
                dependsOn: ["S1", "S-existing"],
                acceptance: [
                    "An aborted request reaches the active provider signal.",
                ],
                tests: ["npm test -- provider-cancellation"],
                modelTier: "heavy",
                actualModel: "codex:heavy",
            },
            {
                id: "S3",
                title: "Event cancellation consumer",
                description: "Publishes the terminal cancellation event.",
                dependsOn: ["S1"],
                acceptance: ["Exactly one terminal cancellation event is emitted."],
                tests: ["npm test -- cancellation-events"],
                modelTier: "standard",
                actualModel: "codex:standard",
            },
        ])
        assert.match(section, /every story below.*separate rewire obligation/is)
        assert.match(section, /terminal replacement\(s\).*concrete acceptance/is)
        assert.match(section, /do not default all of them to the first added story/is)
        assert.match(prompt, /Acceptance: \["The shared capability is available\."\]/)
        assert.match(
            prompt,
            /Verification commands: \["npm test -- shared-capability"\]/,
        )
    })

    it("requires per-dependent terminal replacement mappings", () => {
        assert.match(
            SURGEON_SYSTEM_PROMPT,
            /EVERY direct dependent that remains in the graph must[\s\S]*its own "modifiedDeps" entry/,
        )
        assert.match(
            SURGEON_SYSTEM_PROMPT,
            /terminal added replacement story or stories[\s\S]*concrete behavior that dependent consumes/,
        )
        assert.match(
            SURGEON_SYSTEM_PROMPT,
            /Do not blindly point all dependents at the first item in[\s\S]*"added"/,
        )
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
