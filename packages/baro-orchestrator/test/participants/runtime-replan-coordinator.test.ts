import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { RuntimeReplanCoordinator } from "../../src/participants/runtime-replan-coordinator.js"
import type { PrdFile } from "../../src/prd.js"
import {
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    type RuntimeReplanProposedData,
} from "../../src/semantic-events.js"

describe("RuntimeReplanCoordinator", () => {
    it("persists before Applied and replays an identical proposal without a second write", () => {
        const writes: PrdFile[] = []
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: (_path, value) => writes.push(structuredClone(value)),
        })
        coordinator.start(initialPrd())
        const proposal = addProposal()
        const state = decisionState()

        const first = coordinator.decide(proposal, state)
        assert.ok(RuntimeReplanApplied.is(first.event))
        assert.equal(first.applied?.prd.userStories.length, 2)
        assert.equal(coordinator.graphVersion, 2)
        assert.equal(writes.length, 1)

        const replay = coordinator.decide(structuredClone(proposal), state)
        assert.ok(RuntimeReplanApplied.is(replay.event))
        assert.equal(replay.applied, undefined)
        assert.notEqual(replay.event, first.event)
        assert.deepEqual(replay.event.data, first.event.data)
        assert.equal(coordinator.graphVersion, 2)
        assert.equal(writes.length, 1)

        const secondProposal = addSecondProposal()
        const second = coordinator.decide(
            secondProposal,
            decisionState(first.applied!.prd),
        )
        assert.ok(RuntimeReplanApplied.is(second.event))
        assert.equal(coordinator.graphVersion, 3)
        assert.equal(writes.length, 2)

        const oldReplay = coordinator.decide(
            structuredClone(proposal),
            decisionState(second.applied!.prd),
        )
        assert.ok(RuntimeReplanApplied.is(oldReplay.event))
        if (RuntimeReplanApplied.is(oldReplay.event)) {
            assert.equal(oldReplay.event.data.graphVersion, 2)
            assert.equal(oldReplay.event.data.currentGraphVersion, 3)
        }
        assert.equal(writes.length, 2)

        const conflict = coordinator.decide(
            { ...proposal, reason: "different content" },
            state,
        )
        assert.ok(RuntimeReplanRejected.is(conflict.event))
        if (RuntimeReplanRejected.is(conflict.event)) {
            assert.equal(conflict.event.data.code, "proposal_id_conflict")
            assert.equal(conflict.event.data.currentGraphVersion, 3)
        }
        assert.equal(writes.length, 2)
        assert.deepEqual(writes[1]?.runtimeGraph, {
            runId: "run-1",
            version: 3,
            dynamicStories: 2,
            policyStories: 0,
            appliedDecisions: [
                {
                    fingerprint:
                        writes[1]!.runtimeGraph!.appliedDecisions[0]!.fingerprint,
                    applied: first.event.data,
                },
                {
                    fingerprint:
                        writes[1]!.runtimeGraph!.appliedDecisions[1]!.fingerprint,
                    applied: second.event.data,
                },
            ],
        })
    })

    it("restores durable graph state and same-run idempotency after restart", () => {
        let durable = initialPrd()
        let writes = 0
        const createCoordinator = (runId: string, maxDynamicStories = 3) =>
            new RuntimeReplanCoordinator({
                runId,
                prdPath: "/unused/prd.json",
                maxDynamicStories,
                adaptationBudget: 3,
                persist: (_path, value) => {
                    writes += 1
                    durable = structuredClone(value)
                },
            })

        const firstProcess = createCoordinator("run-1")
        firstProcess.start(durable)
        const proposal = addProposal()
        const applied = firstProcess.decide(proposal, decisionState(durable))
        assert.ok(RuntimeReplanApplied.is(applied.event))
        assert.equal(writes, 1)

        const restarted = createCoordinator("run-1")
        restarted.start(durable)
        assert.equal(restarted.graphVersion, 2)
        const replay = restarted.decide(proposal, decisionState(durable))
        assert.ok(RuntimeReplanApplied.is(replay.event))
        assert.equal(replay.applied, undefined)
        assert.equal(replay.event.data.graphVersion, 2)
        assert.equal(replay.event.data.currentGraphVersion, 2)
        assert.equal(writes, 1)

        const nextRun = createCoordinator("run-2", 1)
        nextRun.start(durable)
        assert.equal(nextRun.graphVersion, 2)
        const nextRunProposal: RuntimeReplanProposedData = {
            ...addSecondProposal(),
            runId: "run-2",
            proposalId: proposal.proposalId,
            baseGraphVersion: 2,
        }
        const nextRunOutcome = nextRun.decide(
            nextRunProposal,
            decisionState(durable),
        )
        assert.ok(RuntimeReplanApplied.is(nextRunOutcome.event))
        assert.equal(nextRun.graphVersion, 3)
        assert.equal(writes, 2)
    })

    it("persists policy replans and accounts for them outside the worker discovery budget", () => {
        let durable = initialPrd()
        let writes = 0
        const createCoordinator = () =>
            new RuntimeReplanCoordinator({
                runId: "run-1",
                prdPath: "/unused/prd.json",
                maxDynamicStories: 1,
                adaptationBudget: 3,
                persist: (_path, value) => {
                    writes += 1
                    durable = structuredClone(value)
                },
            })

        const first = createCoordinator()
        first.start(durable)
        const proposal = addProposal()
        const outcome = first.decide(proposal, {
            ...decisionState(durable),
            requireActiveLease: false,
            activeLease: undefined,
            storyAccounting: "policy",
            maxAddedStories: 1,
        })
        assert.ok(RuntimeReplanApplied.is(outcome.event))
        assert.equal(durable.runtimeGraph?.dynamicStories, 0)
        assert.equal(durable.runtimeGraph?.policyStories, 1)
        assert.equal(durable.runtimeGraph?.appliedDecisions.length, 1)
        assert.equal(writes, 1)

        const restarted = createCoordinator()
        restarted.start(durable)
        const replay = restarted.decide(proposal, {
            ...decisionState(durable),
            requireActiveLease: false,
            activeLease: undefined,
            storyAccounting: "policy",
            maxAddedStories: 1,
        })
        assert.ok(RuntimeReplanApplied.is(replay.event))
        assert.equal(replay.applied, undefined)
        assert.equal(writes, 1)

        const worker = restarted.decide(
            addSecondProposal(),
            decisionState(durable),
        )
        assert.ok(RuntimeReplanApplied.is(worker.event))
        assert.equal(durable.runtimeGraph?.dynamicStories, 1)
        assert.equal(durable.runtimeGraph?.policyStories, 1)
        assert.equal(writes, 2)

        const overBudget = restarted.decide(
            {
                ...addSecondProposal(),
                proposalId: "proposal-over-worker-budget",
                baseGraphVersion: 3,
                mutation: {
                    addedStories: [{
                        id: "S4",
                        priority: 4,
                        title: "Over budget",
                        description: "This worker story must be rejected.",
                        dependsOn: ["S3"],
                        acceptance: ["The over-budget follow-up is implemented."],
                        tests: ["npm test"],
                    }],
                    removedStoryIds: [],
                    modifiedDeps: {},
                },
            },
            decisionState(durable),
        )
        assert.ok(RuntimeReplanRejected.is(overBudget.event))
        assert.equal(writes, 2)
    })

    it("refuses mismatched and duplicate durable replay identities", () => {
        let durable = initialPrd()
        const createCoordinator = () =>
            new RuntimeReplanCoordinator({
                runId: "run-1",
                prdPath: "/unused/prd.json",
                maxDynamicStories: 3,
                adaptationBudget: 3,
                persist: (_path, value) => {
                    durable = structuredClone(value)
                },
            })
        const first = createCoordinator()
        first.start(durable)
        const proposal = addProposal()
        const applied = first.decide(proposal, decisionState(durable))
        assert.ok(RuntimeReplanApplied.is(applied.event))
        assert.equal(durable.runtimeGraph?.appliedDecisions.length, 1)

        const validDecision = durable.runtimeGraph!.appliedDecisions[0]!
        const mismatched: PrdFile = {
            ...structuredClone(durable),
            runtimeGraph: {
                ...structuredClone(durable.runtimeGraph!),
                appliedDecisions: [
                    { ...structuredClone(validDecision), fingerprint: "wrong" },
                ],
            },
        }
        const duplicate: PrdFile = {
            ...structuredClone(durable),
            runtimeGraph: {
                ...structuredClone(durable.runtimeGraph!),
                appliedDecisions: [
                    structuredClone(validDecision),
                    structuredClone(validDecision),
                ],
            },
        }

        for (const corrupted of [mismatched, duplicate]) {
            const restarted = createCoordinator()
            restarted.start(corrupted)
            const outcome = restarted.decide(
                proposal,
                decisionState(corrupted),
            )
            assert.ok(RuntimeReplanRejected.is(outcome.event))
            if (RuntimeReplanRejected.is(outcome.event)) {
                assert.equal(outcome.event.data.code, "stale_graph_version")
            }
        }
    })

    it("does not advance in-memory state when persistence fails", () => {
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: () => {
                throw new Error("disk full")
            },
        })
        coordinator.start(initialPrd())

        const outcome = coordinator.decide(addProposal(), decisionState())
        assert.ok(RuntimeReplanRejected.is(outcome.event))
        if (RuntimeReplanRejected.is(outcome.event)) {
            assert.equal(outcome.event.data.code, "persistence_failed")
            assert.match(outcome.event.data.reason, /disk full/)
            assert.equal(outcome.event.data.currentGraphVersion, 1)
        }
        assert.equal(outcome.applied, undefined)
        assert.equal(coordinator.graphVersion, 1)
    })

    it("uses graph-version CAS and exact active lease correlation", () => {
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: () => {},
        })
        coordinator.start(initialPrd())

        let outcome = coordinator.decide(
            { ...addProposal(), baseGraphVersion: 2 },
            decisionState(),
        )
        assert.ok(RuntimeReplanRejected.is(outcome.event))
        if (RuntimeReplanRejected.is(outcome.event)) {
            assert.equal(outcome.event.data.code, "stale_graph_version")
        }

        outcome = coordinator.decide(
            { ...addProposal(), proposalId: "wrong-lease", leaseId: "other" },
            decisionState(),
        )
        assert.ok(RuntimeReplanRejected.is(outcome.event))
        if (RuntimeReplanRejected.is(outcome.event)) {
            assert.equal(outcome.event.data.code, "inactive_source")
        }

        outcome = coordinator.decide(
            {
                ...addProposal(),
                runId: "other-run",
                proposalId: "wrong-run",
            },
            decisionState(),
        )
        assert.ok(RuntimeReplanRejected.is(outcome.event))
        if (RuntimeReplanRejected.is(outcome.event)) {
            assert.equal(outcome.event.data.code, "invalid_proposal")
        }
        assert.equal(coordinator.graphVersion, 1)
    })
})

