import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    extractJsonObjects,
    heuristicModeContract,
    parseModeContract,
    parseRequiredModeContract,
    PLANNER_SYSTEM_PROMPT,
    renderModeContract,
} from "../src/planning/planner-prompts.js"
import { buildArchitectUserMessage } from "../src/planning/architect-prompts.js"
import { enforceModeContract, resolveEffectiveParallel, widestDagLevel } from "../src/planning/mode-enforcement.js"
import { isVerificationOnlyStory } from "../src/planning/verification-stories.js"
import type { PrdExecutionMode, PrdFile, PrdStory } from "../src/prd.js"

const mode = (m: Partial<PrdExecutionMode> & { mode: PrdExecutionMode["mode"] }): PrdExecutionMode => ({ reason: "r", ...m })

describe("parseModeContract", () => {
    it("clamps confidence and floors caps", () => {
        const c = parseModeContract(`{"mode":"parallel","confidence":7,"reason":"r","maxStories":0.4,"parallelism":2.9}`)
        assert.equal(c.mode, "parallel")
        assert.equal(c.confidence, 1)
        assert.equal(c.maxStories, 1)
        assert.equal(c.parallelism, 2)
    })

    it("defaults unknown mode to focused and passes source through", () => {
        const c = parseModeContract(`{"mode":"yolo","confidence":0.5,"reason":"r","source":"user"}`)
        assert.equal(c.mode, "focused")
        assert.equal(c.source, "user")
    })

    it("skips prose braces and preserves braces inside JSON strings", () => {
        const c = parseModeContract(
            'Use `{ signal }` when implementing this.\n```json\n' +
            '{"mode":"parallel","confidence":0.8,"reason":"providers use { exact } signals"}\n```',
        )
        assert.equal(c.mode, "parallel")
        assert.equal(c.reason, "providers use { exact } signals")
    })

    it("requires an explicit valid mode at the persisted contract boundary", () => {
        assert.throws(() => parseRequiredModeContract("{}"), /must contain mode/)
        assert.throws(
            () => parseRequiredModeContract('{"mode":"yolo"}'),
            /must contain mode/,
        )
        assert.equal(
            parseRequiredModeContract('{"mode":"parallel","reason":"user pick"}').mode,
            "parallel",
        )
    })

    it("returns separate provider JSON objects in response order", () => {
        assert.deepEqual(
            extractJsonObjects('args: {"path":"src/x.ts"}\nfinal: {"project":"p"}'),
            ['{"path":"src/x.ts"}', '{"project":"p"}'],
        )
    })

    it("finds valid JSON nested after an earlier invalid prose brace", () => {
        assert.deepEqual(
            extractJsonObjects('prefix { invalid {"project":"p"} } suffix'),
            ['{"project":"p"}'],
        )
    })
})

describe("architect execution contract", () => {
    it("puts an explicit parallel choice in the Architect prompt", () => {
        const prompt = buildArchitectUserMessage("change providers", undefined, {
            mode: "parallel",
            confidence: 1,
            reason: "operator selected parallel",
            source: "user",
        })
        assert.match(prompt, /mode: parallel/)
        assert.match(prompt, /multiple agents on independent DAG siblings/)
        assert.match(prompt, /do not reclassify/i)
    })
})

describe("planner prompt tiers", () => {
    it("tiers stories with the neutral names, not Claude model names", () => {
        assert.match(PLANNER_SYSTEM_PROMPT, /"light" \| "standard" \| "heavy"/)
        assert.match(PLANNER_SYSTEM_PROMPT, /"model": "heavy"/)
        assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /"haiku"|"sonnet"|"opus"/)
    })

    it("focused-mode contract escalates via the neutral heavy tier", () => {
        const text = renderModeContract({ mode: "focused", confidence: 1, reason: "r" })
        assert.match(text, /"heavy"/)
        assert.doesNotMatch(text, /"opus"/)
    })

    it("assigns deterministic final gates to RunVerifier", () => {
        assert.match(PLANNER_SYSTEM_PROMPT, /do NOT create a final verification-only story/)
        assert.match(PLANNER_SYSTEM_PROMPT, /RunVerifier/)
    })
})

describe("heuristicModeContract", () => {
    it("quick always wins", () => {
        const c = heuristicModeContract({ goal: "refactor the whole backend", quick: true })
        assert.equal(c.mode, "focused")
        assert.equal(c.confidence, 1)
    })

    it("bug-shaped goals go focused", () => {
        const c = heuristicModeContract({ goal: "fix the crash when opening settings" })
        assert.equal(c.mode, "focused")
        assert.equal(c.maxStories, 1)
    })
})

function prd(stories: Array<Partial<PrdFile["userStories"][0]> & { id: string }>): string {
    return JSON.stringify({
        project: "p",
        branchName: "baro/x",
        description: "d",
        userStories: stories.map((s, i) => ({
            priority: i + 1,
            title: s.id,
            description: "",
            dependsOn: [],
            retries: 2,
            acceptance: [],
            tests: [],
            ...s,
        })),
    })
}

