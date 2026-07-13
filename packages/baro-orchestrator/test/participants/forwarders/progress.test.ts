import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ConductorState,
    LevelCompleted,
    Replan,
    ReplanApplied,
    RunStarted,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    StoryMerged,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { ProgressForwarder } from "../../../src/participants/forwarders/progress.js"
import { captureStdout, source } from "../helpers.js"

describe("ProgressForwarder", () => {
    it("reports story progress rather than DAG-level progress", async () => {
        const forwarder = new ProgressForwarder()
        const board = source("board")
        const repository = source("repository")
        forwarder.setRuntimeReplanAuthority(board)
        forwarder.setRepositoryAuthority(repository)
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("forged-board"),
                RunStarted.create({
                    project: "forged",
                    storyCount: 999,
                    coordinationMode: "collective",
                }),
            )
            await forwarder.onExternalEvent(
                board,
                RunStarted.create({
                    project: "p",
                    storyCount: 14,
                    storyIds: Array.from({ length: 14 }, (_, index) => `S${index + 1}`),
                    coordinationMode: "collective",
                }),
            )
            await forwarder.onExternalEvent(
                source("conductor"),
                ConductorState.create({
                    phase: "running_level",
                    currentLevel: 1,
                    totalLevels: 3,
                    storyIds: ["S1", "S2"],
                }),
            )
            await forwarder.onExternalEvent(
                source("forged-repository"),
                StoryMerged.create({ storyId: "S1", mode: "worktree" }),
            )
            await forwarder.onExternalEvent(
                repository,
                StoryMerged.create({ storyId: "S1", mode: "worktree" }),
            )
            // A duplicate integration event cannot advance progress twice.
            await forwarder.onExternalEvent(
                repository,
                StoryMerged.create({ storyId: "S1", mode: "worktree" }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            { type: "progress", completed: 0, total: 14, percentage: 0 },
            { type: "progress", completed: 1, total: 14, percentage: 7 },
        ])
    })

    it("requires repository integration in collective mode and adjusts runtime totals", async () => {
        const forwarder = new ProgressForwarder()
        const board = source("board")
        const repository = source("repository")
        forwarder.setRuntimeReplanAuthority(board)
        forwarder.setRepositoryAuthority(repository)
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                board,
                RunStarted.create({
                    project: "p",
                    storyCount: 2,
                    coordinationMode: "collective",
                }),
            )
            await forwarder.onExternalEvent(
                board,
                RuntimeReplanApplied.create({
                    runId: "run-1",
                    proposalId: "p-1",
                    sourceStoryId: "S1",
                    leaseId: "lease-1",
                    generation: 1,
                    baseGraphVersion: 1,
                    previousGraphVersion: 1,
                    graphVersion: 2,
                    currentGraphVersion: 2,
                    reason: "replace remaining work",
                    mutation: {
                        addedStories: [{
                            id: "S3",
                            priority: 1,
                            title: "replacement",
                            description: "replacement",
                            dependsOn: ["S1"],
                            acceptance: ["The replacement works."],
                            tests: ["npm test"],
                        }],
                        removedStoryIds: ["S2"],
                        modifiedDeps: {},
                    },
                }),
            )
            await forwarder.onExternalEvent(
                repository,
                StoryMerged.create({ storyId: "S1", mode: "worktree" }),
            )
        })

        const progress = lines
            .map((line) => JSON.parse(line) as BaroEvent)
            .filter((event) => event.type === "progress")
        assert.deepEqual(progress, [
            { type: "progress", completed: 0, total: 2, percentage: 0 },
            { type: "progress", completed: 0, total: 2, percentage: 0 },
            { type: "progress", completed: 1, total: 2, percentage: 50 },
        ])
    })

    it("starts resumed progress from persisted passes and only adjusts legacy totals after apply", async () => {
        const forwarder = new ProgressForwarder()
        const conductor = source("conductor")
        forwarder.setLegacyReplanAuthority(conductor)
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                conductor,
                RunStarted.create({
                    project: "p",
                    storyCount: 3,
                    storyIds: ["S1", "S2", "S3"],
                    completedStoryIds: ["S1"],
                    coordinationMode: "legacy",
                }),
            )
            const proposal = {
                source: "surgeon",
                reason: "replace future work",
                addedStories: [
                    {
                        id: "S4",
                        priority: 1,
                        title: "replacement",
                        description: "replacement",
                        dependsOn: ["S1"],
                        acceptance: ["The replacement works."],
                        tests: ["npm test"],
                    },
                    {
                        id: "S1",
                        priority: 1,
                        title: "duplicate persisted pass",
                        description: "ignored by persistence",
                        dependsOn: [],
                        acceptance: ["The duplicate work works."],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: ["S3", "S1"],
                modifiedDeps: { "S-missing": [] },
            }
            const effective = {
                ...proposal,
                addedStories: [proposal.addedStories[0]!],
                removedStoryIds: ["S3"],
                modifiedDeps: {},
            }
            await forwarder.onExternalEvent(
                source("surgeon"),
                Replan.create(proposal),
            )
            await forwarder.onExternalEvent(
                source("forged-conductor"),
                ReplanApplied.create(proposal),
            )
            await forwarder.onExternalEvent(
                conductor,
                ReplanApplied.create(effective),
            )
            await forwarder.onExternalEvent(
                source("forged-conductor"),
                LevelCompleted.create({
                    ordinal: 1,
                    passed: ["S2"],
                    failed: [],
                }),
            )
            await forwarder.onExternalEvent(
                conductor,
                LevelCompleted.create({
                    ordinal: 1,
                    passed: ["S2"],
                    failed: [],
                }),
            )
        })

        const progress = lines
            .map((line) => JSON.parse(line) as BaroEvent)
            .filter((event) => event.type === "progress")
        assert.deepEqual(progress, [
            { type: "progress", completed: 1, total: 3, percentage: 33 },
            { type: "progress", completed: 1, total: 3, percentage: 33 },
            { type: "progress", completed: 2, total: 3, percentage: 67 },
        ])
    })

    it("emits progress BaroEvents for running conductor levels", async () => {
        const forwarder = new ProgressForwarder()
        const conductor = source("conductor")
        forwarder.setLegacyReplanAuthority(conductor)
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                conductor,
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
        const conductor = source("conductor")
        forwarder.setLegacyReplanAuthority(conductor)
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                conductor,
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
                        priority: 1,
                        title: "Validate implementation",
                        description: "Run focused checks",
                        dependsOn: ["active"],
                        acceptance: ["Focused checks pass"],
                        tests: ["npm test"],
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
