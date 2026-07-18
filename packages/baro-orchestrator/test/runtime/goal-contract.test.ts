import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    deriveGoalContract,
    GoalInvariantLedger,
    renderGoalContractPrompt,
} from "../../src/runtime/goal-contract.js"
import { goalEnvelopeFingerprint } from "../../src/session/conversation-contract.js"

const envelope = {
    objective: "Make cancellation lossless.",
    constraints: ["Do not change the public API."],
    acceptanceCriteria: [
        "Every provider aborts before returning.",
        "Cleanup runs exactly once.",
    ],
    nonGoals: ["Rewrite the harness."],
    assumptions: ["Providers expose abort signals."],
} as const

describe("goal contract", () => {
    it("derives immutable stable contract and scoped invariant ids from the exact envelope", () => {
        assert.equal(deriveGoalContract(null), null)
        assert.equal(deriveGoalContract(undefined), null)

        const first = deriveGoalContract(envelope)!
        const second = deriveGoalContract({ ...envelope })!
        const fingerprint = goalEnvelopeFingerprint(envelope)

        assert.deepEqual(first, second)
        assert.equal(first.contractId, `goal:${fingerprint}`)
        assert.deepEqual(
            first.invariants.map(({ id, kind }) => ({ id, kind })),
            [
                {
                    id: "G-A1",
                    kind: "acceptance",
                },
                {
                    id: "G-A2",
                    kind: "acceptance",
                },
                {
                    id: "G-C1",
                    kind: "constraint",
                },
            ],
        )
        assert.equal(Object.isFrozen(first), true)
        assert.equal(Object.isFrozen(first.invariants), true)
        assert.equal(Object.isFrozen(first.invariants[0]), true)
    })

    it("renders the whole contract while marking story-owned evidence", () => {
        const contract = deriveGoalContract(envelope)!
        const assigned = contract.invariants[1]!.id
        const prompt = renderGoalContractPrompt(contract, [assigned])

        for (const invariant of contract.invariants) {
            assert.match(prompt, new RegExp(escapeRegex(invariant.id)))
            assert.match(prompt, new RegExp(escapeRegex(invariant.text)))
        }
        assert.match(prompt, /\[ASSIGNED\]/)
        assert.match(prompt, /never silently ignore it/)
        assert.throws(
            () => renderGoalContractPrompt(contract, ["foreign-invariant"]),
            /unknown goal invariant/,
        )
    })
})

