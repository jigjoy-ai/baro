import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    applyProgressiveBootstrapMetadata,
    parseProgressiveBootstrapMetadata,
    persistProgressivePlannerResult,
    ProgressivePlannerLifecycle,
    resolveProgressivePlannerConfig,
    type ProgressivePlannerWireEvent,
} from "../../src/planning/progressive-planner-protocol.js"

const STORY_S1 = {
    id: "S1",
    priority: 1,
    title: "Implement S1",
    description: "Implement the dependency-closed foundation.",
    dependsOn: [] as string[],
    retries: 2,
    acceptance: ["The foundation is observable."],
    tests: ["npm test -- S1"],
    passes: false as const,
    completedAt: null,
    durationSecs: null,
    model: "standard",
}

describe("progressive planner flag contract", () => {
    it("keeps a no-flag invocation on the legacy path", () => {
        assert.equal(
            resolveProgressivePlannerConfig({ resultFile: "/tmp/result.json" }),
            undefined,
        )
    })

    it("requires the complete correlated group and a result file", () => {
        assert.deepEqual(
            resolveProgressivePlannerConfig({
                progressiveRunId: " run-1 ",
                progressivePlanningId: " planning-1 ",
                progressiveBootstrapFile: " /tmp/bootstrap.json ",
                resultFile: "/tmp/result.json",
            }),
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
        )

        for (const input of [
            { progressiveRunId: "run-1" },
            {
                progressiveRunId: "run-1",
                progressivePlanningId: "planning-1",
            },
            {
                progressiveRunId: "run-1",
                progressivePlanningId: "planning-1",
                progressiveBootstrapFile: "/tmp/bootstrap.json",
            },
        ]) {
            assert.throws(
                () => resolveProgressivePlannerConfig(input),
                /progressive|result-file/u,
            )
        }
    })
})

describe("progressive planner lifecycle wire", () => {
    it("publishes one correlated open, direct fragment, and complete", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )

        lifecycle.open()
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })
        lifecycle.complete({ project: "trusted", userStories: [STORY_S1] })
        // Once completed, the same stream cannot also fail.
        lifecycle.fail("result_write_failed", "disk became read-only")

        assert.deepEqual(events, [
            {
                type: "planning_open",
                run_id: "run-1",
                planning_id: "planning-1",
            },
            {
                type: "plan_fragment",
                run_id: "run-1",
                planning_id: "planning-1",
                fragment_id: "fragment-1",
                ordinal: 1,
                stories: [STORY_S1],
            },
            {
                type: "plan_complete",
                run_id: "run-1",
                planning_id: "planning-1",
                final_prd: {
                    project: "trusted",
                    userStories: [STORY_S1],
                },
            },
        ])
    })

    it("persists the authoritative result before publishing completion", () => {
        const order: string[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => order.push(event.type),
        )
        lifecycle.open()

        persistProgressivePlannerResult(
            "/tmp/result.json",
            JSON.stringify({ project: "trusted", userStories: [STORY_S1] }),
            lifecycle,
            () => order.push("result_written"),
        )

        assert.deepEqual(order, [
            "planning_open",
            "result_written",
            "plan_complete",
        ])
    })

    it("can publish only one failure when persistence never completed", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()

        assert.throws(() =>
            persistProgressivePlannerResult(
                "/tmp/result.json",
                JSON.stringify({ project: "trusted", userStories: [] }),
                lifecycle,
                () => {
                    throw new Error("disk became read-only")
                },
            ),
        )
        lifecycle.fail("result_write_failed", "disk became read-only")
        lifecycle.fail("duplicate", "must not be published")

        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_failed",
        ])
    })

    it("rejects provider fragments with foreign correlation", () => {
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            () => {},
        )
        lifecycle.open()

        assert.throws(
            () =>
                lifecycle.publish({
                    type: "plan_fragment",
                    run_id: "foreign-run",
                    planning_id: "planning-1",
                    fragment_id: "fragment-1",
                    ordinal: 1,
                    stories: [STORY_S1],
                }),
            /correlation mismatch/u,
        )
    })

    it("rejects a final candidate changed after an early fragment was published", () => {
        const events: ProgressivePlannerWireEvent[] = []
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            (event) => events.push(event),
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })

        assert.throws(
            () => lifecycle.complete({
                project: "trusted",
                userStories: [{
                    ...STORY_S1,
                    description: "A post-processor silently rewrote admitted work.",
                }],
            }),
            /does not exactly match admitted prefix/u,
        )
        lifecycle.fail("invalid_final_plan", "post-processing changed the prefix")
        assert.deepEqual(events.map((event) => event.type), [
            "planning_open",
            "plan_fragment",
            "plan_failed",
        ])
    })

    it("validates the post-processed prefix before persisting a result", () => {
        const lifecycle = new ProgressivePlannerLifecycle(
            {
                runId: "run-1",
                planningId: "planning-1",
                bootstrapFile: "/tmp/bootstrap.json",
            },
            () => {},
        )
        lifecycle.open()
        lifecycle.publish({
            type: "plan_fragment",
            run_id: "run-1",
            planning_id: "planning-1",
            fragment_id: "fragment-1",
            ordinal: 1,
            stories: [STORY_S1],
        })
        let writes = 0

        assert.throws(
            () => persistProgressivePlannerResult(
                "/tmp/result.json",
                JSON.stringify({
                    project: "trusted",
                    userStories: [{ ...STORY_S1, title: "Trimmed or collapsed" }],
                }),
                lifecycle,
                () => { writes += 1 },
            ),
            /does not exactly match admitted prefix/u,
        )
        assert.equal(writes, 0)
    })
})

