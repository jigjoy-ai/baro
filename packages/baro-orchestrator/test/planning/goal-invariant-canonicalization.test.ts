import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deriveGoalContract } from "../../src/goal/goal-contract.js"
import { emitGoalInvariantNote } from "../../src/planning/application/plan-events.js"
import {
    canonicalInvariantAcceptance,
    renderGoalInvariantCriterion,
    type GoalInvariantNote,
} from "../../src/planning/domain/goal-invariant-canonicalization.js"

const contract = deriveGoalContract({
    objective: "Preserve the complete goal.",
    acceptanceCriteria: ["Acceptance one", "Acceptance two"],
    constraints: ["Constraint one"],
    nonGoals: [],
    assumptions: [],
})!

const CANONICAL_A1 = "[G-A1] Acceptance one"

function collect() {
    const notes: GoalInvariantNote[] = []
    return { notes, sink: (note: GoalInvariantNote) => notes.push(note) }
}

describe("goal invariant acceptance canonicalization", () => {
    it("renders a contract invariant as its bracketed canonical criterion", () => {
        assert.equal(renderGoalInvariantCriterion(contract.invariants[0]!), CANONICAL_A1)
    })

    it("restores drifted wording of a known id and announces exactly one note", () => {
        const { notes, sink } = collect()
        const result = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["[G-A1] acceptance one, roughly paraphrased by the planner"],
            sink,
        )
        assert.deepEqual(result.acceptance, [CANONICAL_A1])
        assert.deepEqual(result.invariantIds, ["G-A1"])
        assert.equal(result.changed, true)
        assert.deepEqual(notes, [
            {
                severity: "warn",
                kind: "canonicalized_invariant_criterion",
                storyId: "S1",
                invariantId: "G-A1",
                detail:
                    "story S1: canonicalized paraphrased goal invariant G-A1 criterion text",
            },
        ])
    })

    it("de-duplicates the note per storyId+invariantId+kind", () => {
        const { notes, sink } = collect()
        const result = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["[G-A1] drifted once", "[G-A1] drifted twice"],
            sink,
        )
        assert.deepEqual(result.acceptance, [CANONICAL_A1, CANONICAL_A1])
        assert.deepEqual(result.invariantIds, ["G-A1"])
        assert.equal(notes.length, 1)
    })

    it("is idempotent on already-canonical text", () => {
        const { notes, sink } = collect()
        const once = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["[G-A1] drifted"],
            sink,
        )
        const twice = canonicalInvariantAcceptance(
            contract,
            "S1",
            once.acceptance,
            sink,
        )
        assert.deepEqual(twice.acceptance, once.acceptance)
        assert.equal(twice.changed, false)
        assert.equal(notes.length, 1)
    })

    it("passes an unclaimed criterion through verbatim and claims nothing", () => {
        const { notes, sink } = collect()
        const result = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["Plain acceptance text with no bracketed claim"],
            sink,
        )
        assert.deepEqual(result.acceptance, [
            "Plain acceptance text with no bracketed claim",
        ])
        assert.deepEqual(result.invariantIds, [])
        assert.equal(result.changed, false)
        assert.equal(notes.length, 0)
    })

    it("leaves an unknown id verbatim and records the raw claim for rejection", () => {
        const { notes, sink } = collect()
        const result = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["[G-A99] an invariant this contract does not have"],
            sink,
        )
        assert.deepEqual(result.acceptance, [
            "[G-A99] an invariant this contract does not have",
        ])
        assert.deepEqual(result.invariantIds, ["G-A99"])
        assert.equal(result.changed, false)
        assert.equal(notes.length, 0)
    })

    it("leaves a compound claim verbatim and records the raw capture", () => {
        for (const raw of ["G-A1/G-A2", "G-A1, G-A2", "G-A1 G-A2", "G-A1+G-A2"]) {
            const { notes, sink } = collect()
            const criterion = `[${raw}] both at once`
            const result = canonicalInvariantAcceptance(contract, "S1", [criterion], sink)
            assert.deepEqual(result.acceptance, [criterion])
            assert.deepEqual(result.invariantIds, [raw])
            assert.equal(result.changed, false)
            assert.equal(notes.length, 0)
        }
    })

    it("leaves a malformed token verbatim and records the raw capture", () => {
        const { notes, sink } = collect()
        const result = canonicalInvariantAcceptance(
            contract,
            "S1",
            ["[G-X1] wrong kind letter", "[G-A0] zero ordinal"],
            sink,
        )
        assert.deepEqual(result.acceptance, [
            "[G-X1] wrong kind letter",
            "[G-A0] zero ordinal",
        ])
        assert.deepEqual(result.invariantIds, ["G-X1", "G-A0"])
        assert.equal(result.changed, false)
        assert.equal(notes.length, 0)
    })

    it("records claimed ids in first-appearance order across criteria", () => {
        const result = canonicalInvariantAcceptance(contract, "S1", [
            "[G-C1] drifted constraint",
            "no claim here",
            "[G-A1] drifted acceptance",
            "[G-C1] drifted constraint again",
        ])
        assert.deepEqual(result.invariantIds, ["G-C1", "G-A1"])
        assert.deepEqual(result.acceptance, [
            "[G-C1] Constraint one",
            "no claim here",
            CANONICAL_A1,
            "[G-C1] Constraint one",
        ])
    })

    it("is a no-op without a contract", () => {
        const { notes, sink } = collect()
        const acceptance = ["[G-A1] drifted"]
        const result = canonicalInvariantAcceptance(null, "S1", acceptance, sink)
        assert.deepEqual(result.acceptance, acceptance)
        assert.notEqual(result.acceptance, acceptance)
        assert.deepEqual(result.invariantIds, [])
        assert.equal(result.changed, false)
        assert.equal(notes.length, 0)
    })

    it("forwards a note detail to the run stream as an ungated warn", () => {
        const written: string[] = []
        const original = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
            written.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        try {
            emitGoalInvariantNote({
                severity: "warn",
                kind: "canonicalized_invariant_criterion",
                storyId: "S1",
                invariantId: "G-A1",
                detail:
                    "story S1: canonicalized paraphrased goal invariant G-A1 criterion text",
            })
        } finally {
            process.stdout.write = original
        }
        assert.equal(written.length, 1)
        const event = JSON.parse(written[0]!) as {
            type: string
            id: string
            kind: string
            text: string
        }
        assert.deepEqual(
            [event.type, event.id, event.kind, event.text],
            [
                "activity",
                "plan",
                "warn",
                "story S1: canonicalized paraphrased goal invariant G-A1 criterion text",
            ],
        )
    })
})