describe("GoalInvariantLedger", () => {
    it("requires selected mapped work to integrate and optionally pass independent review", () => {
        const contract = deriveGoalContract(envelope)!
        const ids = contract.invariants.map(({ id }) => id)
        const ledger = new GoalInvariantLedger(contract, [
            { storyId: "S1", invariantIds: ids.slice(0, 2) },
            { storyId: "S2", invariantIds: ids.slice(2) },
        ])

        ledger.recordIntegration({ storyId: "S1", leaseId: "lease-1" })
        ledger.recordIntegration({ storyId: "S2", leaseId: "lease-2" })

        assert.equal(ledger.assess(["S1", "S2"], false).status, "satisfied")
        const missingReview = ledger.assess(["S1", "S2"], true)
        assert.equal(missingReview.status, "incomplete")
        assert.deepEqual(missingReview.openInvariantIds, ids)

        ledger.recordQuality({
            storyId: "S1",
            leaseId: "old-lease",
            evaluationId: "old-evaluation",
            status: "passed",
            independentlyPassed: true,
        })
        assert.equal(
            ledger.assess(["S1", "S2"], true).satisfiedInvariantIds.length,
            0,
            "quality from a stale lease is not evidence for integrated work",
        )

        for (const [storyId, leaseId] of [
            ["S1", "lease-1"],
            ["S2", "lease-2"],
        ] as const) {
            ledger.recordQuality({
                storyId,
                leaseId,
                evaluationId: `quality-${storyId}`,
                status: "passed",
                independentlyPassed: true,
            })
        }
        const satisfied = ledger.assess(["S1", "S2"], true)
        assert.equal(satisfied.status, "satisfied")
        assert.deepEqual(satisfied.satisfiedInvariantIds, ids)

        const staleDAG = ledger.assess(["S1"], true)
        assert.equal(staleDAG.status, "incomplete")
        assert.deepEqual(staleDAG.openInvariantIds, [ids[2]])
    })

    it("rejects failed quality and never attests around open or upheld challenges", () => {
        const contract = deriveGoalContract(envelope)!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract, [
            { storyId: "S1", invariantIds: [invariantId] },
        ])
        ledger.recordIntegration({ storyId: "S1", leaseId: "lease-1" })
        ledger.recordQuality({
            storyId: "S1",
            leaseId: "lease-1",
            evaluationId: "quality-1",
            status: "failed",
            independentlyPassed: false,
        })

        const rejected = ledger.assess(["S1"], true)
        assert.deepEqual(rejected.rejectedInvariantIds, [invariantId])

        ledger.recordQuality({
            storyId: "S1",
            leaseId: "lease-1",
            evaluationId: "quality-2",
            status: "passed",
            independentlyPassed: true,
        })
        ledger.raiseChallenge({
            challengeId: "challenge-1",
            invariantId,
            raisedBy: "worker-S1",
            reason: "cleanup ordering is still ambiguous",
        })
        const open = ledger.assess(["S1"], true)
        assert.equal(open.openInvariantIds.includes(invariantId), true)
        assert.match(
            open.invariants.find((item) => item.invariantId === invariantId)?.reason ?? "",
            /open challenge/,
        )

        ledger.resolveChallenge({
            challengeId: "challenge-1",
            resolution: "resolved",
            reason: "the ordering test now proves the invariant",
        })
        assert.equal(
            ledger.assess(["S1"], true).satisfiedInvariantIds.includes(invariantId),
            true,
        )

        ledger.raiseChallenge({
            challengeId: "challenge-2",
            invariantId,
            raisedBy: "critic",
            reason: "observed duplicate cleanup",
        })
        ledger.resolveChallenge({
            challengeId: "challenge-2",
            resolution: "rejected",
            reason: "duplicate cleanup is confirmed",
        })
        assert.deepEqual(
            ledger.assess(["S1"], true).rejectedInvariantIds,
            [invariantId],
        )
    })

    it("fails closed on mappings that reference a foreign contract", () => {
        const contract = deriveGoalContract(envelope)!
        const ledger = new GoalInvariantLedger(contract, [
            { storyId: "S1", invariantIds: ["goal:foreign:acceptance:1"] },
        ])
        ledger.recordIntegration({ storyId: "S1" })

        const assessment = ledger.assess(["S1"], false)
        assert.equal(assessment.status, "incomplete")
        assert.equal(assessment.protocolIssues.length, 1)
        assert.match(assessment.protocolIssues[0]!, /unknown invariant/)
    })

    it("records a conflicting challenge-resolution replay as a protocol issue", () => {
        const contract = deriveGoalContract(envelope)!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract, [{
            storyId: "S1",
            invariantIds: [invariantId],
        }])
        ledger.recordIntegration({ storyId: "S1" })
        ledger.raiseChallenge({
            challengeId: "challenge-conflict",
            invariantId,
            raisedBy: "worker-S1",
            reason: "cleanup ordering is uncertain",
        })
        ledger.resolveChallenge({
            challengeId: "challenge-conflict",
            resolution: "resolved",
            reason: "a focused test proves the ordering",
        })
        ledger.resolveChallenge({
            challengeId: "challenge-conflict",
            resolution: "rejected",
            reason: "the same id now claims the opposite result",
        })

        const projection = ledger.snapshot(1)
        assert.equal(projection.protocolIssues.length, 1)
        assert.match(
            projection.protocolIssues[0]!.reason,
            /resolved more than once with conflicting content/,
        )
        const assessment = ledger.assess(["S1"], false)
        assert.equal(assessment.status, "incomplete")
        assert.equal(assessment.protocolIssues.length, 1)
    })

    it("reconciles restored mappings and evidence to the exact admitted graph", () => {
        const contract = deriveGoalContract(envelope)!
        const stale = new GoalInvariantLedger(contract, [{
            storyId: "S-REMOVED",
            invariantIds: contract.invariants.map(({ id }) => id),
        }])
        stale.recordIntegration({
            storyId: "S-REMOVED",
            leaseId: "lease-removed",
        })
        stale.recordQuality({
            storyId: "S-REMOVED",
            leaseId: "lease-removed",
            evaluationId: "quality-removed",
            status: "passed",
            independentlyPassed: true,
        })
        const restored = new GoalInvariantLedger(
            contract,
            undefined,
            stale.snapshot(3),
        )

        restored.reconcileAdmittedStories([{
            storyId: "S-CURRENT",
            invariantIds: ["G-A1"],
        }])
        const projection = restored.snapshot(4)
        assert.deepEqual(projection.mappings, [{
            storyId: "S-CURRENT",
            invariantIds: ["G-A1"],
        }])
        assert.deepEqual(projection.integrations, [])
        assert.deepEqual(projection.qualities, [])
        assert.deepEqual(restored.unmappedInvariantIds(), ["G-A2", "G-C1"])
    })

    it("reopens a resolved challenge when its admitted remediation proof is removed", () => {
        const { invariantId, ledger } = resolvedRemediationLedger()

        assert.equal(
            ledger.assess(["S1", "GREM-1"], true).status,
            "satisfied",
        )
        assert.deepEqual(ledger.removeStory("GREM-1"), [{
            challengeId: "challenge-remediation",
            invariantId,
            previousProposalId: "proposal-remediation",
        }])

        const projection = ledger.snapshot(6)
        assert.deepEqual(projection.challenges, [{
            challengeId: "challenge-remediation",
            invariantId,
            raisedBy: "critic",
            reason: "cancellation cleanup still races",
        }])
        const assessment = ledger.assess(["S1"], true)
        assert.equal(assessment.status, "incomplete")
        assert.deepEqual(assessment.openInvariantIds, [invariantId])
        assert.match(
            assessment.invariants.find(
                (item) => item.invariantId === invariantId,
            )?.reason ?? "",
            /open challenge challenge-remediation/,
        )
        assert.equal(projection.mappings.some(({ storyId }) => storyId === "GREM-1"), false)
        assert.equal(projection.integrations.some(({ storyId }) => storyId === "GREM-1"), false)
        assert.equal(projection.qualities.some(({ storyId }) => storyId === "GREM-1"), false)
    })

    it("reopens a restored resolved challenge when reconciliation finds its remediation absent", () => {
        const { contract, invariantId, ledger } = resolvedRemediationLedger()
        const stale = ledger.snapshot(7)
        const restored = new GoalInvariantLedger(
            contract,
            undefined,
            {
                ...stale,
                mappings: stale.mappings.filter(
                    ({ storyId }) => storyId !== "GREM-1",
                ),
                integrations: stale.integrations.filter(
                    ({ storyId }) => storyId !== "GREM-1",
                ),
                qualities: stale.qualities.filter(
                    ({ storyId }) => storyId !== "GREM-1",
                ),
            },
        )

        assert.equal(
            restored.assess(["S1"], true).status,
            "satisfied",
            "the stale resolved challenge is falsely green until admitted-graph reconciliation",
        )

        assert.deepEqual(
            restored.reconcileAdmittedStories([{
                storyId: "S1",
                invariantIds: contract.invariants.map(({ id }) => id),
            }]),
            [{
                challengeId: "challenge-remediation",
                invariantId,
                previousProposalId: "proposal-remediation",
            }],
        )

        const projection = restored.snapshot(8)
        assert.equal(projection.challenges[0]?.resolution, undefined)
        assert.equal(projection.challenges[0]?.remediation, undefined)
        assert.deepEqual(projection.integrations, [{
            storyId: "S1",
            leaseId: "lease-S1",
        }])
        assert.deepEqual(
            projection.qualities.map(({ storyId }) => storyId),
            ["S1"],
        )
        assert.deepEqual(
            restored.assess(["S1"], true).openInvariantIds,
            [invariantId],
        )
    })

    it("never correlates an old lease critique to a PRD-only restored integration", () => {
        const { contract, invariantId, ledger } = resolvedRemediationLedger()
        const stale = ledger.snapshot(8)
        const restored = new GoalInvariantLedger(contract, undefined, {
            ...stale,
            integrations: stale.integrations.map((integration) =>
                integration.storyId === "GREM-1"
                    ? { storyId: integration.storyId }
                    : integration
            ),
            challenges: stale.challenges.map((challenge) => ({
                ...challenge,
                resolution: undefined,
            })),
        })

        assert.equal(
            restored.resolveSatisfiedRemediations(true).length,
            0,
            "lease-GREM-1 quality does not identify an unleased integration",
        )
        assert.deepEqual(restored.displaceUnverifiableRemediations(), [{
            challengeId: "challenge-remediation",
            invariantId,
            previousProposalId: "proposal-remediation",
        }])
        const projection = restored.snapshot(9)
        assert.equal(projection.challenges[0]?.resolution, undefined)
        assert.equal(projection.challenges[0]?.remediation, undefined)
        assert.deepEqual(
            projection.integrations.find(
                ({ storyId }) => storyId === "GREM-1",
            ),
            { storyId: "GREM-1" },
            "historical graph evidence remains available for audit",
        )
    })
})

