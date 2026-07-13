import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { CriticTargetRegistry } from "../../src/participants/critic-target-registry.js"
import {
    Replan,
    ReplanApplied,
    RuntimeReplanApplied,
} from "../../src/semantic-events.js"
import { source } from "./helpers.js"

describe("CriticTargetRegistry runtime replans", () => {
    it("projects only the Conductor's effective persisted legacy delta", async () => {
        const targets = new Map<string, readonly string[]>([["S-old", ["old"]]])
        const registry = new CriticTargetRegistry(targets)
        const conductor = source("conductor")
        registry.setLegacyReplanAuthority(conductor)
        const mutation = {
            source: "surgeon",
            reason: "replacement",
            addedStories: [
                {
                    id: "S-new",
                    priority: 1,
                    title: "new",
                    description: "new",
                    dependsOn: [],
                    acceptance: ["new criterion"],
                    tests: ["npm test"],
                },
                {
                    id: "S-old",
                    priority: 1,
                    title: "duplicate persisted pass",
                    description: "ignored by persistence",
                    dependsOn: [],
                    acceptance: ["must not replace old criterion"],
                    tests: ["npm test"],
                },
            ],
            removedStoryIds: ["S-old", "S-missing"],
            modifiedDeps: { "S-missing": [] },
        }
        const effective = {
            ...mutation,
            addedStories: [mutation.addedStories[0]!],
            removedStoryIds: [],
            modifiedDeps: {},
        }

        await registry.onExternalEvent(source("surgeon"), Replan.create(mutation))
        assert.deepEqual(targets.get("S-old"), ["old"])
        assert.equal(targets.has("S-new"), false)

        await registry.onExternalEvent(
            source("forged-conductor"),
            ReplanApplied.create(mutation),
        )
        assert.deepEqual(targets.get("S-old"), ["old"])
        assert.equal(targets.has("S-new"), false)

        await registry.onExternalEvent(
            conductor,
            ReplanApplied.create(effective),
        )
        assert.deepEqual(targets.get("S-old"), ["old"])
        assert.deepEqual(targets.get("S-new"), ["new criterion"])
    })

    it("updates acceptance targets only after an authoritative Applied event", async () => {
        const targets = new Map<string, readonly string[]>([
            ["S-old", ["old criterion"]],
        ])
        const registry = new CriticTargetRegistry(targets)
        const board = source("board")
        registry.setRuntimeReplanAuthority(board)

        await registry.onExternalEvent(
            source("surgeon"),
            Replan.create({
                source: "surgeon",
                reason: "uncommitted proposal",
                addedStories: [
                    {
                        id: "S-phantom",
                        priority: 1,
                        title: "Phantom",
                        description: "Must not affect collective targets.",
                        dependsOn: [],
                        acceptance: ["phantom criterion"],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            }),
        )
        assert.equal(targets.has("S-phantom"), false)

        const event = RuntimeReplanApplied.create({
            runId: "run-1",
            proposalId: "proposal-1",
            sourceStoryId: "S1",
            leaseId: "lease-1",
            generation: 1,
            baseGraphVersion: 1,
            previousGraphVersion: 1,
            graphVersion: 2,
            reason: "replace future work",
            mutation: {
                addedStories: [
                    {
                        id: "S-new",
                        priority: 2,
                        title: "New",
                        description: "New work.",
                        dependsOn: ["S1"],
                        acceptance: ["new criterion"],
                        tests: ["npm test"],
                    },
                ],
                removedStoryIds: ["S-old"],
                modifiedDeps: {},
            },
        })

        await registry.onExternalEvent(source("forged-board"), event)
        assert.deepEqual(targets.get("S-old"), ["old criterion"])
        assert.equal(targets.has("S-new"), false)

        await registry.onExternalEvent(
            board,
            event,
        )

        assert.equal(targets.has("S-old"), false)
        assert.deepEqual(targets.get("S-new"), ["new criterion"])

        const remove = RuntimeReplanApplied.create({
            ...event.data,
            proposalId: "proposal-2",
            baseGraphVersion: 2,
            previousGraphVersion: 2,
            graphVersion: 3,
            currentGraphVersion: 3,
            reason: "remove replaced future work",
            mutation: {
                addedStories: [],
                removedStoryIds: ["S-new"],
                modifiedDeps: {},
            },
        })
        await registry.onExternalEvent(board, remove)
        assert.equal(targets.has("S-new"), false)

        await registry.onExternalEvent(
            board,
            RuntimeReplanApplied.create({
                ...event.data,
                currentGraphVersion: 3,
            }),
        )
        assert.equal(targets.has("S-new"), false)
    })
})
