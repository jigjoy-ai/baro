import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deriveGoalContract, type GoalContract } from "../../src/goal/goal-contract.js"
import {
    emitInvariantCoverageGap,
    type InvariantCoverageGapSink,
} from "../../src/planning/application/plan-events.js"
import {
    GoalContractCoverageError,
    missingInvariantIdsFromError,
    validateGoalContractCoverage,
} from "../../src/planning/domain/goal-contract-coverage.js"
import {
    formatInvariantIdList,
    invariantGapSummary,
    renderUnownedInvariantLines,
    unownedInvariantIds,
    unownedInvariantsWithText,
} from "../../src/planning/domain/invariant-coverage-report.js"

const contract = deriveGoalContract({
    objective: "Preserve the complete goal.",
    acceptanceCriteria: ["Acceptance one", "Acceptance two"],
    constraints: ["Constraint one"],
    nonGoals: [],
    assumptions: [],
})!

/** The goal envelope caps each list at 32, so 43 invariants must span both. */
function contractWith(acceptance: number, constraints: number): GoalContract {
    return deriveGoalContract({
        objective: "Wide goal.",
        acceptanceCriteria: Array.from(
            { length: acceptance },
            (_, i) => `Acceptance ${i + 1}`,
        ),
        constraints: Array.from({ length: constraints }, (_, i) => `Constraint ${i + 1}`),
        nonGoals: [],
        assumptions: [],
    })!
}

function story(id: string, goalInvariantIds?: string[]) {
    return goalInvariantIds === undefined ? { id } : { id, goalInvariantIds }
}