describe("enforceModeContract", () => {
    it("removes the recorded S11 verification shape and rewires its dependent", () => {
        const out = JSON.parse(enforceModeContract(
            prd([
                { id: "S1", title: "Implement cancellation", description: "Add cancellation propagation." },
                {
                    id: "S11",
                    title: "Run npm test, typecheck, build, and lint; fix failures",
                    description: "Run the existing final gates against merged code. Fix any test, typecheck, build, or lint failures caused by cross-story integration issues. Do not introduce new features — only incidental fixes.",
                    dependsOn: ["S1"],
                    acceptance: ["npm test exits 0", "npm run build exits 0"],
                },
                {
                    id: "S12",
                    title: "Publish cancellation metadata",
                    description: "Implement the metadata adapter.",
                    dependsOn: ["S11"],
                },
            ]),
            { mode: "sequential", confidence: 1, reason: "ordered" },
            "add cancellation",
        )) as PrdFile

        assert.deepEqual(out.userStories.map((story) => story.id), ["S1", "S12"])
        assert.deepEqual(out.userStories[1]!.dependsOn, ["S1"])
    })

    it("removes recorded build/lint variants but preserves uncovered config audits", () => {
        const out = JSON.parse(enforceModeContract(
            prd([
                { id: "S1", title: "Implement feature", description: "Implement product code." },
                {
                    id: "S11b1",
                    title: "Run npm run build (tsup), fix build failures",
                    description: "Run npm run build. Fix any build failures. Do not introduce new features — only incidental fixes.",
                    dependsOn: ["S1"],
                },
                {
                    id: "S11b2",
                    title: "Run npm run lint, fix new lint errors",
                    description: "Run npm run lint. Fix any lint errors. Do not introduce new features — only incidental fixes.",
                    dependsOn: ["S11b1"],
                },
                {
                    id: "S11c",
                    title: "Audit for no new deps, no unexpected export or config changes",
                    description: "Verify that no new dependencies were added and configuration is unchanged. Report deviations and revert any incidental deviations.",
                    dependsOn: ["S11b2"],
                },
                {
                    id: "S12",
                    title: "Implement follow-up",
                    description: "Create the actual adapter.",
                    dependsOn: ["S11c"],
                },
            ]),
            { mode: "sequential", confidence: 1, reason: "ordered" },
            "feature",
        )) as PrdFile

        assert.deepEqual(out.userStories.map((story) => story.id), ["S1", "S11c", "S12"])
        assert.deepEqual(out.userStories[1]!.dependsOn, ["S1"])
        assert.deepEqual(out.userStories[2]!.dependsOn, ["S11c"])
    })

    it("preserves stories that implement tests or substantive fixes", () => {
        const testStory = {
            title: "Verify cancellation behavior by adding unit tests",
            description: "Implement new race and abort test cases.",
        }
        const fixStory = {
            title: "Run cancellation tests and fix the abort protocol",
            description: "Change signal propagation so nested calls cancel.",
        }
        assert.equal(isVerificationOnlyStory(testStory), false)
        assert.equal(isVerificationOnlyStory(fixStory), false)
    })

    it("refuses a plan made entirely of final-gate stories", () => {
        assert.throws(
            () => enforceModeContract(
                prd([{
                    id: "S11",
                    title: "Run npm test and npm run typecheck",
                    description: "Run the existing test and typecheck commands and report results.",
                }]),
                { mode: "focused", confidence: 1, reason: "single" },
                "verify",
            ),
            /only deterministic verification stories/,
        )
    })

    it("collapses a multi-story PRD to ONE story in focused mode", () => {
        const out = JSON.parse(enforceModeContract(
            prd([
                { id: "S1", title: "step one", acceptance: ["a1"] },
                { id: "S2", title: "step two", acceptance: ["a2"], dependsOn: ["S1"] },
                { id: "S3", title: "step three", acceptance: ["a1"] },
            ]),
            { mode: "focused", confidence: 0.9, reason: "bugfix", maxStories: 1, parallelism: 1, source: "llm" },
            "fix the thing",
        )) as PrdFile
        assert.equal(out.userStories.length, 1)
        const s = out.userStories[0]!
        assert.equal(s.id, "S1")
        assert.deepEqual(s.dependsOn, [])
        assert.deepEqual([...s.acceptance].sort(), ["a1", "a2"])
        assert.equal(s.model, "heavy")
        assert.match(s.description, /step two/)
        assert.equal(out.executionMode?.mode, "focused")
        assert.equal(out.executionMode?.source, "llm")
    })

    it("trims to maxStories keeping dependency-closed prefix", () => {
        const out = JSON.parse(enforceModeContract(
            prd([
                { id: "S1" },
                { id: "S2", dependsOn: ["S1"] },
                { id: "S3", dependsOn: ["S2"] },
                { id: "S4", dependsOn: ["S3"] },
            ]),
            { mode: "sequential", confidence: 0.8, reason: "chain", maxStories: 2, parallelism: 1 },
            "goal",
        )) as PrdFile
        assert.deepEqual(out.userStories.map((s) => s.id), ["S1", "S2"])
        assert.equal(out.executionMode?.mode, "sequential")
    })

    it("leaves a compliant PRD alone apart from the stamp", () => {
        const out = JSON.parse(enforceModeContract(
            prd([{ id: "S1", model: "sonnet" }]),
            { mode: "focused", confidence: 1, reason: "single", maxStories: 1, parallelism: 1 },
            "goal",
        )) as PrdFile
        assert.equal(out.userStories.length, 1)
        assert.equal(out.userStories[0]!.model, "sonnet")
        assert.equal(out.executionMode?.mode, "focused")
    })

    it("returns invalid JSON untouched", () => {
        const raw = "not json at all"
        assert.equal(
            enforceModeContract(raw, { mode: "focused", confidence: 1, reason: "r" }, "g"),
            raw,
        )
    })

    it("refuses a one-story fallback stamped as parallel", () => {
        assert.throws(
            () => enforceModeContract(
                prd([{ id: "S1", model: "heavy" }]),
                { mode: "parallel", confidence: 1, reason: "user selected parallel", source: "user" },
                "cross-cutting goal",
            ),
            /Refusing single-worker fallback/,
        )
    })

    it("refuses a fully serial DAG stamped as parallel", () => {
        assert.throws(
            () => enforceModeContract(
                prd([
                    { id: "S1" },
                    { id: "S2", dependsOn: ["S1"] },
                    { id: "S3", dependsOn: ["S2"] },
                ]),
                { mode: "parallel", confidence: 0.9, reason: "parallel" },
                "goal",
            ),
            /maximum width 1/,
        )
    })

    it("accepts a parallel DAG with an independently executable level", () => {
        const out = JSON.parse(enforceModeContract(
            prd([
                { id: "S1" },
                { id: "S2" },
                { id: "S3", dependsOn: ["S1", "S2"] },
            ]),
            { mode: "parallel", confidence: 1, reason: "independent providers", source: "user" },
            "goal",
        )) as PrdFile
        assert.equal(out.userStories.length, 3)
        assert.equal(out.executionMode?.mode, "parallel")
    })
})

