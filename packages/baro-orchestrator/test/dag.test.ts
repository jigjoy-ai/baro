import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { buildDag } from "../src/dag.js"

describe("buildDag", () => {
    it("groups stories into topological levels", () => {
        const levels = buildDag([
            { id: "setup" },
            { id: "api", dependsOn: ["setup"] },
            { id: "ui", dependsOn: ["setup"] },
            { id: "release", dependsOn: ["api", "ui"] },
        ])

        assert.deepEqual(levels, [
            { storyIds: ["setup"] },
            { storyIds: ["api", "ui"] },
            { storyIds: ["release"] },
        ])
    })

    it("sorts stories at the same level by ascending priority", () => {
        const levels = buildDag([
            { id: "medium", priority: 20 },
            { id: "default" },
            { id: "low", priority: 100 },
            { id: "high", priority: -10 },
        ])

        assert.deepEqual(levels, [
            { storyIds: ["high", "default", "medium", "low"] },
        ])
    })

    it("excludes completed stories with onlyIncomplete and treats their dependencies as satisfied", () => {
        const levels = buildDag(
            [
                { id: "completed-parent", passes: true },
                { id: "active-child", dependsOn: ["completed-parent"] },
                { id: "blocked-child", dependsOn: ["active-child"] },
                { id: "completed-child", dependsOn: ["active-child"], passes: true },
            ],
            { onlyIncomplete: true },
        )

        assert.deepEqual(levels, [
            { storyIds: ["active-child"] },
            { storyIds: ["blocked-child"] },
        ])
    })

    it("ignores dependencies on unknown stories", () => {
        const levels = buildDag([
            { id: "ready", dependsOn: ["missing"] },
            { id: "dependent", dependsOn: ["ready"] },
        ])

        assert.deepEqual(levels, [
            { storyIds: ["ready"] },
            { storyIds: ["dependent"] },
        ])
    })

    it("throws when active stories contain a dependency cycle", () => {
        assert.throws(
            () =>
                buildDag([
                    { id: "a", dependsOn: ["c"] },
                    { id: "b", dependsOn: ["a"] },
                    { id: "c", dependsOn: ["b"] },
                    { id: "ready" },
                ]),
            /Dependency cycle detected: a, b, c/,
        )
    })
})
