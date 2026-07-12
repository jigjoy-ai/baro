import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { PrdFile, PrdStory } from "../../src/prd.js"
import {
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    type RuntimeReplanMutation,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import {
    snapshotRuntimeReplanMutation,
    validateRuntimeReplanMutation,
} from "../../src/runtime-replan.js"

function story(id: string, overrides: Partial<PrdStory> = {}): PrdStory {
    return {
        id,
        priority: Number(id.replace(/\D/g, "")) || 1,
        title: `Story ${id}`,
        description: `Implement ${id}`,
        dependsOn: [],
        retries: 1,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        ...overrides,
    }
}

function prd(stories: PrdStory[] = [
    story("S1", {
        passes: true,
        completedAt: "2026-07-11T00:00:00.000Z",
    }),
    story("S2", { dependsOn: ["S1"] }),
    story("S3", { dependsOn: ["S2"] }),
]): PrdFile {
    return {
        project: "runtime-replan",
        branchName: "baro/runtime-replan",
        description: "Exercise atomic runtime DAG adaptation.",
        userStories: stories,
    }
}

function add(
    id: string,
    dependsOn: string[] = [],
): RuntimeReplanMutation["addedStories"][number] {
    return {
        id,
        priority: 10,
        title: `Add ${id}`,
        description: `Dynamically discovered work for ${id}`,
        dependsOn,
        retries: 1,
        acceptance: [`${id} works`],
        tests: [`test ${id}`],
        model: "standard",
    }
}

function mutation(
    overrides: Partial<RuntimeReplanMutation> = {},
): RuntimeReplanMutation {
    return {
        addedStories: [],
        removedStoryIds: [],
        modifiedDeps: {},
        ...overrides,
    }
}

function validate(
    current: PrdFile,
    value: RuntimeReplanMutation,
    immutableStoryIds: Iterable<string> = [],
    maxAddedStories = 3,
) {
    return validateRuntimeReplanMutation(current, value, {
        immutableStoryIds,
        maxAddedStories,
    })
}

function expectCode(
    result: ReturnType<typeof validateRuntimeReplanMutation>,
    code: string,
): void {
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, code)
}

describe("runtime replan semantic contract", () => {
    it("carries exact lease and graph-version correlation", () => {
        const patch = mutation({ addedStories: [add("S4", ["S2"])] })
        const correlation = {
            runId: "run-1",
            proposalId: "proposal-1",
            sourceStoryId: "S2",
            leaseId: "lease-2",
            generation: 3,
            baseGraphVersion: 7,
        }
        const proposed = RuntimeReplanProposed.create({
            ...correlation,
            reason: "S4 is required by the discovered API contract",
            mutation: patch,
        })
        const applied = RuntimeReplanApplied.create({
            ...correlation,
            previousGraphVersion: 7,
            graphVersion: 8,
            reason: "candidate is valid",
            mutation: patch,
        })
        const rejected = RuntimeReplanRejected.create({
            ...correlation,
            currentGraphVersion: 8,
            code: "stale_graph_version",
            reason: "another proposal landed first",
        })

        assert.equal(proposed.type, "runtime_replan_proposed")
        assert.equal(applied.type, "runtime_replan_applied")
        assert.equal(rejected.type, "runtime_replan_rejected")
        assert.ok(RuntimeReplanProposed.is(proposed))
        assert.ok(RuntimeReplanApplied.is(applied))
        assert.ok(RuntimeReplanRejected.is(rejected))
        assert.deepEqual(
            {
                runId: applied.data.runId,
                proposalId: applied.data.proposalId,
                sourceStoryId: applied.data.sourceStoryId,
                leaseId: applied.data.leaseId,
                generation: applied.data.generation,
                baseGraphVersion: applied.data.baseGraphVersion,
            },
            correlation,
        )

        const launch: StorySpawnRequestData = {
            storyId: "S4",
            prompt: "Implement S4",
            model: "standard",
            retries: 1,
            timeoutSecs: 60,
            graphVersion: applied.data.graphVersion,
        }
        assert.equal(launch.graphVersion, 8)
    })
})

