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

    it("fails closed on dependencies outside the projected graph", () => {
        assert.throws(
            () =>
                buildDag([
                    { id: "ready", dependsOn: ["missing"] },
                    { id: "dependent", dependsOn: ["ready"] },
                ]),
            /Unknown dependency: ready -> missing/,
        )
    })

    it("fails closed on duplicate story ids and dependency edges", () => {
        assert.throws(
            () => buildDag([{ id: "same" }, { id: "same" }]),
            /Duplicate story id: same/,
        )
        assert.throws(
            () =>
                buildDag([
                    { id: "base" },
                    { id: "child", dependsOn: ["base", "base"] },
                ]),
            /Duplicate dependency: child -> base/,
        )
    })

    it("uses story ids as a stable tie-break independent of input order", () => {
        const first = buildDag([
            { id: "zeta", priority: 1 },
            { id: "alpha", priority: 1 },
        ])
        const second = buildDag([
            { id: "alpha", priority: 1 },
            { id: "zeta", priority: 1 },
        ])

        assert.deepEqual(first, [{ storyIds: ["alpha", "zeta"] }])
        assert.deepEqual(second, first)
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
