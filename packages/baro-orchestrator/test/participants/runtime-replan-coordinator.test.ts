import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { RuntimeReplanCoordinator } from "../../src/participants/runtime-replan-coordinator.js"
import {
    renderRuntimeAmendments,
    renderRuntimeAmendmentsForPrompt,
} from "../../src/planning/runtime-amendments.js"
import type { PrdFile } from "../../src/prd.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
} from "../../src/runtime/goal-contract.js"
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
                    origin: "worker",
                },
                {
                    fingerprint:
                        writes[1]!.runtimeGraph!.appliedDecisions[1]!.fingerprint,
                    applied: second.event.data,
                    origin: "worker",
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

    it("separates worker runtime-adaptation budget from policy recovery", () => {
        const writes: PrdFile[] = []
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 1,
            persist: (_path, value) => writes.push(structuredClone(value)),
        })
        const initial = initialPrd()
        coordinator.start(initial)

        const worker = coordinator.decide(addProposal(), {
            ...decisionState(initial),
            adaptationsSinceProgress: 1,
        })
        assert.ok(RuntimeReplanRejected.is(worker.event))
        if (RuntimeReplanRejected.is(worker.event)) {
            assert.equal(worker.event.data.code, "adaptation_budget_exhausted")
        }

        const policy = coordinator.decide(
            {
                ...addProposal(),
                proposalId: "policy-after-worker-budget",
            },
            {
                ...decisionState(initial),
                adaptationsSinceProgress: 99,
                requireActiveLease: false,
                activeLease: undefined,
                storyAccounting: "policy",
                maxAddedStories: 1,
            },
        )
        assert.ok(RuntimeReplanApplied.is(policy.event))
        assert.equal(writes.length, 1)
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

    it("does not advance in-memory state when persistence fails and permits a retry", () => {
        let failPersistence = true
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: () => {
                if (failPersistence) throw new Error("disk full")
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

        failPersistence = false
        const retried = coordinator.decide(addProposal(), decisionState())
        assert.ok(RuntimeReplanApplied.is(retried.event))
        assert.ok(retried.applied)
        assert.equal(coordinator.graphVersion, 2)
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

    it("preserves the Guardian protocol snapshot across a graph transaction", () => {
        const goalEnvelope = {
            objective: "Keep cancellation lossless.",
            constraints: [],
            acceptanceCriteria: ["All provider paths abort before returning."],
            nonGoals: [],
            assumptions: [],
        }
        const contract = deriveGoalContract(goalEnvelope)!
        const ledger = new GoalInvariantLedger(contract, [{
            storyId: "S1",
            invariantIds: ["G-A1"],
        }])
        const protocol = {
            schemaVersion: 1 as const,
            goal: ledger.snapshot(2),
            completion: {
                runId: "run-1",
                checkId: "check-before-mutation",
                contractId: contract.contractId,
                goalRevision: 2,
                verificationId: "verify-before-mutation",
                status: "incomplete" as const,
                satisfiedInvariantIds: [],
                openInvariantIds: ["G-A1"],
                rejectedInvariantIds: [],
                invariants: [{
                    invariantId: "G-A1",
                    status: "open" as const,
                    mappedStoryIds: ["S1"],
                    integratedStoryIds: [],
                    independentlyReviewedStoryIds: [],
                    reason: "story has not integrated",
                }],
                reason: "goal remains incomplete",
            },
        }
        const prd: PrdFile = {
            ...initialPrd(),
            goalEnvelope,
            userStories: initialPrd().userStories.map((story) => ({
                ...story,
                goalInvariantIds: ["G-A1"],
            })),
            runtimeGraph: {
                runId: "run-1",
                version: 1,
                dynamicStories: 0,
                policyStories: 0,
                appliedDecisions: [],
                protocol,
            },
        }
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: () => undefined,
        })
        coordinator.start(prd)

        const outcome = coordinator.decide(addProposal(), decisionState(prd))
        assert.ok(outcome.applied)
        assert.deepEqual(
            outcome.applied.prd.runtimeGraph?.protocol?.goal,
            protocol.goal,
        )
        assert.notEqual(
            outcome.applied.prd.runtimeGraph?.protocol?.goal,
            protocol.goal,
        )
        assert.equal(
            outcome.applied.prd.runtimeGraph?.protocol?.completion,
            undefined,
        )
    })

    it("carries contract evidence into a new run without carrying its completion receipt", () => {
        const goalEnvelope = {
            objective: "Keep cancellation lossless.",
            constraints: [],
            acceptanceCriteria: ["All provider paths abort before returning."],
            nonGoals: [],
            assumptions: [],
        }
        const contract = deriveGoalContract(goalEnvelope)!
        const ledger = new GoalInvariantLedger(contract, [{
            storyId: "S1",
            invariantIds: ["G-A1"],
        }])
        const goal = ledger.snapshot(4)
        const priorRun: PrdFile = {
            ...initialPrd(),
            goalEnvelope,
            userStories: initialPrd().userStories.map((story) => ({
                ...story,
                goalInvariantIds: ["G-A1"],
            })),
            runtimeGraph: {
                runId: "run-1",
                version: 3,
                dynamicStories: 0,
                policyStories: 0,
                appliedDecisions: [],
                protocol: {
                    schemaVersion: 1,
                    goal,
                    completion: {
                        runId: "run-1",
                        checkId: "check-run-1",
                        contractId: contract.contractId,
                        goalRevision: goal.revision,
                        verificationId: "verify-run-1",
                        status: "incomplete",
                        satisfiedInvariantIds: [],
                        openInvariantIds: ["G-A1"],
                        rejectedInvariantIds: [],
                        invariants: [{
                            invariantId: "G-A1",
                            status: "open",
                            mappedStoryIds: ["S1"],
                            integratedStoryIds: [],
                            independentlyReviewedStoryIds: [],
                            reason: "story has not integrated",
                        }],
                        reason: "goal remains incomplete",
                    },
                },
            },
        }
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-2",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: () => undefined,
        })
        coordinator.start(priorRun)
        const proposal: RuntimeReplanProposedData = {
            ...addProposal(),
            runId: "run-2",
            proposalId: "proposal-new-run",
            baseGraphVersion: 3,
        }

        const outcome = coordinator.decide(proposal, decisionState(priorRun))
        assert.ok(outcome.applied)
        assert.deepEqual(outcome.applied.prd.runtimeGraph?.protocol?.goal, goal)
        assert.equal(
            outcome.applied.prd.runtimeGraph?.protocol?.completion,
            undefined,
        )
        assert.equal(outcome.applied.prd.runtimeGraph?.runId, "run-2")
    })

    it("rejects a runtime adaptation whose prompt projection would overflow, transactionally", () => {
        const writes: PrdFile[] = []
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: (_path, value) => writes.push(structuredClone(value)),
        })
        coordinator.start(initialPrd())

        const oversized: RuntimeReplanProposedData = {
            ...addProposal(),
            proposalId: "proposal-oversized",
            reason: `evidence requires a correction ${"x".repeat(30_000)}`,
        }
        const rejected = coordinator.decide(oversized, decisionState())
        assert.ok(RuntimeReplanRejected.is(rejected.event))
        if (RuntimeReplanRejected.is(rejected.event)) {
            assert.equal(rejected.event.data.code, "prompt_projection_overflow")
            assert.equal(rejected.event.data.currentGraphVersion, 1)
        }
        assert.equal(coordinator.graphVersion, 1)
        assert.equal(writes.length, 0)

        const replay = coordinator.decide(
            structuredClone(oversized),
            decisionState(),
        )
        assert.ok(RuntimeReplanRejected.is(replay.event))
        assert.equal(writes.length, 0)

        // The graph, version, and ledger stay consistent for later decisions.
        const accepted = coordinator.decide(addProposal(), decisionState())
        assert.ok(RuntimeReplanApplied.is(accepted.event))
        assert.equal(coordinator.graphVersion, 2)
        assert.equal(writes.length, 1)
        assert.equal(
            writes[0]?.runtimeGraph?.appliedDecisions.length,
            1,
        )
    })

    it("admits oversized planner fragments and keeps them out of the prompt projection", () => {
        let durable = initialPrd()
        const coordinator = new RuntimeReplanCoordinator({
            runId: "run-1",
            prdPath: "/unused/prd.json",
            maxDynamicStories: 3,
            adaptationBudget: 3,
            persist: (_path, value) => {
                durable = structuredClone(value)
            },
        })
        coordinator.start(durable)

        // Three fragments mirroring the A20 shape: combined exact mutations
        // far beyond the 24k prompt budget, admitted while planning streams.
        for (const [index, dependsOn] of [[], ["SP1"], ["SP2"]].entries()) {
            const proposal = plannerFragmentProposal(
                index + 1,
                coordinator.graphVersion,
                dependsOn as string[],
            )
            assert.ok(
                JSON.stringify(proposal.mutation).length > 8_000,
                "each fragment must be individually large",
            )
            const outcome = coordinator.decide(proposal, {
                ...decisionState(durable),
                requireActiveLease: false,
                activeLease: undefined,
                storyAccounting: "planner",
                maxAddedStories: 8,
            })
            assert.ok(RuntimeReplanApplied.is(outcome.event))
        }
        assert.equal(coordinator.graphVersion, 4)
        assert.deepEqual(
            durable.runtimeGraph?.appliedDecisions.map(
                (decision) => decision.origin,
            ),
            ["planner", "planner", "planner"],
        )

        // Bootstrap history stays auditable but never re-enters the worker
        // prompt, so later story offers cannot overflow the projection.
        assert.equal(renderRuntimeAmendmentsForPrompt(durable), null)
        assert.ok(renderRuntimeAmendments(durable))

        const workerOutcome = coordinator.decide(
            {
                ...addProposal(),
                proposalId: "proposal-after-planning",
                baseGraphVersion: 4,
                mutation: {
                    addedStories: [
                        {
                            id: "S2",
                            priority: 9,
                            title: "Runtime adaptation",
                            description: "A genuine post-plan correction.",
                            dependsOn: ["SP3"],
                            acceptance: ["The correction is applied."],
                            tests: ["npm test"],
                        },
                    ],
                    removedStoryIds: [],
                    modifiedDeps: {},
                },
            },
            decisionState(durable),
        )
        assert.ok(RuntimeReplanApplied.is(workerOutcome.event))
        const projected = renderRuntimeAmendmentsForPrompt(durable)
        assert.ok(projected)
        assert.ok(projected.length <= 24_000)
        assert.match(projected, /proposal-after-planning/)
        assert.doesNotMatch(projected, /canonical obligation criterion text/)
    })
})

