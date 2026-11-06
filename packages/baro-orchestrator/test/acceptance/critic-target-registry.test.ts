import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    CriticTargetRegistry,
    buildCriticTargets,
} from "../../src/acceptance/critic-target-registry.js"
import {
    Replan,
    RuntimeReplanApplied,
} from "../../src/semantic-events.js"
import { source } from "../execution/helpers.js"

describe("CriticTargetRegistry runtime replans", () => {
    it("delivers canonical Architect obligations to the collective Critic unchanged", () => {
        const obligation =
            "[O-004]; Subject: direct public adapter boundary; Scenario: the adapter is invoked without its outer wrapper; Required outcome: the contract remains independently observable; Required evidence: focused direct-boundary regression test"
        const targets = buildCriticTargets([{
            id: "S-provider",
            acceptance: [obligation, "The provider preserves its request fields"],
            goalInvariantIds: ["G-A1", "G-C1"],
        }])

        assert.deepEqual(targets.get("S-provider"), [
            obligation,
            "The provider preserves its request fields",
        ])
    })

    it("keeps critic targets local to each story", () => {
        const crossProviderInvariantId = "G-A6"
        const stories = [
            {
                id: "S-openai-responses",
                acceptance: ["OpenAI Responses receives the exact AbortSignal"],
                goalInvariantIds: [crossProviderInvariantId],
            },
            {
                id: "S-openai-chat",
                acceptance: ["Chat Completions receives the exact AbortSignal"],
                goalInvariantIds: [crossProviderInvariantId],
            },
            {
                id: "S-anthropic",
                acceptance: ["Anthropic Messages receives the exact AbortSignal"],
                goalInvariantIds: [crossProviderInvariantId],
            },
            {
                id: "S-gemini",
                acceptance: ["Gemini config preserves fields and adds abortSignal"],
                goalInvariantIds: [crossProviderInvariantId],
            },
        ]

        const collectiveTargets = buildCriticTargets(stories)

        for (const story of stories) {
            assert.deepEqual(collectiveTargets.get(story.id), story.acceptance)
            assert.equal(
                collectiveTargets.get(story.id)?.some((criterion) =>
                    criterion.includes(crossProviderInvariantId),
                ),
                false,
            )
            assert.deepEqual(story.goalInvariantIds, [crossProviderInvariantId])
        }
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
                        goalInvariantIds: ["G-CROSS-STORY"],
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
            ...event.payload,
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
                ...event.payload,
                currentGraphVersion: 3,
            }),
        )
        assert.equal(targets.has("S-new"), false)
    })
})
