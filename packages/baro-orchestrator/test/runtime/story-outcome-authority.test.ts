import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { Participant } from "../../src/runtime/mozaik.js"

import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"

function source(agentId: string): Participant {
    return { agentId } as unknown as Participant
}

describe("StoryOutcomeAuthority", () => {
    it("source-binds spawn failure to the exact run/story/lease", () => {
        const registry = new StoryOutcomeAuthority("run-1")
        const factory = source("factory")
        const impersonator = source("factory")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
        }

        registry.registerSpawnAuthority(correlation, factory)
        registry.registerSpawnAuthority(correlation, factory)

        assert.equal(registry.matchesSpawnAuthority(factory, correlation), true)
        assert.equal(
            registry.matchesSpawnAuthority(impersonator, correlation),
            false,
        )
        assert.equal(
            registry.matchesSpawnAuthority(factory, {
                ...correlation,
                leaseId: "lease-2",
            }),
            false,
        )
        assert.equal(registry.matchesSpawnFailure(factory, {
            ...correlation,
            error: "failed",
        }), true)
        assert.equal(registry.matchesSpawnFailure(impersonator, {
            ...correlation,
            error: "forged",
        }), false)
        assert.equal(registry.matchesSpawnFailure(factory, {
            ...correlation,
            leaseId: "lease-2",
            error: "stale",
        }), false)
    })

    it("source-binds results to the exact lease generation", () => {
        const registry = new StoryOutcomeAuthority("run-1")
        const worker = source("S1")
        const impersonator = source("S1")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 2,
        }

        registry.registerResultAuthority(correlation, worker)
        registry.registerResultAuthority(correlation, worker)

        const result = {
            ...correlation,
            success: true,
            attempts: 1,
            durationSecs: 1,
            error: null,
        }
        assert.equal(registry.matchesResult(worker, result), true)
        assert.equal(registry.matchesResult(impersonator, result), false)
        assert.equal(registry.matchesResult(worker, {
            ...result,
            generation: 1,
        }), false)
        assert.equal(registry.matchesResult(worker, {
            ...result,
            runId: "run-2",
        }), false)
        assert.equal(registry.matchesResultAuthority(worker, correlation), true)
        assert.equal(
            registry.matchesResultAuthority(impersonator, correlation),
            false,
        )
        assert.equal(
            registry.matchesResultAuthority(worker, {
                ...correlation,
                generation: 1,
            }),
            false,
        )
    })

    it("source-binds terminal turns to the active concrete execution", () => {
        const registry = new StoryOutcomeAuthority("run-1")
        const firstWorker = source("S1")
        const firstCli = source("S1")
        const impersonator = source("S1")
        const first = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }

        assert.throws(
            () => registry.registerTerminalAuthority(first, firstCli),
            /requires registered story result/,
        )
        registry.registerResultAuthority(first, firstWorker)
        registry.registerTerminalAuthority(first, firstCli)

        assert.equal(registry.matchesTerminalTurnSource(firstWorker, "S1"), true)
        assert.equal(registry.matchesTerminalTurnSource(firstCli, "S1"), true)
        assert.equal(registry.matchesTerminalTurnSource(impersonator, "S1"), false)
        assert.equal(registry.matchesTerminalTurnSource(firstCli, "S2"), false)

        const retryCli = source("S1")
        registry.registerTerminalAuthority(first, retryCli)
        assert.equal(registry.matchesTerminalTurnSource(firstCli, "S1"), false)
        assert.equal(registry.matchesTerminalTurnSource(retryCli, "S1"), true)

        const secondWorker = source("S1")
        const second = {
            ...first,
            leaseId: "lease-2",
            generation: 2,
        }
        registry.registerResultAuthority(second, secondWorker)
        assert.equal(registry.matchesTerminalTurnSource(retryCli, "S1"), false)
        assert.equal(registry.matchesTerminalTurnSource(secondWorker, "S1"), true)
        assert.deepEqual(
            registry.terminalCorrelationForSource(secondWorker, "S1"),
            second,
        )
        assert.equal(
            registry.terminalCorrelationForSource(impersonator, "S1"),
            null,
        )

        // A delayed replay of the old registration cannot roll authority back.
        registry.registerResultAuthority(first, firstWorker)
        assert.equal(registry.matchesTerminalTurnSource(retryCli, "S1"), false)
        assert.equal(registry.matchesTerminalTurnSource(secondWorker, "S1"), true)
    })

    it("throws on conflicting identity registration and invalid correlation", () => {
        const registry = new StoryOutcomeAuthority("run-1")
        const first = source("worker")
        const second = source("worker")
        const correlation = {
            runId: "run-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        }

        registry.registerResultAuthority(correlation, first)
        assert.throws(
            () => registry.registerResultAuthority(correlation, second),
            /conflicting authority registration/,
        )
        assert.throws(
            () => registry.registerSpawnAuthority({
                runId: "other-run",
                storyId: "S1",
                leaseId: "lease-1",
            }, first),
            /invalid spawn authority correlation/,
        )
    })
})
