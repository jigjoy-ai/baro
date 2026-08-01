import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PrdStory } from "../../src/prd.js"
import { applyReplan, normalizePrd } from "../../src/prd.js"
import { validateProgressivePlannerStory } from "../../src/planning/domain/progressive-plan.js"
import { PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA } from "../../src/planning/adapters/planner-openai-progressive.js"
import {
    pruneUnsupportedEdges,
    referencedPathsOf,
    unsupportedEdges,
    writeSurfaceOf,
} from "../../src/planning/domain/dependency-evidence.js"

function story(
    id: string,
    fields: Partial<PrdStory> & { writes?: string[] } = {},
): PrdStory {
    return {
        id,
        priority: 1,
        title: id,
        description: "",
        dependsOn: [],
        retries: 2,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        ...fields,
    } as PrdStory
}

describe("what makes a dependency edge real", () => {
    // The measured plan. The planner defended S1→S2→S3→S4 with "concurrent
    // agents would collide on shared writes"; the three tails wrote shops,
    // menus and promotions/tables/public/internal — no file in common.
    const foundation = story("S1", {
        writes: [
            "src/common/validation/zodDto.ts",
            "src/common/validation/cvConstraints.ts",
            "src/common/pipes/zodValidation.pipe.ts",
            "package.json",
        ],
    })
    const shops = story("S2", {
        dependsOn: ["S1"],
        writes: [
            "src/shops/dtos/createShop.dto.ts",
            "src/common/shared/pagination.dto.ts",
        ],
        description:
            "Rewrite the shops DTOs importing the helpers from src/common/validation/cvConstraints.ts.",
    })
    const menus = story("S3", {
        dependsOn: ["S2"],
        writes: ["src/menus/dtos/createMenu.dto.ts"],
        description:
            "Rewrite the menus DTOs using the same parity table as S2. Run npm test against package.json.",
    })
    const rest = story("S4", {
        dependsOn: ["S3"],
        writes: ["src/promotions/dtos/createPromotion.dto.ts", "tsconfig.json"],
        description:
            "Rewrite the last DTOs. Confirm src/menus/dtos/__tests__/menuItemBatch.spec.ts still passes.",
    })
    const plan = [foundation, shops, menus, rest]

    it("keeps the edge to the foundation every story builds on", () => {
        const removed = unsupportedEdges(plan)
        assert.equal(
            removed.some((edge) => edge.from === "S1"),
            false,
            "S2 names a file S1 writes, which is what building on it looks like",
        )
    })

    it("drops the chain between stories that write disjoint directories", () => {
        const removed = unsupportedEdges(plan)
        assert.deepEqual(removed, [
            { from: "S2", to: "S3" },
            { from: "S3", to: "S4" },
        ])
    })

    it("does not accept a spec file as evidence of writing a story's output", () => {
        // S4 mentions the menus *spec*; S3 writes the menus *DTO*. Running the
        // same test is not a dependency, or every story would depend on every
        // other one.
        assert.ok(
            referencedPathsOf(rest).includes(
                "src/menus/dtos/__tests__/menuItemBatch.spec.ts",
            ),
        )
        assert.equal(
            unsupportedEdges([menus, rest]).length,
            1,
            "the edge S3->S4 stays unsupported",
        )
    })

    it("turns the chain into a fan without touching anything else", () => {
        const result = pruneUnsupportedEdges(plan)
        assert.deepEqual(
            result.stories.map((entry) => [entry.id, entry.dependsOn]),
            [
                ["S1", []],
                ["S2", ["S1"]],
                ["S3", []],
                ["S4", []],
            ],
        )
        assert.equal(result.stories[1]!.description, shops.description)
    })

    it("keeps an edge between two stories that would collide", () => {
        const a = story("A", { writes: ["src/shared/config.ts"] })
        const b = story("B", { dependsOn: ["A"], writes: ["src/shared/config.ts"] })
        assert.deepEqual(unsupportedEdges([a, b]), [])
    })
})

describe("evidence is required to remove an edge, never to keep one", () => {
    it("keeps every edge when the planner declared no write surface", () => {
        const a = story("A")
        const b = story("B", { dependsOn: ["A"] })
        assert.deepEqual(unsupportedEdges([a, b]), [])
    })

    it("keeps the edge when only the dependent declared its writes", () => {
        const a = story("A")
        const b = story("B", { dependsOn: ["A"], writes: ["src/b.ts"] })
        assert.deepEqual(unsupportedEdges([a, b]), [])
    })

    it("ignores an edge pointing at a story that is not in the plan", () => {
        const b = story("B", { dependsOn: ["GONE"], writes: ["src/b.ts"] })
        assert.deepEqual(unsupportedEdges([b]), [])
    })

    it("reads a write surface only from a list of strings", () => {
        assert.deepEqual(writeSurfaceOf(story("A", { writes: ["./src/a.ts"] })), [
            "src/a.ts",
        ])
        assert.deepEqual(
            writeSurfaceOf(story("A", { writes: "src/a.ts" } as never)),
            [],
        )
    })
})