describe("invariant coverage report", () => {
    it("yields no gap without a contract", () => {
        assert.deepEqual(unownedInvariantIds(null, [story("S1", ["G-A1"])]), [])
        assert.deepEqual(unownedInvariantIds(undefined, []), [])
    })

    it("reports exactly the unclaimed ids for partial claims", () => {
        assert.deepEqual(
            unownedInvariantIds(contract, [story("S1", ["G-A1"]), story("S2", [])]),
            ["G-A2", "G-C1"],
        )
        assert.deepEqual(unownedInvariantIds(contract, [story("S1")]), [
            "G-A1",
            "G-A2",
            "G-C1",
        ])
    })

    it("reports no gap once every invariant is claimed", () => {
        assert.deepEqual(
            unownedInvariantIds(contract, [
                story("S1", ["G-A1", "G-A2"]),
                story("S2", ["G-C1"]),
            ]),
            [],
        )
    })

    it("reads a claim the validator rejects as a full gap, never as coverage", () => {
        assert.throws(
            () =>
                validateGoalContractCoverage(
                    contract,
                    [{ storyId: "S1", invariantIds: ["G-A1", "G-A99"] }],
                    "partial",
                ),
            GoalContractCoverageError,
        )
        assert.deepEqual(unownedInvariantIds(contract, [story("S1", ["G-A1", "G-A99"])]), [
            "G-A1",
            "G-A2",
            "G-C1",
        ])
    })

    it("caps a rendered id list at 40 with an overflow suffix", () => {
        const ids = Array.from({ length: 43 }, (_, i) => `G-A${i + 1}`)
        assert.equal(formatInvariantIdList([]), "")
        assert.equal(formatInvariantIdList(["G-A1", "G-C1"]), "G-A1, G-C1")
        const rendered = formatInvariantIdList(ids)
        assert.equal(rendered, `${ids.slice(0, 40).join(", ")} … (+3 more)`)
        assert.ok(!rendered.includes("G-A41"))
        assert.equal(formatInvariantIdList(ids.slice(0, 40)), ids.slice(0, 40).join(", "))
    })

    it("summarises the gap as N/T, adding the ids only when non-empty", () => {
        assert.equal(invariantGapSummary([], 3), "0/3")
        assert.equal(invariantGapSummary(["G-A2", "G-C1"], 3), "2/3: G-A2, G-C1")
    })

    it("resolves ids to contract-ordered invariants and drops unknown ones", () => {
        assert.deepEqual(
            unownedInvariantsWithText(contract, ["G-C1", "G-A1", "G-Z9"]).map(
                ({ id, text }) => [id, text],
            ),
            [
                ["G-A1", "Acceptance one"],
                ["G-C1", "Constraint one"],
            ],
        )
        assert.deepEqual(unownedInvariantsWithText(null, ["G-A1"]), [])
    })

    it("renders one bracketed statement line per invariant, capped at 40", () => {
        assert.equal(
            renderUnownedInvariantLines(
                unownedInvariantsWithText(contract, ["G-A1", "G-C1"]),
            ),
            "- [G-A1] Acceptance one\n- [G-C1] Constraint one",
        )
        assert.equal(renderUnownedInvariantLines([]), "")

        const wide = contractWith(22, 21)
        assert.equal(wide.invariants.length, 43)
        const lines = renderUnownedInvariantLines(wide.invariants).split("\n")
        assert.equal(lines.length, 41)
        assert.equal(lines[0], "- [G-A1] Acceptance 1")
        const fortieth = wide.invariants[39]!
        assert.equal(lines[39], `- [${fortieth.id}] ${fortieth.text}`)
        assert.equal(lines[40], "- … (+3 more)")
        assert.ok(!lines.some((line) => line.startsWith(`- [${wide.invariants[40]!.id}]`)))
    })

    it("announces the gap as an ungated warn naming the concrete ids", () => {
        const written: string[] = []
        const original = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
            written.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        try {
            const sink: InvariantCoverageGapSink = emitInvariantCoverageGap
            sink({
                fragmentId: "frag-1",
                unownedInvariantIds: ["G-A2", "G-C1"],
                totalInvariants: 3,
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
        assert.equal(event.type, "activity")
        assert.equal(event.id, "plan")
        assert.equal(event.kind, "warn")
        assert.equal(
            event.text,
            "[planner-invariants] fragment frag-1: 2/3 goal invariant(s) unowned: G-A2, G-C1",
        )
    })
})

describe("GoalContractCoverageError missing ids", () => {
    it("carries the offending ids for an unknown invariant claim", () => {
        try {
            validateGoalContractCoverage(
                contract,
                [{ storyId: "S1", invariantIds: ["G-A99"] }],
                "partial",
            )
            assert.fail("expected a coverage error")
        } catch (error) {
            assert.ok(error instanceof GoalContractCoverageError)
            assert.equal(error.code, "unknown_invariant")
            assert.equal(
                error.message,
                "GoalContract mappings reference unknown invariant id(s): S1: G-A99",
            )
            assert.deepEqual(missingInvariantIdsFromError(error), ["G-A99"])
        }
    })

    it("carries the missing ids for incomplete complete-mode coverage", () => {
        try {
            validateGoalContractCoverage(
                contract,
                [{ storyId: "S1", invariantIds: ["G-A1"] }],
                "complete",
            )
            assert.fail("expected a coverage error")
        } catch (error) {
            assert.ok(error instanceof GoalContractCoverageError)
            assert.equal(error.code, "incomplete_coverage")
            assert.equal(
                error.message,
                "GoalContract coverage is incomplete; no story owns invariant(s): G-A2, G-C1",
            )
            assert.deepEqual(missingInvariantIdsFromError(error), ["G-A2", "G-C1"])
        }
    })

    it("defaults missingInvariantIds to [] and reads [] from any other error", () => {
        const legacy = new GoalContractCoverageError("unknown_invariant", "legacy")
        assert.deepEqual(legacy.missingInvariantIds, [])
        assert.deepEqual(missingInvariantIdsFromError(legacy), [])
        assert.deepEqual(missingInvariantIdsFromError(new Error("other")), [])
        assert.deepEqual(missingInvariantIdsFromError(undefined), [])
    })
})
