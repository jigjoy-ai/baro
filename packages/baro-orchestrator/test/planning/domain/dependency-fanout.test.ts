import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { PLANNER_SYSTEM_PROMPT } from "../../../src/planning/domain/planner-prompts.js"
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