function resolvedRemediationLedger() {
    const contract = deriveGoalContract(envelope)!
    const invariantId = contract.invariants[0]!.id
    const ledger = new GoalInvariantLedger(contract, [
        {
            storyId: "S1",
            invariantIds: contract.invariants.map(({ id }) => id),
        },
        { storyId: "GREM-1", invariantIds: [invariantId] },
    ])
    ledger.recordIntegration({ storyId: "S1", leaseId: "lease-S1" })
    ledger.recordQuality({
        storyId: "S1",
        leaseId: "lease-S1",
        evaluationId: "quality-S1",
        status: "passed",
        independentlyPassed: true,
    })
    ledger.raiseChallenge({
        challengeId: "challenge-remediation",
        invariantId,
        raisedBy: "critic",
        reason: "cancellation cleanup still races",
    })
    ledger.bindChallengeRemediation("challenge-remediation", {
        proposalId: "proposal-remediation",
        storyId: "GREM-1",
        status: "requested",
    })
    ledger.admitChallengeRemediation(
        "challenge-remediation",
        "proposal-remediation",
        "GREM-1",
        2,
    )
    ledger.recordIntegration({ storyId: "GREM-1", leaseId: "lease-GREM-1" })
    ledger.recordQuality({
        storyId: "GREM-1",
        leaseId: "lease-GREM-1",
        evaluationId: "quality-GREM-1",
        status: "passed",
        independentlyPassed: true,
    })
    assert.equal(ledger.resolveSatisfiedRemediations(true).length, 1)

    return { contract, invariantId, ledger }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
