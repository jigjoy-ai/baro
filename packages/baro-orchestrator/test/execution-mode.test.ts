import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    heuristicModeContract,
    parseModeContract,
    PLANNER_SYSTEM_PROMPT,
    renderModeContract,
} from "../src/planning/planner-prompts.js"
import { enforceModeContract, resolveEffectiveParallel } from "../src/planning/mode-enforcement.js"
import type { PrdExecutionMode, PrdFile } from "../src/prd.js"

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
