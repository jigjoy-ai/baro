import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ConductorState,
    Replan,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { ProgressForwarder } from "../../../src/participants/forwarders/progress.js"
import { captureStdout, source } from "../helpers.js"

describe("ProgressForwarder", () => {
    it("emits progress BaroEvents for running conductor levels", async () => {
        const forwarder = new ProgressForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("conductor"),
                ConductorState.create({
                    phase: "running_level",
                    currentLevel: 3,
                    totalLevels: 5,
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            { type: "progress", completed: 2, total: 5, percentage: 40 },
        ])
    })

    it("emits zero-percent progress for the first running level", async () => {
        const forwarder = new ProgressForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("conductor"),
                ConductorState.create({
                    phase: "running_level",
                    currentLevel: 1,
                    totalLevels: 4,
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            { type: "progress", completed: 0, total: 4, percentage: 0 },
        ])
    })

    it("reports only the Board decision for a rejected collective replan", async () => {
        const forwarder = new ProgressForwarder()
        const board = source("board")
        forwarder.setRuntimeReplanAuthority(board)

        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "try a different shape",
                    addedStories: [],
                    removedStoryIds: ["future"],
                    modifiedDeps: {},
                }),
            )
            await forwarder.onExternalEvent(
                board,
                RuntimeReplanRejected.create({
                    runId: "run-1",
                    proposalId: "proposal-1",
                    sourceStoryId: "active",
                    leaseId: "lease-1",
                    generation: 1,
                    baseGraphVersion: 3,
                    currentGraphVersion: 4,
                    code: "stale_graph_version",
                    reason: "graph advanced before the proposal committed",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            {
                type: "activity",
                id: "plan",
                kind: "warn",
                text: "Replan rejected (agent:active, stale_graph_version): graph advanced before the proposal committed",
            },
        ])
    })

    it("reports an authoritative applied collective replan once", async () => {
        const forwarder = new ProgressForwarder()
        const board = source("board")
        forwarder.setRuntimeReplanAuthority(board)
        const applied = RuntimeReplanApplied.create({
            runId: "run-1",
            proposalId: "proposal-2",
            sourceStoryId: "active",
            leaseId: "lease-1",
            generation: 1,
            baseGraphVersion: 4,
            previousGraphVersion: 4,
            graphVersion: 5,
            currentGraphVersion: 5,
            reason: "split validation from implementation",
            mutation: {
                addedStories: [
                    {
                        id: "validate",
                        title: "Validate implementation",
                        description: "Run focused checks",
                        acceptanceCriteria: ["Focused checks pass"],
                        dependsOn: ["active"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            },
        })

        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(board, applied)
            await forwarder.onExternalEvent(board, applied)
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            {
                type: "activity",
                id: "plan",
                kind: "warn",
                text: "Replanned (agent:active@graph-v5): +1/-0 — split validation from implementation",
            },
        ])
    })
})
