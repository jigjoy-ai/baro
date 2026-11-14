import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import {
    buildIntakePrompt,
    PLANNER_SYSTEM_PROMPT,
    plannerSystemPrompt,
    renderModeContract,
} from "../../../src/planning/domain/planner-prompts.js"
import { widestDagLevel } from "../../../src/planning/domain/mode-enforcement.js"

describe("the planner is told to fan out, not to chain", () => {
    // A measured run split internal/order into four stories. S2, S3 and S4 each
    // said "reuse the fakes from S1", each created its own new files, and each
    // declared it would add no package-level names — yet the planner made them
    // S1→S2→S3→S4. Serially that cost ~900s of work that would have taken ~350s
    // as siblings. The old rules conflicted: disjoint files said parallel, the
    // same "component" said sequential, and the planner resolved it by chaining.
    const prompt = PLANNER_SYSTEM_PROMPT

    it("makes the file, not the package, the unit of conflict", () => {
        assert.match(prompt, /unit of conflict is the FILE, not the package/u)
        assert.match(prompt, /run in parallel even inside one package/u)
    })

    it("names the chain-instead-of-fan-out mistake outright", () => {
        assert.match(prompt, /SIBLINGS, NOT A CHAIN/u)
        assert.match(prompt, /A→B, A→C, A→D is right/u)
        assert.match(prompt, /A→B→C→D is wrong/u)
    })

    it("keeps the unsafe-parallel-edit warning it is balanced against", () => {
        assert.match(prompt, /editing the same file.*must\s+be sequential/su)
        assert.match(prompt, /unsafe parallel edits are worse/u)
    })

    it("the shape it now asks for is measurably wider", () => {
        const chained = [
            { id: "S1", dependsOn: [] },
            { id: "S2", dependsOn: ["S1"] },
            { id: "S3", dependsOn: ["S2"] },
            { id: "S4", dependsOn: ["S3"] },
        ]
        const siblings = [
            { id: "S1", dependsOn: [] },
            { id: "S2", dependsOn: ["S1"] },
            { id: "S3", dependsOn: ["S1"] },
            { id: "S4", dependsOn: ["S1"] },
        ]
        assert.equal(widestDagLevel(chained as never), 1)
        assert.equal(widestDagLevel(siblings as never), 3)
    })
})

describe("under shared writes the planner is told the edit, not the file, conflicts", () => {
    const prompt = plannerSystemPrompt(true)

    it("makes the overlapping edit the unit of conflict and lets stories share a file", () => {
        assert.match(prompt, /unit of conflict is the overlapping EDIT or CONTRACT, not the file/u)
        assert.match(prompt, /Stories MAY share a file when they edit\s+different parts of it/u)
        assert.match(prompt, /a real conflict sends the story\s+that integrates second back/u)
        assert.doesNotMatch(prompt, /unit of conflict is the FILE/u)
        assert.doesNotMatch(prompt, /Stories editing the same file/u)
    })

    it("keeps the sequential rule for the same function or contract", () => {
        assert.match(prompt, /changing the same function or lines.*must be sequential/su)
        assert.match(prompt, /unsafe parallel edits are worse/u)
        assert.match(prompt, /SIBLINGS, NOT A CHAIN/u)
    })

    it("says a shared file alone is not an edge, and how to name a real one", () => {
        assert.match(prompt, /A file\s+both stories write does not count/u)
        assert.match(prompt, /modifies a file S2 creates, leave that file out/u)
    })

    it("carries the same rule into the mode contract and the intake", () => {
        const sequential = renderModeContract(
            { mode: "sequential", confidence: 0.5, reason: "r", maxStories: 3 },
            true,
        )
        assert.match(sequential, /siblings may share a file when they edit different parts of it/u)
        assert.doesNotMatch(sequential, /pairwise-disjoint/u)
        const parallel = renderModeContract(
            { mode: "parallel", confidence: 0.5, reason: "r", maxStories: 3 },
            true,
        )
        assert.doesNotMatch(parallel, /Shared files\/components must be sequential/u)
        assert.match(parallel, /The same function\/component\/contract must be sequential/u)
        const intake = buildIntakePrompt({ goal: "g", sharedWrites: true })
        assert.match(intake, /Editing different parts of one file is not a conflict/u)
        assert.doesNotMatch(intake, /edit the same file\/component/u)
    })

    it("is what the exported prompt says only when the flag is set", () => {
        assert.equal(PLANNER_SYSTEM_PROMPT, plannerSystemPrompt(false))
        assert.notEqual(plannerSystemPrompt(true), plannerSystemPrompt(false))
    })
})
