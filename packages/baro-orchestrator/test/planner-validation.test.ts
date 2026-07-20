import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { assertRunnablePlannerPrdJson } from "../src/planning/planner-validation.js"

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
})
