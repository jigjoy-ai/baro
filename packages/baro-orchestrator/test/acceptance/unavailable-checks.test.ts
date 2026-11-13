import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import {
    VERDICT_SYSTEM_PROMPT,
    parsedConflictFields,
    parseUnavailableChecks,
} from "../../src/acceptance/critic-verdict.js"
import { applyUnavailableChecks, mergeSegmentVerdicts } from "../../src/acceptance/critic-evidence.js"

const UNAVAILABLE = [{ criterion: "typecheck passes", reason: "npm run typecheck could not start" }]

describe("criteria whose check could not start", () => {
    it("parses the kind apart from contract conflicts and drops malformed entries", () => {
        const reported = [
            { criterion: "A", kind: "check_unavailable", reason: " tsc is not installed " },
            { criterion: "A", kind: "check_unavailable", reason: "repeat" },
            { criterion: "B", kind: "outside_write_surface", reason: "another file" },
            { criterion: "C", kind: "check_unavailable", reason: "" },
            { kind: "check_unavailable", reason: "no criterion" },
        ]
        assert.deepEqual(parseUnavailableChecks(reported), [{ criterion: "A", reason: "tsc is not installed" }])
        assert.deepEqual(parseUnavailableChecks("not a list"), [])
        assert.deepEqual(parsedConflictFields(reported), {
            contractConflicts: [{ criterion: "B", kind: "outside_write_surface", reason: "another file" }],
            unavailableChecks: [{ criterion: "A", reason: "tsc is not installed" }],
        })
        assert.deepEqual(parsedConflictFields(undefined), {})
    })

    it("is inconclusive, not a pass and not a failure, when nothing else is against the work", () => {
        for (const verdict of ["pass", "fail"] as const) {
            const evaluation = applyUnavailableChecks(
                {
                    status: "evaluated" as const,
                    verdict,
                    reasoning: "the diff matches",
                    violatedCriteria: [] as string[],
                    unavailableChecks: UNAVAILABLE,
                },
                ["typecheck passes", "no new casts"],
                ["npm run typecheck"],
            )
            assert.equal(evaluation.status, "inconclusive")
            assert.equal(evaluation.verdict, "fail")
            assert.deepEqual(evaluation.violatedCriteria, ["[acceptance evidence unavailable]"])
            assert.match(evaluation.reasoning, /1 criterion needs a command that could not start .*npm run typecheck/)
            assert.equal("unavailableChecks" in evaluation, false)
        }
    })

    it("keeps a real violation a failure and takes the unverifiable criterion out of it", () => {
        const evaluation = applyUnavailableChecks(
            {
                status: "evaluated" as const,
                verdict: "fail" as const,
                reasoning: "a cast was added",
                violatedCriteria: ["no new casts", "typecheck passes"],
                unavailableChecks: UNAVAILABLE,
            },
            ["typecheck passes", "no new casts"],
            ["npm run typecheck"],
        )
        assert.equal(evaluation.status, "evaluated")
        assert.equal(evaluation.verdict, "fail")
        assert.deepEqual(evaluation.violatedCriteria, ["no new casts"])
    })

    it("treats the report as a violation when Baro marked no command as unable to start", () => {
        const evaluation = applyUnavailableChecks(
            {
                status: "evaluated" as const,
                verdict: "pass" as const,
                reasoning: "looks fine",
                violatedCriteria: [] as string[],
                unavailableChecks: UNAVAILABLE,
            },
            ["typecheck passes"],
            [],
        )
        assert.equal(evaluation.status, "evaluated")
        assert.equal(evaluation.verdict, "fail")
        assert.deepEqual(evaluation.violatedCriteria, ["typecheck passes"])
    })

    it("ignores a report about a criterion that is not the story's, and leaves an inconclusive verdict alone", () => {
        const foreign = applyUnavailableChecks(
            {
                status: "evaluated" as const,
                verdict: "pass" as const,
                reasoning: "ok",
                violatedCriteria: [] as string[],
                unavailableChecks: [{ criterion: "invented", reason: "x" }],
            },
            ["typecheck passes"],
            ["npm run typecheck"],
        )
        assert.equal(foreign.verdict, "pass")
        assert.equal("unavailableChecks" in foreign, false)

        const inconclusive = applyUnavailableChecks(
            {
                status: "inconclusive" as const,
                verdict: "fail" as const,
                reasoning: "evaluator failed",
                violatedCriteria: ["[critic call failed]"],
                unavailableChecks: UNAVAILABLE,
            },
            ["typecheck passes"],
            ["npm run typecheck"],
        )
        assert.deepEqual(inconclusive.violatedCriteria, ["[critic call failed]"])
        assert.equal(inconclusive.reasoning, "evaluator failed")
    })

    it("carries the reports across the segments of one contract", () => {
        const merged = mergeSegmentVerdicts([
            { verdict: "pass" as const, reasoning: "1", violatedCriteria: [], unavailableChecks: UNAVAILABLE },
            {
                verdict: "pass" as const,
                reasoning: "2",
                violatedCriteria: [],
                unavailableChecks: [{ criterion: "build passes", reason: "npm run build could not start" }],
            },
        ])
        assert.deepEqual(
            merged.unavailableChecks?.map(({ criterion }) => criterion),
            ["typecheck passes", "build passes"],
        )
    })

    it("tells the judge what a command that could not start means", () => {
        assert.match(VERDICT_SYSTEM_PROMPT, /"check_unavailable"/)
        assert.match(VERDICT_SYSTEM_PROMPT, /"could not start" did not run/)
        assert.match(VERDICT_SYSTEM_PROMPT, /Never use it for a command that ran and failed/)
    })
})
