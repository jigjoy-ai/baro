import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PrdStory } from "../../src/prd.js"
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
