import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    GoalContractCoverageError,
    validateGoalContractCoverage,
} from "../../src/planning/goal-contract-coverage.js"
import { deriveGoalContract } from "../../src/runtime/goal-contract.js"

const contract = deriveGoalContract({
    objective: "Preserve the complete goal.",
    acceptanceCriteria: ["Acceptance one", "Acceptance two"],
    constraints: ["Constraint one"],
    nonGoals: [],
    assumptions: [],
})!

describe("GoalContract structural coverage", () => {
    it("ignores mappings when no GoalContract is active", () => {
        assert.deepEqual(
            validateGoalContractCoverage(
                null,
                [{ storyId: "S1", invariantIds: ["unknown"] }],
                "complete",
            ),
            { coveredInvariantIds: [], missingInvariantIds: [] },
        )
    })

    it("rejects unknown mapped invariant ids in partial and complete modes", () => {
        for (const mode of ["partial", "complete"] as const) {
            assert.throws(
                () => validateGoalContractCoverage(
                    contract,
                    [{ storyId: "S1", invariantIds: ["G-A1", "G-A99"] }],
                    mode,
                ),
                (error: unknown) => {
                    assert.ok(error instanceof GoalContractCoverageError)
                    assert.equal(error.code, "unknown_invariant")
                    assert.match(error.message, /S1: G-A99/)
                    return true
                },
            )
        }
    })

    it("allows incomplete union coverage for partial plans", () => {
        assert.deepEqual(
            validateGoalContractCoverage(
                contract,
                [{ storyId: "S1", invariantIds: ["G-A1"] }],
                "partial",
            ),
            {
                coveredInvariantIds: ["G-A1"],
                missingInvariantIds: ["G-A2", "G-C1"],
            },
        )
    })

    it("requires complete union coverage without requiring one owner per story", () => {
        assert.deepEqual(
            validateGoalContractCoverage(
                contract,
                [
                    { storyId: "S1", invariantIds: ["G-A1", "G-C1"] },
                    { storyId: "S2", invariantIds: ["G-A2"] },
                ],
                "complete",
            ),
            {
                coveredInvariantIds: ["G-A1", "G-A2", "G-C1"],
                missingInvariantIds: [],
            },
        )

        assert.throws(
            () => validateGoalContractCoverage(
                contract,
                [{ storyId: "S1", invariantIds: ["G-A1", "G-C1"] }],
                "complete",
            ),
            (error: unknown) => {
                assert.ok(error instanceof GoalContractCoverageError)
                assert.equal(error.code, "incomplete_coverage")
                assert.match(error.message, /G-A2/)
                return true
            },
        )
    })
})