describe("pruning and the immutable admitted prefix", () => {
    // A run died at result_finalize_failed: "final PRD story 2 does not
    // exactly match admitted prefix story 'S2'". Fragments were admitted with
    // their edges intact because the fragment schema dropped the write
    // surface, then the final PRD was pruned — and the prefix check correctly
    // refused a story that had changed after a worker was given it.
    it("gives the same answer for a fragment prefix as for the whole plan", () => {
        const s1 = story("S1", { writes: ["src/common/validation/zodDto.ts"] })
        const s2 = story("S2", {
            dependsOn: ["S1"],
            writes: ["src/shops/dtos/createShop.dto.ts"],
            description: "Uses src/common/validation/zodDto.ts.",
        })
        const s3 = story("S3", {
            dependsOn: ["S2"],
            writes: ["src/menus/dtos/createMenu.dto.ts"],
            description: "Same parity table as S2.",
        })

        const atAdmission = pruneUnsupportedEdges([s1, s2])
        const atFinalize = pruneUnsupportedEdges([s1, s2, s3])

        assert.deepEqual(
            atAdmission.stories.map((entry) => entry.dependsOn),
            atFinalize.stories.slice(0, 2).map((entry) => entry.dependsOn),
            "an edge is judged from its own two stories, so context cannot change it",
        )
        assert.deepEqual(atFinalize.stories[2]!.dependsOn, [])
    })

    it("judges an edge reaching back into an earlier fragment", () => {
        const admitted = story("S1", { writes: ["src/foundation.ts"] })
        const arriving = story("S4", {
            dependsOn: ["S1"],
            writes: ["src/tables/dtos/createTable.dto.ts"],
            description: "Imports the helpers from src/foundation.ts.",
        })
        assert.deepEqual(unsupportedEdges([admitted, arriving]), [])
    })
})

describe("the write surface survives every hop it takes", () => {
    // Four times in one afternoon a layer silently dropped this field, and each
    // time the run died at result_finalize_failed because the admitted prefix
    // and the final PRD no longer agreed. The field crosses: the MCP tool
    // schema, fragment validation, the published-story snapshot, and the final
    // story snapshot. A hop that forgets it is indistinguishable from a story
    // that never declared one.
    it("is carried by fragment validation", () => {
        const story = validateProgressivePlannerStory({
            id: "S1",
            priority: 1,
            title: "t",
            description: "d",
            dependsOn: [],
            retries: 2,
            acceptance: ["a"],
            tests: ["npm test"],
            goalInvariantIds: [],
            passes: false,
            completedAt: null,
            durationSecs: null,
            writes: ["src/a.ts", "src/b.ts"],
        })
        assert.deepEqual(story.writes, ["src/a.ts", "src/b.ts"])
    })

    it("is offered by the tool schema the planner actually sees", () => {
        const schema = PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA as {
            properties: {
                stories: { items: { properties: Record<string, unknown> } }
            }
        }
        assert.ok(
            "writes" in schema.properties.stories.items.properties,
            "a field the tool does not offer is a field the planner cannot send",
        )
    })

    it("does not make a story that omits it unpublishable", () => {
        const story = validateProgressivePlannerStory({
            id: "S1",
            priority: 1,
            title: "t",
            description: "d",
            dependsOn: [],
            retries: 2,
            acceptance: ["a"],
            tests: ["npm test"],
            goalInvariantIds: [],
            passes: false,
            completedAt: null,
            durationSecs: null,
        })
        assert.equal(story.writes, undefined)
    })

    it("rejects a write surface that is not a list of paths", () => {
        assert.throws(() =>
            validateProgressivePlannerStory({
                id: "S1",
                priority: 1,
                title: "t",
                description: "d",
                dependsOn: [],
                retries: 2,
                acceptance: ["a"],
                tests: ["npm test"],
                goalInvariantIds: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                writes: "src/a.ts",
            }),
        )
    })
})

describe("the write surface reaches the graph, not only the record", () => {
    // Five boundaries dropped this field before anyone noticed, each one an
    // independent list of allowed keys. The sixth was the runtime graph: the
    // planner declared a write surface in full, the audit carried it, and
    // prd.json showed none — so a live run was reported as "the planner never
    // declares it" when the planner had.
    it("survives a replan into the stored graph", () => {
        const prd = normalizePrd(
            {
                project: "p",
                branchName: "b",
                description: "d",
                userStories: [
                    {
                        id: "S0",
                        priority: 1,
                        title: "seed",
                        description: "seed",
                        dependsOn: [],
                        retries: 2,
                        acceptance: ["ok"],
                        tests: ["npm test"],
                        passes: false,
                        completedAt: null,
                        durationSecs: null,
                    },
                ],
            },
            "test-prd.json",
        )
        const replanned = applyReplan(prd, {
            source: "planner:test",
            reason: "admit a fragment",
            addedStories: [
                {
                    id: "S1",
                    priority: 2,
                    title: "foundation",
                    description: "build it",
                    dependsOn: [],
                    retries: 2,
                    acceptance: ["it works"],
                    tests: ["npm test"],
                    writes: ["src/common/validation/zodDto.ts"],
                },
            ],
            removedStoryIds: [],
            modifiedDeps: {},
        })
        const stored = replanned.userStories.find((story) => story.id === "S1")
        assert.ok(stored, "the story reached the graph")
        assert.deepEqual(
            stored.writes,
            ["src/common/validation/zodDto.ts"],
            "a story in the graph must still say what it writes",
        )
    })
})
