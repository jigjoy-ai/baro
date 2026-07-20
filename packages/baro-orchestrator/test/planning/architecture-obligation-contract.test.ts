import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ArchitectureObligationContractError,
    architectureObligationsFromDecision,
    parseArchitectureObligationContract,
    renderArchitectureObligationCriterion,
    validateArchitectureObligationCoverage,
} from "../../src/planning/architecture-obligation-contract.js"
import { deriveGoalContract } from "../../src/runtime/goal-contract.js"
import { buildPlannerUserMessage } from "../../src/planning/planner-prompts.js"

const goal = deriveGoalContract({
    objective: "Preserve behavior at every affected boundary.",
    acceptanceCriteria: ["Every affected boundary has the required behavior."],
    constraints: ["Existing callers remain compatible."],
    nonGoals: [],
    assumptions: [],
})!

function obligationJson() {
    return {
        schemaVersion: 1,
        obligations: [
            {
                id: "O-001",
                invariantIds: ["G-A1"],
                subject: "the direct public boundary",
                scenario: "the changed operation is invoked directly",
                expectedOutcome: "the required behavior remains observable",
                evidence: ["a focused direct-boundary test"],
            },
            {
                id: "O-002",
                invariantIds: ["G-C1"],
                subject: "existing callers",
                scenario: "the new capability is not requested",
                expectedOutcome: "their call shape and result remain compatible",
                evidence: ["typecheck", "a no-option regression test"],
            },
        ],
    }
}

function decision(value: unknown = obligationJson()): string {
    return `## Existing context
Observed repository facts.

## ADR-001: Preserve the shared behavior
**Status:** Accepted
**Context:** Multiple boundaries implement the contract.
**Decision:** Keep their behavior aligned.
**Consequences:** Each boundary needs independent evidence.

## Semantic obligation contract

\`\`\`baro-obligations-v1
${JSON.stringify(value)}
\`\`\``
}

describe("Architecture obligation contract", () => {
    it("keeps legacy decision documents outside the opt-in contract", () => {
        assert.equal(
            parseArchitectureObligationContract("## ADR-001: Legacy\n**Status:** Accepted"),
            null,
        )
    })

    it("parses, binds, freezes and renders a stable canonical criterion", () => {
        const contract = architectureObligationsFromDecision(decision(), goal)!
        assert.equal(contract.obligations.length, 2)
        assert.ok(Object.isFrozen(contract))
        assert.ok(Object.isFrozen(contract.obligations[0]))
        assert.equal(
            renderArchitectureObligationCriterion(contract.obligations[0]!),
            "[O-001]; Subject: the direct public boundary; Scenario: the changed operation is invoked directly; Required outcome: the required behavior remains observable; Required evidence: a focused direct-boundary test",
        )
    })

    it("pre-renders exact canonical criteria in the Planner handoff", () => {
        const contract = architectureObligationsFromDecision(decision(), goal)!
        const prompt = buildPlannerUserMessage({
            goal: "Implement the confirmed goal.",
            decisionDocument: decision(),
        })
        for (const obligation of contract.obligations) {
            assert.match(
                prompt,
                new RegExp(escapeRegex(renderArchitectureObligationCriterion(obligation)), "u"),
            )
        }
        assert.match(prompt, /byte-for-byte into exactly one story acceptance/u)
    })

    it("fails closed for malformed, repeated, non-contiguous and unbound contracts", () => {
        assert.throws(
            () => parseArchitectureObligationContract(
                "```baro-obligations-v1\nnot-json\n```",
            ),
            ArchitectureObligationContractError,
        )
        assert.throws(
            () => parseArchitectureObligationContract(`${decision()}\n${decision()}`),
            /exactly one/u,
        )

        const nonContiguous = obligationJson()
        nonContiguous.obligations[1]!.id = "O-003"
        assert.throws(
            () => parseArchitectureObligationContract(decision(nonContiguous)),
            /must be O-002/u,
        )

        const unknownParent = obligationJson()
        unknownParent.obligations[0]!.invariantIds = ["G-A99"]
        assert.throws(
            () => architectureObligationsFromDecision(decision(unknownParent), goal),
            /unknown GoalContract invariant.*G-A99/u,
        )

        const missingParent = obligationJson()
        missingParent.obligations.splice(1, 1)
        assert.throws(
            () => architectureObligationsFromDecision(decision(missingParent), goal),
            /does not refine.*G-C1/u,
        )
    })

    it("requires exact single-owner story coverage with coherent parent invariants", () => {
        const contract = architectureObligationsFromDecision(decision(), goal)!
        const first = renderArchitectureObligationCriterion(contract.obligations[0]!)
        const second = renderArchitectureObligationCriterion(contract.obligations[1]!)
        const mappings = [
            { storyId: "S1", acceptance: [first], invariantIds: ["G-A1"] },
            { storyId: "S2", acceptance: [second], invariantIds: ["G-C1"] },
        ]
        assert.deepEqual(
            validateArchitectureObligationCoverage(contract, mappings, "complete"),
            {
                coveredObligationIds: ["O-001", "O-002"],
                missingObligationIds: [],
            },
        )
        assert.deepEqual(
            validateArchitectureObligationCoverage(contract, mappings.slice(0, 1), "partial"),
            {
                coveredObligationIds: ["O-001"],
                missingObligationIds: ["O-002"],
            },
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(
                contract,
                mappings.slice(0, 1),
                "complete",
            ),
            /no story owns: O-002/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [
                mappings[0]!,
                { storyId: "S3", acceptance: [first], invariantIds: ["G-A1"] },
            ], "partial"),
            /multiple evidence owners/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [{
                storyId: "S1",
                acceptance: [first],
                invariantIds: [],
            }], "partial"),
            /omits parent.*G-A1/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [{
                storyId: "S1",
                acceptance: [`${first} narrowed`],
                invariantIds: ["G-A1"],
            }], "partial"),
            /altered canonical.*O-001/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [{
                storyId: "S1",
                acceptance: ["[O-099]; invented"],
                invariantIds: ["G-A1"],
            }], "partial"),
            /unknown architecture obligation O-099/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [{
                storyId: "S1",
                acceptance: ["[O-001]: weakened"],
                invariantIds: ["G-A1"],
            }], "partial"),
            /altered canonical.*O-001/u,
        )
        assert.throws(
            () => validateArchitectureObligationCoverage(contract, [{
                storyId: "S1",
                acceptance: ["[O-099]: invented"],
                invariantIds: ["G-A1"],
            }], "partial"),
            /unknown architecture obligation O-099/u,
        )
    })
})

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}
