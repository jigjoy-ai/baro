import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildEvalPrompt } from "../../src/acceptance/critic-evidence.js"
import { CriterionLedger, honorEstablished } from "../../src/acceptance/criterion-ledger.js"

const criteria = ["A builds", "B keeps the tests", "C has three commits"]
const fail = (violatedCriteria: string[]) => ({
    status: "evaluated" as const,
    verdict: "fail" as const,
    reasoning: "r",
    violatedCriteria,
})

describe("criteria a review already found satisfied", () => {
    // A finished story was rejected seven times, each review failing a
    // different set: the proof for earlier criteria had scrolled out of the
    // Critic's bounded command window while the agent proved later ones.
    it("stay satisfied for the same content, so reviews converge instead of rotating", () => {
        const ledger = new CriterionLedger()
        ledger.record("S3", "fp1", criteria, fail(["C has three commits"]))
        assert.deepEqual(ledger.established("S3", "fp1"), ["A builds", "B keeps the tests"])

        // The next review of the same bytes fails A and B (their proof scrolled
        // out) plus C: only C survives.
        const next = honorEstablished(
            fail(["A builds", "B keeps the tests", "C has three commits"]),
            ledger.established("S3", "fp1"),
        )
        assert.equal(next.verdict, "fail")
        assert.deepEqual(next.violatedCriteria, ["C has three commits"])
        assert.match(next.reasoning, /already found satisfied/)

        // Proving C at the same content completes the story.
        ledger.record("S3", "fp1", criteria, honorEstablished(fail(["A builds"]), ledger.established("S3", "fp1")))
        const done = honorEstablished(fail(["B keeps the tests"]), ledger.established("S3", "fp1"))
        assert.equal(done.verdict, "pass")
        assert.deepEqual(done.violatedCriteria, [])
    })

    it("are judged again once the content changes", () => {
        const ledger = new CriterionLedger()
        ledger.record("S1", "fp1", criteria, { status: "evaluated", verdict: "pass", reasoning: "", violatedCriteria: [] })
        assert.deepEqual(ledger.established("S1", "fp2"), [])
        assert.deepEqual(ledger.established("S1", null), [])
        ledger.record("S1", "fp2", criteria, fail(["A builds"]))
        assert.deepEqual(ledger.established("S1", "fp2"), ["B keeps the tests", "C has three commits"])
        assert.deepEqual(ledger.established("S2", "fp2"), [], "per story")
    })

    it("learns nothing from an inconclusive review, a fail naming nothing, or a contract conflict", () => {
        const ledger = new CriterionLedger()
        ledger.record("S1", "fp", criteria, { ...fail(["A builds"]), status: "inconclusive" })
        ledger.record("S1", "fp", criteria, fail([]))
        assert.deepEqual(ledger.established("S1", "fp"), [])
        ledger.record("S1", "fp", criteria, {
            ...fail(["A builds"]),
            contractConflicts: [{ criterion: "C has three commits" }],
        })
        assert.deepEqual(ledger.established("S1", "fp"), ["B keeps the tests"])
    })

    it("never turns an inconclusive review or a pass into something else", () => {
        const inconclusive = { ...fail(["A builds"]), status: "inconclusive" as const }
        assert.equal(honorEstablished(inconclusive, ["A builds"]), inconclusive)
        const untouched = fail(["C has three commits"])
        assert.equal(honorEstablished(untouched, ["A builds"]), untouched)
    })

    it("tells the Critic which criteria stand, by number", () => {
        const prompt = buildEvalPrompt(criteria, "done", null, null, null, undefined, [], false, null, null, ["B keeps the tests"])
        assert.match(prompt, /## Already established/)
        assert.match(prompt, /found criteria 2 satisfied/)
        assert.doesNotMatch(buildEvalPrompt(criteria, "done"), /Already established/)
    })
})
