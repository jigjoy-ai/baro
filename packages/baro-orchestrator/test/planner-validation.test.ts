import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { assertRunnablePlannerPrdJson } from "../src/planning/planner-validation.js"
import {
    parseArchitectureObligationContract,
    renderArchitectureObligationCriterion,
} from "../src/planning/architecture-obligation-contract.js"

function validPrd(): Record<string, unknown> {
    return {
        project: "p",
        branchName: "baro/p",
        description: "implement p",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "foundation",
                description: "implement the foundation",
                dependsOn: [],
                retries: 2,
                acceptance: ["foundation behavior is observable"],
                tests: ["npm test -- foundation"],
                model: "heavy",
            },
            {
                id: "S2",
                priority: 2,
                title: "consumer",
                description: "implement the consumer",
                dependsOn: ["S1"],
                retries: 2,
                acceptance: ["consumer preserves compatibility"],
                tests: ["npm test -- consumer"],
                model: "standard",
            },
        ],
    }
}

describe("shared Planner PRD validation", () => {
    it("accepts a complete tiered runnable DAG", () => {
        const json = JSON.stringify(validPrd())
        assert.equal(assertRunnablePlannerPrdJson(json), json)
    })

    it("requires non-empty project metadata and at least one story", () => {
        for (const field of ["project", "branchName", "description"] as const) {
            const prd = validPrd()
            prd[field] = "   "
            assert.throws(
                () => assertRunnablePlannerPrdJson(JSON.stringify(prd)),
                /non-empty/,
            )
        }

        const prd = validPrd()
        prd.userStories = []
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(prd)),
            /at least one user story/,
        )
    })

    it("requires i32 priorities and operationally bounded retry counts", () => {
        for (const [field, value] of [
            ["priority", undefined],
            ["priority", 2_147_483_648],
            ["priority", 1.5],
            ["retries", undefined],
            ["retries", -1],
            ["retries", 6],
        ] as const) {
            const prd = validPrd()
            ;(prd.userStories as Record<string, unknown>[])[0]![field] = value
            assert.throws(
                () => assertRunnablePlannerPrdJson(JSON.stringify(prd)),
                field === "priority" ? /i32 priority/ : /between 0 and 5/,
            )
        }
    })

    it("rejects missing descriptions, non-string arrays, semantic evidence, and tiers", () => {
        for (const mutate of [
            (story: Record<string, unknown>) => { story.description = "" },
            (story: Record<string, unknown>) => { story.dependsOn = [1] },
            (story: Record<string, unknown>) => { story.acceptance = [false] },
            (story: Record<string, unknown>) => { story.tests = "npm test" },
            (story: Record<string, unknown>) => { story.acceptance = [] },
            (story: Record<string, unknown>) => { story.tests = [" "] },
            (story: Record<string, unknown>) => { delete story.model },
            (story: Record<string, unknown>) => { story.model = "cheap" },
        ]) {
            const prd = validPrd()
            mutate((prd.userStories as Record<string, unknown>[])[0]!)
            assert.throws(() => assertRunnablePlannerPrdJson(JSON.stringify(prd)))
        }
    })

    it("rejects duplicate ids, unknown dependencies, and cycles", () => {
        const duplicate = validPrd()
        ;(duplicate.userStories as Record<string, unknown>[])[1]!.id = "S1"
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(duplicate)),
            /duplicate story id/,
        )

        const unknown = validPrd()
        ;(unknown.userStories as Record<string, unknown>[])[1]!.dependsOn = ["missing"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(unknown)),
            /depends on unknown story/,
        )

        const self = validPrd()
        ;(self.userStories as Record<string, unknown>[])[0]!.dependsOn = ["S1"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(self)),
            /depends on itself/,
        )

        const repeated = validPrd()
        ;(repeated.userStories as Record<string, unknown>[])[1]!.dependsOn = ["S1", "S1"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(repeated)),
            /duplicate dependencies/,
        )

        const cycle = validPrd()
        ;(cycle.userStories as Record<string, unknown>[])[0]!.dependsOn = ["S2"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(JSON.stringify(cycle)),
            /dependency cycle/,
        )
    })

    it("binds mappings to the trusted GoalContract and leaves missing work for Guardian", () => {
        const governed = validPrd()
        const trustedGoalEnvelope = {
            objective: "Preserve both required behaviors.",
            acceptanceCriteria: ["Foundation works", "Consumer works"],
            constraints: ["Compatibility is preserved"],
            nonGoals: [],
            assumptions: [],
        }
        governed.goalEnvelope = {
            ...trustedGoalEnvelope,
            acceptanceCriteria: ["Provider-authored replacement contract"],
        }
        const stories = governed.userStories as Record<string, unknown>[]
        stories[0]!.goalInvariantIds = ["G-A1", "G-C1"]
        stories[1]!.goalInvariantIds = ["G-A2"]

        const json = JSON.stringify(governed)
        assert.equal(
            assertRunnablePlannerPrdJson(json, trustedGoalEnvelope),
            json,
        )

        stories[1]!.goalInvariantIds = ["G-A99"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(
                JSON.stringify(governed),
                trustedGoalEnvelope,
            ),
            /unknown invariant.*G-A99/i,
        )

        stories[1]!.goalInvariantIds = []
        const incomplete = JSON.stringify(governed)
        assert.equal(
            assertRunnablePlannerPrdJson(incomplete, trustedGoalEnvelope),
            incomplete,
            "missing ownership is repaired by GoalGuardian rather than aborting planning",
        )
        const providerOnly = JSON.stringify({
            ...governed,
            userStories: [
                { ...stories[0], goalInvariantIds: ["G-A99"] },
                stories[1],
            ],
        })
        assert.equal(
            assertRunnablePlannerPrdJson(providerOnly),
            providerOnly,
            "provider-owned envelope fields never manufacture trusted authority",
        )
    })

    it("strictly preserves Architect obligations when the trusted handoff opts in", () => {
        const trustedGoalEnvelope = {
            objective: "Preserve behavior at both owned boundaries.",
            acceptanceCriteria: ["The requested behavior is observable."],
            constraints: ["Existing callers remain compatible."],
            nonGoals: [],
            assumptions: [],
        }
        const decisionDocument = `## Existing context
Two boundaries implement the behavior.

## ADR-001: Preserve both boundaries
**Status:** Accepted
**Context:** They can be invoked independently.
**Decision:** Give each boundary explicit evidence.
**Consequences:** Planning cannot collapse their semantic ownership.

## Semantic obligation contract

\`\`\`baro-obligations-v1
{"schemaVersion":1,"obligations":[{"id":"O-001","invariantIds":["G-A1"],"subject":"the direct boundary","scenario":"it is invoked independently","expectedOutcome":"the requested behavior is observable","evidence":["a direct-boundary test"]},{"id":"O-002","invariantIds":["G-C1"],"subject":"existing callers","scenario":"they omit the new option","expectedOutcome":"their behavior remains compatible","evidence":["typecheck"]}]}
\`\`\``
        const obligations = parseArchitectureObligationContract(decisionDocument)!
        const prd = validPrd()
        const stories = prd.userStories as Record<string, unknown>[]
        stories[0]!.goalInvariantIds = ["G-A1"]
        stories[0]!.acceptance = [
            renderArchitectureObligationCriterion(obligations.obligations[0]!),
        ]
        stories[1]!.goalInvariantIds = ["G-C1"]
        stories[1]!.acceptance = [
            renderArchitectureObligationCriterion(obligations.obligations[1]!),
        ]
        const json = JSON.stringify(prd)
        assert.equal(
            assertRunnablePlannerPrdJson(
                json,
                trustedGoalEnvelope,
                decisionDocument,
            ),
            json,
        )

        stories[1]!.acceptance = ["consumer preserves compatibility"]
        assert.throws(
            () => assertRunnablePlannerPrdJson(
                JSON.stringify(prd),
                trustedGoalEnvelope,
                decisionDocument,
            ),
            /coverage is incomplete.*O-002/u,
        )

        stories[1]!.acceptance = [
            `${renderArchitectureObligationCriterion(obligations.obligations[1]!)} narrowed`,
        ]
        assert.throws(
            () => assertRunnablePlannerPrdJson(
                JSON.stringify(prd),
                trustedGoalEnvelope,
                decisionDocument,
            ),
            /altered canonical.*O-002/u,
        )

        stories[1]!.acceptance = [
            renderArchitectureObligationCriterion(obligations.obligations[1]!),
        ]
        stories[1]!.goalInvariantIds = []
        assert.throws(
            () => assertRunnablePlannerPrdJson(
                JSON.stringify(prd),
                trustedGoalEnvelope,
                decisionDocument,
            ),
            /omits parent.*G-C1/u,
        )

        assert.equal(
            assertRunnablePlannerPrdJson(
                JSON.stringify(validPrd()),
                trustedGoalEnvelope,
                "## ADR-001: Legacy document without an obligation marker",
            ),
            JSON.stringify(validPrd()),
        )
    })
})
