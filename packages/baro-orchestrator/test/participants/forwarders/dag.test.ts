import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    LevelCompleted,
    LevelStarted,
    RecoveryStarted,
    Replan,
    RuntimeReplanApplied,
} from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { DagForwarder } from "../../../src/participants/forwarders/dag.js"
import { captureStdout, source } from "../helpers.js"

function parseEvents(lines: string[]): BaroEvent[] {
    return lines.map((line) => JSON.parse(line) as BaroEvent)
}

describe("DagForwarder", () => {
    it("emits a structured replan BaroEvent with added/removed/rewired", async () => {
        const forwarder = new DagForwarder()
        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "S2 too large",
                    addedStories: [
                        {
                            id: "S2a",
                            priority: 2,
                            title: "First half of S2",
                            description: "Split from S2.",
                            dependsOn: ["S1"],
                        },
                    ],
                    removedStoryIds: ["S2"],
                    modifiedDeps: { S3: ["S2a"] },
                }),
            )
        }))

        assert.deepEqual(events, [
            {
                type: "replan",
                source: "surgeon",
                reason: "S2 too large",
                added: [{ id: "S2a", title: "First half of S2", depends_on: ["S1"] }],
                removed: ["S2"],
                rewired: [{ id: "S3", depends_on: ["S2a"] }],
            },
        ])
    })

    it("emits level_started, level_completed, and recovery_started", async () => {
        const forwarder = new DagForwarder()
        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("conductor"),
                LevelStarted.create({
                    ordinal: 1,
                    totalLevelsHint: 3,
                    storyIds: ["S1", "S2"],
                }),
            )
            await forwarder.onExternalEvent(
                source("conductor"),
                LevelCompleted.create({
                    ordinal: 1,
                    passed: ["S1"],
                    failed: ["S2"],
                }),
            )
            await forwarder.onExternalEvent(
                source("conductor"),
                RecoveryStarted.create({ attempt: 1, storyIds: ["S2"] }),
            )
        }))

        assert.deepEqual(events, [
            { type: "level_started", ordinal: 1, story_ids: ["S1", "S2"] },
            { type: "level_completed", ordinal: 1, passed: ["S1"], failed: ["S2"] },
            { type: "recovery_started", attempt: 1, story_ids: ["S2"] },
        ])
    })

    it("forwards only an authoritative runtime Applied decision as a replan", async () => {
        const forwarder = new DagForwarder()
        const board = source("board")
        forwarder.setRuntimeReplanAuthority(board)
        const applied = RuntimeReplanApplied.create({
            runId: "run-1",
            proposalId: "proposal-1",
            sourceStoryId: "S1",
            leaseId: "lease-1",
            generation: 1,
            baseGraphVersion: 1,
            previousGraphVersion: 1,
            graphVersion: 2,
            currentGraphVersion: 2,
            reason: "discovered follow-up",
            mutation: {
                addedStories: [
                    {
                        id: "S2",
                        priority: 2,
                        title: "Follow-up",
                        description: "Implement it.",
                        dependsOn: ["S1"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            },
        })
        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("surgeon"),
                Replan.create({
                    source: "surgeon",
                    reason: "uncommitted collective proposal",
                    addedStories: [],
                    removedStoryIds: ["S-never"],
                    modifiedDeps: {},
                }),
            )
            await forwarder.onExternalEvent(
                source("forged-board"),
                applied,
            )
            await forwarder.onExternalEvent(board, applied)
            await forwarder.onExternalEvent(board, applied)
        }))

        assert.deepEqual(events, [
            {
                type: "replan",
                source: "agent:S1@graph-v2",
                reason: "discovered follow-up",
                added: [
                    {
                        id: "S2",
                        title: "Follow-up",
                        depends_on: ["S1"],
                    },
                ],
                removed: [],
                rewired: [],
            },
        ])
    })

    it("does not project a historical Applied replay over a newer durable graph", async () => {
        const forwarder = new DagForwarder()
        const board = source("board")
        forwarder.setRuntimeReplanAuthority(board)
        const historical = RuntimeReplanApplied.create({
            runId: "run-1",
            proposalId: "proposal-v2",
            sourceStoryId: "S1",
            leaseId: "lease-1",
            generation: 1,
            baseGraphVersion: 1,
            previousGraphVersion: 1,
            graphVersion: 2,
            currentGraphVersion: 3,
            reason: "historical replay",
            mutation: {
                addedStories: [],
                removedStoryIds: [],
                modifiedDeps: { S3: ["S1"] },
            },
        })
        const current = RuntimeReplanApplied.create({
            ...historical.data,
            proposalId: "proposal-v3",
            baseGraphVersion: 2,
            previousGraphVersion: 2,
            graphVersion: 3,
            currentGraphVersion: 3,
            reason: "current durable decision",
            mutation: {
                addedStories: [],
                removedStoryIds: [],
                modifiedDeps: { S3: ["S2"] },
            },
        })

        const events = parseEvents(await captureStdout(async () => {
            await forwarder.onExternalEvent(board, historical)
            await forwarder.onExternalEvent(board, current)
        }))

        assert.deepEqual(events, [
            {
                type: "replan",
                source: "agent:S1@graph-v3",
                reason: "current durable decision",
                added: [],
                removed: [],
                rewired: [{ id: "S3", depends_on: ["S2"] }],
            },
        ])
    })
})
