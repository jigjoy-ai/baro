import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    VERDICT_SYSTEM_PROMPT,
    applyContractConflicts,
    parseContractConflicts,
    verdictSystemPrompt,
} from "../../src/acceptance/critic-verdict.js"
import { buildEvalPrompt, mergeSegmentVerdicts } from "../../src/acceptance/critic-evidence.js"

describe("Critic contract conflicts", () => {
    it("parses well-formed conflicts and drops malformed or repeated ones", () => {
        assert.deepEqual(parseContractConflicts(undefined), [])
        assert.deepEqual(parseContractConflicts("not a list"), [])
        assert.deepEqual(
            parseContractConflicts([
                { criterion: "A", reason: " outside the surface " },
                { criterion: "A", reason: "repeat" },
                { criterion: "", reason: "empty criterion" },
                { criterion: "B" },
                null,
                "C",
            ]),
            [{ criterion: "A", reason: "outside the surface" }],
        )
    })

    it("keeps only the story's own criteria and passes when conflicts were the only failures", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "fail" as const,
                reasoning: "r",
                violatedCriteria: ["B"],
                contractConflicts: [
                    { criterion: "B", reason: "outside" },
                    { criterion: "Z", reason: "invented" },
                ],
            },
            ["A", "B"],
        )
        assert.equal(evaluation.verdict, "pass")
        assert.deepEqual(evaluation.violatedCriteria, [])
        assert.deepEqual(evaluation.contractConflicts, [{ criterion: "B", reason: "outside" }])
    })

    it("still fails on a real violation, and a conflict never hides one", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "fail" as const,
                reasoning: "r",
                violatedCriteria: ["A", "B"],
                contractConflicts: [{ criterion: "B", reason: "outside" }],
            },
            ["A", "B"],
        )
        assert.equal(evaluation.verdict, "fail")
        assert.deepEqual(evaluation.violatedCriteria, ["A"])
    })

    it("drops the field entirely when no conflict names a criterion of the story", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "pass" as const,
                reasoning: "r",
                violatedCriteria: [],
                contractConflicts: [{ criterion: "Z", reason: "invented" }],
            },
            ["A"],
        )
        assert.equal("contractConflicts" in evaluation, false)
    })

    it("unions conflicts across segment verdicts", () => {
        const merged = mergeSegmentVerdicts([
            { verdict: "pass", reasoning: "1", violatedCriteria: [], contractConflicts: [{ criterion: "A", reason: "x" }] },
            { verdict: "pass", reasoning: "2", violatedCriteria: [], contractConflicts: [{ criterion: "B", reason: "y" }] },
        ])
        assert.deepEqual(merged.contractConflicts?.map(({ criterion }) => criterion), ["A", "B"])
    })

    it("asks story critics for conflicts, and only story critics", () => {
        assert.match(VERDICT_SYSTEM_PROMPT, /"contract_conflicts"/)
        assert.match(VERDICT_SYSTEM_PROMPT, /merely lacks evidence: those are violations/)
        assert.doesNotMatch(verdictSystemPrompt({ remediationGroups: true }), /contract_conflicts/)
    })

    it("shows the Critic the story's write surface when one is known", () => {
        const withSurface = buildEvalPrompt(
            ["README.md documents both modules"],
            "output",
            null,
            null,
            null,
            undefined,
            [],
            false,
            null,
            ["README.md"],
        )
        assert.match(withSurface, /## Write surface\n.*\n- README\.md/)
        assert.match(withSurface, /report it under contract_conflicts, never as a violation/)
        assert.doesNotMatch(buildEvalPrompt(["c"], "output"), /## Write surface/)
    })
})