function decisionState(prd: PrdFile = initialPrd()) {
    return {
        active: true,
        prd,
        immutableStoryIds: new Set(["S1"]),
        activeLease: { leaseId: "lease-1", generation: 1 },
        healingActionsSinceProgress: 0,
    }
}

function addSecondProposal(): RuntimeReplanProposedData {
    return {
        runId: "run-1",
        proposalId: "proposal-2",
        sourceStoryId: "S1",
        leaseId: "lease-1",
        generation: 1,
        baseGraphVersion: 2,
        reason: "another follow-up is required",
        mutation: {
            addedStories: [
                {
                    id: "S3",
                    priority: 3,
                    title: "Second follow-up",
                    description: "Implement the second discovered follow-up.",
                    dependsOn: ["S2"],
                    acceptance: ["The second discovered follow-up works."],
                    tests: ["npm test"],
                },
            ],
            removedStoryIds: [],
            modifiedDeps: {},
        },
    }
}

function addProposal(): RuntimeReplanProposedData {
    return {
        runId: "run-1",
        proposalId: "proposal-1",
        sourceStoryId: "S1",
        leaseId: "lease-1",
        generation: 1,
        baseGraphVersion: 1,
        reason: "follow-up work is required",
        mutation: {
            addedStories: [
                {
                    id: "S2",
                    priority: 2,
                    title: "Follow-up",
                    description: "Implement the discovered follow-up.",
                    dependsOn: ["S1"],
                    acceptance: ["The discovered follow-up works."],
                    tests: ["npm test"],
                },
            ],
            removedStoryIds: [],
            modifiedDeps: {},
        },
    }
}

function initialPrd(): PrdFile {
    return {
        project: "coordinator-test",
        branchName: "baro/coordinator-test",
        description: "test",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Initial",
                description: "Initial story.",
                dependsOn: [],
                retries: 1,
                acceptance: [],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
        ],
    }
}