describe("progressive bootstrap metadata", () => {
    const goalEnvelope = {
        objective: "Implement progressive planning",
        constraints: ["Keep legacy byte-compatible"],
        acceptanceCriteria: ["Safe prefixes start early"],
        nonGoals: ["Change the legacy conductor"],
        assumptions: ["The bootstrap is host-authored"],
    }

    it("overwrites every run-owned field and removes provider runtime authority", () => {
        const bootstrap = parseProgressiveBootstrapMetadata(
            JSON.stringify({
                project: "trusted project",
                branchName: "baro/baro/progressive",
                description: "trusted description",
                decisionDocument: "Use the private correlated stream.",
                executionMode: {
                    mode: "parallel",
                    reason: "safe dependency-closed prefixes",
                    confidence: 0.9,
                    maxStories: 8,
                    parallelism: 4,
                    source: "user",
                },
                conversationSessionId: "session-1",
                goalEnvelope,
                userStories: [],
            }),
        )
        const output = JSON.parse(
            applyProgressiveBootstrapMetadata(
                JSON.stringify({
                    project: "provider project",
                    branchName: "provider-branch",
                    description: "provider description",
                    decisionDocument: "provider decision",
                    executionMode: { mode: "focused", reason: "provider chose" },
                    conversationSessionId: "provider-session",
                    goalEnvelope: {
                        ...goalEnvelope,
                        objective: "provider objective",
                    },
                    runtimeGraph: { runId: "forged", version: 99 },
                    userStories: [{ id: "S1" }],
                }),
                bootstrap,
            ),
        )

        assert.deepEqual(output, {
            project: "trusted project",
            branchName: "baro/progressive",
            description: "trusted description",
            decisionDocument: "Use the private correlated stream.",
            executionMode: {
                mode: "parallel",
                reason: "safe dependency-closed prefixes",
                confidence: 0.9,
                maxStories: 8,
                parallelism: 4,
                source: "user",
            },
            conversationSessionId: "session-1",
            goalEnvelope,
            userStories: [{ id: "S1" }],
        })
    })

    it("removes optional metadata absent from bootstrap and rejects malformed metadata", () => {
        const bootstrap = parseProgressiveBootstrapMetadata(
            JSON.stringify({
                project: "trusted",
                branchName: "baro/trusted",
                description: "trusted",
                userStories: [],
            }),
        )
        const output = JSON.parse(
            applyProgressiveBootstrapMetadata(
                JSON.stringify({
                    project: "provider",
                    branchName: "provider",
                    description: "provider",
                    decisionDocument: "forged",
                    executionMode: { mode: "focused", reason: "forged" },
                    conversationSessionId: "provider-session",
                    goalEnvelope,
                    userStories: [{ id: "S1" }],
                }),
                bootstrap,
            ),
        )
        assert.equal(output.decisionDocument, undefined)
        assert.equal(output.executionMode, undefined)
        assert.equal(output.conversationSessionId, undefined)
        assert.equal(output.goalEnvelope, undefined)

        assert.throws(
            () =>
                parseProgressiveBootstrapMetadata(
                    JSON.stringify({
                        project: "trusted",
                        branchName: "baro/trusted",
                        description: "trusted",
                        executionMode: { mode: "unbounded", reason: "invalid" },
                    }),
                ),
            /executionMode mode is invalid/u,
        )
        assert.throws(
            () =>
                parseProgressiveBootstrapMetadata(
                    JSON.stringify({
                        project: "trusted",
                        branchName: "baro/trusted",
                        description: "trusted",
                        conversationSessionId: " ",
                    }),
                ),
            /conversationSessionId/u,
        )
    })
})