function plannerFragmentProposal(
    ordinal: number,
    baseGraphVersion: number,
    dependsOn: string[],
): RuntimeReplanProposedData {
    return {
        runId: "run-1",
        proposalId: `run-1:planner:fragment-${ordinal}`,
        sourceStoryId: "planner:planning-1",
        leaseId: "run-1:planning:planning-1",
        generation: ordinal,
        baseGraphVersion,
        reason: `progressive planner admitted fragment fragment-${ordinal}`,
        mutation: {
            addedStories: [
                {
                    id: `SP${ordinal}`,
                    priority: ordinal,
                    title: `Planner fragment story ${ordinal}`,
                    description: "Progressively planned story.",
                    dependsOn,
                    acceptance: Array.from(
                        { length: 24 },
                        (_, index) =>
                            `O-${String(index + 1).padStart(3, "0")}: ` +
                            `${"canonical obligation criterion text ".repeat(12)}`,
                    ),
                    tests: ["npm test"],
                },
            ],
            removedStoryIds: [],
            modifiedDeps: {},
        },
    }
}

function decisionState(prd: PrdFile = initialPrd()) {
    return {
        active: true,
        prd,
        immutableStoryIds: new Set(["S1"]),
        activeLease: { leaseId: "lease-1", generation: 1 },
        adaptationsSinceProgress: 0,
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
