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
                { criterion: "A", kind: "outside_write_surface", reason: " outside the surface " },
                { criterion: "A", kind: "contradiction", reason: "repeat" },
                { criterion: "", kind: "contradiction", reason: "empty criterion" },
                { criterion: "B", kind: "contradiction" },
                { criterion: "D", reason: "no kind: stays an ordinary violation" },
                { criterion: "E", kind: "too hard", reason: "unknown kind" },
                { criterion: "F", kind: "contradiction", reason: "contradicts A" },
                null,
                "C",
            ]),
            [
                { criterion: "A", reason: "outside the surface", kind: "outside_write_surface" },
                { criterion: "F", reason: "contradicts A", kind: "contradiction" },
            ],
        )
    })

    it("keeps only the story's own criteria and passes when conflicts were the only failures", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "fail" as const,
                reasoning: "r",
                violatedCriteria: ["B"],
                contractConflicts: [
                    { criterion: "B", reason: "outside", kind: "outside_write_surface" as const },
                    { criterion: "Z", reason: "invented", kind: "contradiction" as const },
                ],
            },
            ["A", "B"],
        )
        assert.equal(evaluation.verdict, "pass")
        assert.deepEqual(evaluation.violatedCriteria, [])
        assert.deepEqual(evaluation.contractConflicts, [{ criterion: "B", reason: "outside", kind: "outside_write_surface" }])
    })

    it("still fails on a real violation, and a conflict never hides one", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "fail" as const,
                reasoning: "r",
                violatedCriteria: ["A", "B"],
                contractConflicts: [{ criterion: "B", reason: "outside", kind: "outside_write_surface" as const }],
            },
            ["A", "B"],
        )
        assert.equal(evaluation.verdict, "fail")
        assert.deepEqual(evaluation.violatedCriteria, ["A"])
    })

    it("ignores every conflict when the feature is switched off", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "fail" as const,
                reasoning: "r",
                violatedCriteria: ["B"],
                contractConflicts: [{ criterion: "B", reason: "outside", kind: "outside_write_surface" as const }],
            },
            ["A", "B"],
            false,
        )
        assert.equal(evaluation.verdict, "fail")
        assert.deepEqual(evaluation.violatedCriteria, ["B"])
        assert.equal("contractConflicts" in evaluation, false)
    })

    it("drops the field entirely when no conflict names a criterion of the story", () => {
        const evaluation = applyContractConflicts(
            {
                verdict: "pass" as const,
                reasoning: "r",
                violatedCriteria: [],
                contractConflicts: [{ criterion: "Z", reason: "invented", kind: "contradiction" as const }],
            },
            ["A"],
        )
        assert.equal("contractConflicts" in evaluation, false)
    })

    it("unions conflicts across segment verdicts", () => {
        const merged = mergeSegmentVerdicts([
            { verdict: "pass", reasoning: "1", violatedCriteria: [], contractConflicts: [{ criterion: "A", reason: "x", kind: "contradiction" }] },
            { verdict: "pass", reasoning: "2", violatedCriteria: [], contractConflicts: [{ criterion: "B", reason: "y", kind: "outside_write_surface" }] },
        ])
        assert.deepEqual(merged.contractConflicts?.map(({ criterion }) => criterion), ["A", "B"])
    })

    it("asks story critics for conflicts, and only story critics", () => {
        assert.match(VERDICT_SYSTEM_PROMPT, /"contract_conflicts"/)
        assert.match(VERDICT_SYSTEM_PROMPT, /merely lacks evidence: those are violations/)
        assert.match(VERDICT_SYSTEM_PROMPT, /"outside_write_surface" or "contradiction"/)
        assert.doesNotMatch(verdictSystemPrompt({ remediationGroups: true }), /contract_conflicts/)
    })

    it("judges failures that already fail at the base commit as pre-existing, and test weakening as a violation", () => {
        // Story sandboxes deny `ps`; a run once turned five such tests green by returning early.
        for (const prompt of [VERDICT_SYSTEM_PROMPT, buildEvalPrompt(["cargo test passes"], "done")]) {
            assert.match(prompt, /failing the same way at the story's base commit[^.]*is pre-existing/)
            assert.match(prompt, /never the agent's word/)
            assert.match(prompt, /Skipping, ignoring, early-returning from[^.]*is a violation/)
        }
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