describe("validateRuntimeReplanMutation", () => {
    it("atomically adds, removes, and rewires only future stories", () => {
        const current = prd()
        const before = structuredClone(current)
        const result = validate(
            current,
            mutation({
                addedStories: [add("S4", ["S2"])],
                removedStoryIds: ["S3"],
                modifiedDeps: { S2: [] },
            }),
            ["S1"],
        )

        assert.equal(result.ok, true)
        if (!result.ok) return
        assert.deepEqual(result.addedStoryIds, ["S4"])
        assert.deepEqual(result.removedStoryIds, ["S3"])
        assert.deepEqual(result.modifiedStoryIds, ["S2"])
        assert.deepEqual(result.affectedStoryIds, ["S4", "S3", "S2"])
        assert.deepEqual(result.prd.userStories.map((item) => item.id), ["S1", "S2", "S4"])
        assert.deepEqual(result.prd.userStories.find((item) => item.id === "S2")?.dependsOn, [])
        assert.deepEqual(result.prd.userStories.find((item) => item.id === "S4"), {
            id: "S4",
            priority: 10,
            title: "Add S4",
            description: "Dynamically discovered work for S4",
            dependsOn: ["S2"],
            retries: 1,
            acceptance: ["S4 works"],
            tests: ["test S4"],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: "standard",
        })

        assert.deepEqual(current, before)
        assert.notEqual(result.prd, current)
        assert.notEqual(result.prd.userStories[0], current.userStories[0])
        assert.notEqual(
            result.prd.userStories[0].dependsOn,
            current.userStories[0].dependsOn,
        )
    })

    it("snapshots all nested mutation arrays", () => {
        const addedDeps = ["S2"]
        const acceptance = ["S4 works"]
        const added = {
            ...add("S4"),
            dependsOn: addedDeps,
            acceptance,
        }
        const addedStories = [added]
        const removedStoryIds = ["S3"]
        const deps = ["S1"]
        const original = mutation({
            addedStories,
            removedStoryIds,
            modifiedDeps: { S2: deps },
        })
        const snapshot = snapshotRuntimeReplanMutation(original)

        addedDeps.push("S1")
        acceptance.push("late mutation")
        removedStoryIds.push("S2")
        deps.push("S3")

        assert.deepEqual(snapshot, {
            addedStories: [add("S4", ["S2"])],
            removedStoryIds: ["S3"],
            modifiedDeps: { S2: ["S1"] },
        })
    })

    it("rejects malformed and empty proposals", () => {
        expectCode(
            validate(
                prd(),
                { addedStories: "bad" } as unknown as RuntimeReplanMutation,
            ),
            "invalid_proposal",
        )
        expectCode(
            validate(
                prd(),
                {
                    ...mutation({ addedStories: [add("S4")] }),
                    assumedApplied: true,
                } as unknown as RuntimeReplanMutation,
            ),
            "invalid_proposal",
        )
        expectCode(
            validate(
                prd(),
                mutation({
                    addedStories: [
                        {
                            ...add("S4"),
                            hiddenScope: "silently dropped before this fix",
                        } as unknown as RuntimeReplanMutation["addedStories"][number],
                    ],
                }),
            ),
            "invalid_proposal",
        )
        expectCode(validate(prd(), mutation()), "no_op")
    })

    it("rejects dependency rewires that are semantic no-ops", () => {
        expectCode(
            validate(prd(), mutation({ modifiedDeps: { S2: ["S1"] } })),
            "no_op",
        )
    })

    it("rejects duplicate story operations and existing ids", () => {
        const cases: RuntimeReplanMutation[] = [
            mutation({ addedStories: [add("S4"), add("S4")] }),
            mutation({
                addedStories: [add("S4")],
                removedStoryIds: ["S3", "S3"],
            }),
            mutation({
                addedStories: [add("S4")],
                removedStoryIds: ["S3"],
                modifiedDeps: { S3: [] },
            }),
            mutation({ addedStories: [add("S2")] }),
        ]
        for (const value of cases) {
            expectCode(validate(prd(), value), "duplicate_story")
        }
    })

    it("rejects duplicate ids already present in the current PRD", () => {
        const current = prd([story("S1"), story("S1")])
        expectCode(
            validate(current, mutation({ addedStories: [add("S2")] })),
            "duplicate_story",
        )
    })

    it("rejects removal or rewiring of unknown stories", () => {
        expectCode(
            validate(
                prd(),
                mutation({
                    addedStories: [add("S4")],
                    removedStoryIds: ["missing"],
                }),
            ),
            "unknown_story",
        )
        expectCode(
            validate(prd(), mutation({ modifiedDeps: { missing: [] } })),
            "unknown_story",
        )
    })

    it("rejects completed and explicitly immutable story mutations", () => {
        expectCode(
            validate(
                prd(),
                mutation({
                    addedStories: [add("S4")],
                    removedStoryIds: ["S1"],
                }),
            ),
            "immutable_story",
        )
        expectCode(
            validate(
                prd(),
                mutation({ modifiedDeps: { S2: [] } }),
                new Set(["S2"]),
            ),
            "immutable_story",
        )
    })

    it("rejects pure destructive removal", () => {
        expectCode(
            validate(prd(), mutation({ removedStoryIds: ["S3"] })),
            "destructive_removal",
        )
    })

    it("rejects additions beyond the supplied remaining budget", () => {
        expectCode(
            validate(
                prd(),
                mutation({ addedStories: [add("S4"), add("S5")] }),
                [],
                1,
            ),
            "dynamic_story_limit",
        )
    })

    it("rejects duplicate, unknown, and self dependencies", () => {
        expectCode(
            validate(
                prd(),
                mutation({ addedStories: [add("S4", ["S2", "S2"])] }),
            ),
            "duplicate_dependency",
        )
        expectCode(
            validate(
                prd(),
                mutation({ addedStories: [add("S4", ["missing"])] }),
            ),
            "unknown_dependency",
        )
        expectCode(
            validate(
                prd(),
                mutation({ addedStories: [add("S4", ["S4"])] }),
            ),
            "self_dependency",
        )
    })

    it("rejects references to work removed by the same candidate", () => {
        expectCode(
            validate(
                prd(),
                mutation({
                    addedStories: [add("S4")],
                    removedStoryIds: ["S2"],
                }),
            ),
            "unknown_dependency",
        )
    })

    it("rejects dependency cycles without changing the original PRD", () => {
        const current = prd([story("S1"), story("S2", { dependsOn: ["S1"] })])
        const before = structuredClone(current)
        const result = validate(
            current,
            mutation({ modifiedDeps: { S1: ["S2"] } }),
        )

        expectCode(result, "dependency_cycle")
        assert.deepEqual(current, before)
    })
})