describe("widestDagLevel", () => {
    it("calculates independent width and rejects cycles/unknown dependencies", () => {
        assert.equal(widestDagLevel([
            { id: "S1", dependsOn: [] } as PrdStory,
            { id: "S2", dependsOn: [] } as PrdStory,
            { id: "S3", dependsOn: ["S1", "S2"] } as PrdStory,
        ]), 2)
        assert.throws(
            () => widestDagLevel([{ id: "S1", dependsOn: ["missing"] } as PrdStory]),
            /unknown story/,
        )
        assert.throws(
            () => widestDagLevel([
                { id: "S1", dependsOn: ["S2"] } as PrdStory,
                { id: "S2", dependsOn: ["S1"] } as PrdStory,
            ]),
            /cycle/,
        )
    })
})

describe("resolveEffectiveParallel", () => {
    it("AUTO sequential (intake guess) defers to the DAG — does NOT serialize", () => {
        // The vizion regression: a parallel DAG was force-serialized by an auto
        // "sequential" guess. Auto (llm/heuristic) must keep the operator cap.
        assert.equal(resolveEffectiveParallel(mode({ mode: "sequential", source: "llm" }), 10), 10)
        assert.equal(resolveEffectiveParallel(mode({ mode: "sequential", source: "heuristic" }), 10), 10)
        assert.equal(resolveEffectiveParallel(mode({ mode: "sequential" }), 10), 10)
    })

    it("USER-picked sequential serializes (deliberate caution the DAG can't see)", () => {
        assert.equal(resolveEffectiveParallel(mode({ mode: "sequential", source: "user" }), 10), 1)
    })

    it("focused always serializes, regardless of source", () => {
        assert.equal(resolveEffectiveParallel(mode({ mode: "focused", source: "user" }), 10), 1)
        assert.equal(resolveEffectiveParallel(mode({ mode: "focused", source: "llm" }), 10), 1)
    })

    it("parallel and no-mode follow the operator cap (0 = unlimited)", () => {
        assert.equal(resolveEffectiveParallel(mode({ mode: "parallel" }), 10), 10)
        assert.equal(resolveEffectiveParallel(undefined, 10), 10)
        assert.equal(resolveEffectiveParallel(undefined, 0), 0)
        assert.equal(resolveEffectiveParallel(mode({ mode: "sequential", source: "llm" }), undefined), 0)
    })
})
