import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    deriveGoalContract,
    GOAL_AGGREGATE_REVIEW_RETENTION,
    GoalInvariantLedger,
    normalizeGoalLedgerProjection,
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

    it("composes shared invariant evidence across every selected provider story", () => {
        const contract = deriveGoalContract({
            objective: "Propagate cancellation through every provider.",
            constraints: [],
            acceptanceCriteria: [
                "Every provider forwards the shared AbortSignal.",
            ],
            nonGoals: [],
            assumptions: [],
        })!
        const invariantId = contract.invariants[0]!.id
        const providerStories = ["S5", "S6", "S7", "S8"]
        const ledger = new GoalInvariantLedger(
            contract,
            providerStories.map((storyId) => ({
                storyId,
                invariantIds: [invariantId],
            })),
        )

        ledger.recordIntegration({ storyId: "S5", leaseId: "lease-S5" })
        ledger.recordQuality({
            storyId: "S5",
            leaseId: "lease-S5",
            evaluationId: "quality-S5",
            status: "passed",
            independentlyPassed: true,
        })

        const partial = ledger.assess(providerStories, true)
        assert.deepEqual(partial.openInvariantIds, [invariantId])
        assert.deepEqual(partial.satisfiedInvariantIds, [])
        assert.deepEqual(partial.invariants[0], {
            invariantId,
            status: "open",
            mappedStoryIds: providerStories,
            integratedStoryIds: ["S5"],
            independentlyReviewedStoryIds: ["S5"],
            reason: "1/4 mapped story contributions have integrated evidence",
        })

        for (const storyId of providerStories.slice(1)) {
            ledger.recordIntegration({
                storyId,
                leaseId: `lease-${storyId}`,
            })
        }
        assert.equal(
            ledger.assess(providerStories, false).status,
            "satisfied",
            "all mapped integrations compose without requiring quality",
        )

        const partiallyReviewed = ledger.assess(providerStories, true)
        assert.deepEqual(partiallyReviewed.openInvariantIds, [invariantId])
        assert.match(
            partiallyReviewed.invariants[0]!.reason,
            /1\/4 integrated mapped contributions/,
        )
        assert.deepEqual(
            ledger.invariantsNeedingIndependentQuality(),
            [invariantId],
        )

        for (const storyId of providerStories.slice(1)) {
            ledger.recordQuality({
                storyId,
                leaseId: `lease-${storyId}`,
                evaluationId: `quality-${storyId}`,
                status: "passed",
                independentlyPassed: true,
            })
        }
        const complete = ledger.assess(providerStories, true)
        assert.equal(complete.status, "satisfied")
        assert.deepEqual(complete.satisfiedInvariantIds, [invariantId])
        assert.deepEqual(
            ledger.invariantsNeedingIndependentQuality(),
            [],
        )
    })

    it("requires one persisted semantic review for the exact shared completion basis", () => {
        const contract = deriveGoalContract({
            objective: "Propagate cancellation through every provider.",
            constraints: [],
            acceptanceCriteria: [
                "All four provider shards jointly preserve cooperative cancellation.",
            ],
            nonGoals: [],
            assumptions: [],
        })!
        const storyIds = ["S5", "S6", "S7", "S8"]
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(
            contract,
            storyIds.map((storyId) => ({
                storyId,
                invariantIds: [invariantId],
            })),
        )
        for (const storyId of storyIds) {
            ledger.recordIntegration({ storyId, leaseId: `lease-${storyId}` })
            ledger.recordQuality({
                storyId,
                leaseId: `lease-${storyId}`,
                evaluationId: `quality-${storyId}`,
                status: "passed",
                independentlyPassed: true,
            })
        }

        const basis = ledger.aggregateReviewBasis(storyIds, "verification-1")
        const missing = ledger.assess(storyIds, true, basis)
        assert.equal(missing.status, "incomplete")
        assert.match(missing.invariants[0]!.reason, /run-level semantic review/)

        ledger.recordAggregateReview({
            reviewId: `goal-review:${basis.fingerprint}`,
            basisFingerprint: basis.fingerprint,
            verificationId: basis.verificationId,
            repositoryFingerprint: "a".repeat(64),
            status: "passed",
            attempts: 1,
            modelUsed: "fake-reviewer",
            invariants: [{
                invariantId,
                status: "passed",
                reason: "the merged provider composition preserves cancellation",
            }],
        })
        assert.equal(ledger.assess(storyIds, true, basis).status, "satisfied")

        const restored = new GoalInvariantLedger(
            contract,
            undefined,
            ledger.snapshot(7),
        )
        assert.equal(restored.assess(storyIds, true, basis).status, "satisfied")

        restored.recordIntegration({ storyId: "S8", leaseId: "lease-S8-new" })
        const changedIntegration = restored.aggregateReviewBasis(
            storyIds,
            "verification-1",
        )
        assert.notEqual(changedIntegration.fingerprint, basis.fingerprint)
        assert.equal(
            restored.assess(storyIds, true, changedIntegration).status,
            "incomplete",
        )

        const laterVerification = restored.aggregateReviewBasis(
            storyIds,
            "verification-2",
        )
        assert.notEqual(laterVerification.fingerprint, basis.fingerprint)
        assert.equal(
            restored.assess(storyIds, true, laterVerification).status,
            "incomplete",
        )
    })

    it("fails closed on negative and inconclusive aggregate reviews", () => {
        for (const status of ["failed", "inconclusive"] as const) {
            const contract = deriveGoalContract({
                objective: "Compose providers.",
                constraints: [],
                acceptanceCriteria: ["Every provider shares one cancellation signal."],
                nonGoals: [],
                assumptions: [],
            })!
            const invariantId = contract.invariants[0]!.id
            const ledger = new GoalInvariantLedger(contract, [{
                storyId: "S5",
                invariantIds: [invariantId],
            }])
            ledger.recordIntegration({ storyId: "S5", leaseId: "lease-S5" })
            ledger.recordQuality({
                storyId: "S5",
                leaseId: "lease-S5",
                evaluationId: "quality-S5",
                status: "passed",
                independentlyPassed: true,
            })
            const basis = ledger.aggregateReviewBasis(["S5"], "verification-1")
            ledger.recordAggregateReview({
                reviewId: `goal-review:${basis.fingerprint}`,
                basisFingerprint: basis.fingerprint,
                verificationId: basis.verificationId,
                repositoryFingerprint: "a".repeat(64),
                status,
                attempts: 2,
                modelUsed: "fake-reviewer",
                invariants: [{
                    invariantId,
                    status,
                    reason: `${status} aggregate evidence`,
                }],
            })
            const assessment = ledger.assess(["S5"], true, basis)
            assert.equal(assessment.status, "incomplete")
            assert.deepEqual(
                status === "failed"
                    ? assessment.rejectedInvariantIds
                    : assessment.openInvariantIds,
                [invariantId],
            )
        }
    })

    it("bounds persisted aggregate-review retention and preserves the newest exact basis across restore", () => {
        const contract = deriveGoalContract({
            objective: "Keep aggregate evidence bounded.",
            constraints: [],
            acceptanceCriteria: ["The newest exact basis remains replayable."],
            nonGoals: [],
            assumptions: [],
        })!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract)
        const total = GOAL_AGGREGATE_REVIEW_RETENTION + 7
        for (let index = 0; index < total; index += 1) {
            ledger.recordAggregateReview({
                reviewId: `goal-review:basis-${index}`,
                basisFingerprint: `basis-${index}`,
                verificationId: `verification-${index}`,
                repositoryFingerprint: "a".repeat(64),
                status: "passed",
                attempts: 1,
                modelUsed: "fake-reviewer",
                invariants: [{
                    invariantId,
                    status: "passed",
                    reason: `basis ${index} passed`,
                }],
            })
        }

        const snapshot = ledger.snapshot(1)
        assert.equal(
            snapshot.aggregateReviews.length,
            GOAL_AGGREGATE_REVIEW_RETENTION,
        )
        assert.equal(
            ledger.aggregateReviewForBasis(`basis-${total - 1}`)?.verificationId,
            `verification-${total - 1}`,
        )
        assert.equal(ledger.aggregateReviewForBasis("basis-0"), undefined)

        const restored = new GoalInvariantLedger(contract, undefined, snapshot)
        assert.equal(
            restored.snapshot(2).aggregateReviews.length,
            GOAL_AGGREGATE_REVIEW_RETENTION,
        )
        assert.equal(
            restored.aggregateReviewForBasis(`basis-${total - 1}`)?.reviewId,
            `goal-review:basis-${total - 1}`,
        )
    })

    it("lets lease-bound remediation revalidate only the integration gaps it captured", () => {
        const contract = deriveGoalContract({
            objective: "Restore strict quality evidence.",
            constraints: [],
            acceptanceCriteria: ["Cancellation remains lossless."],
            nonGoals: [],
            assumptions: [],
        })!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract, [
            { storyId: "S1", invariantIds: [invariantId] },
        ])
        ledger.recordIntegration({ storyId: "S1" })
        const targets = ledger.qualityRevalidationTargets(invariantId)
        assert.deepEqual(targets, [{ storyId: "S1" }])

        ledger.raiseChallenge({
            challengeId: "revalidation-G-A1",
            invariantId,
            raisedBy: "goal-guardian",
            reason: "restored integration lacks correlated quality",
        })
        ledger.bindChallengeRemediation("revalidation-G-A1", {
            proposalId: "proposal-R1",
            storyId: "R1",
            status: "requested",
            revalidates: targets,
        })
        ledger.admitChallengeRemediation(
            "revalidation-G-A1",
            "proposal-R1",
            "R1",
            2,
        )
        ledger.mapStory({ storyId: "R1", invariantIds: [invariantId] })
        ledger.recordIntegration({ storyId: "R1", leaseId: "lease-R1" })
        ledger.recordQuality({
            storyId: "R1",
            leaseId: "lease-R1",
            evaluationId: "quality-R1",
            status: "passed",
            independentlyPassed: true,
        })
        assert.equal(ledger.resolveSatisfiedRemediations(true).length, 1)

        const restored = new GoalInvariantLedger(
            contract,
            undefined,
            ledger.snapshot(4),
        )
        assert.equal(restored.assess(["S1", "R1"], true).status, "satisfied")
        assert.deepEqual(restored.invariantsNeedingIndependentQuality(), [])

        restored.recordIntegration({ storyId: "S1", leaseId: "lease-new" })
        const replaced = restored.assess(["S1", "R1"], true)
        assert.equal(replaced.status, "incomplete")
        assert.deepEqual(replaced.openInvariantIds, [invariantId])
        assert.deepEqual(
            restored.qualityRevalidationTargets(invariantId),
            [{ storyId: "S1", leaseId: "lease-new" }],
            "a remediation for a PRD-only integration cannot cover a later lease",
        )
    })

    it("fails closed when newer target quality contradicts a remediation witness", () => {
        const contract = deriveGoalContract({
            objective: "Preserve cancellation.",
            constraints: [],
            acceptanceCriteria: ["Cancellation remains lossless."],
            nonGoals: [],
            assumptions: [],
        })!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract, [
            { storyId: "S1", invariantIds: [invariantId] },
        ])
        ledger.recordIntegration({ storyId: "S1", leaseId: "lease-S1" })
        ledger.raiseChallenge({
            challengeId: "revalidation-G-A1",
            invariantId,
            raisedBy: "goal-guardian",
            reason: "S1 lacks quality evidence",
        })
        ledger.bindChallengeRemediation("revalidation-G-A1", {
            proposalId: "proposal-R1",
            storyId: "R1",
            status: "requested",
            revalidates: ledger.qualityRevalidationTargets(invariantId),
        })
        ledger.admitChallengeRemediation(
            "revalidation-G-A1",
            "proposal-R1",
            "R1",
            2,
        )
        ledger.mapStory({ storyId: "R1", invariantIds: [invariantId] })
        ledger.recordIntegration({ storyId: "R1", leaseId: "lease-R1" })
        ledger.recordQuality({
            storyId: "R1",
            leaseId: "lease-R1",
            evaluationId: "quality-R1",
            status: "passed",
            independentlyPassed: true,
        })
        ledger.resolveSatisfiedRemediations(true)
        assert.equal(ledger.assess(["S1", "R1"], true).status, "satisfied")

        ledger.recordQuality({
            storyId: "S1",
            leaseId: "lease-S1",
            evaluationId: "late-quality-S1",
            status: "failed",
            independentlyPassed: false,
        })
        assert.deepEqual(
            ledger.assess(["S1", "R1"], true).rejectedInvariantIds,
            [invariantId],
        )
    })

    it("fails closed when any integrated contribution has failed or inconclusive quality", () => {
        const contract = deriveGoalContract(envelope)!
        const invariantId = contract.invariants[0]!.id

        for (const status of ["failed", "inconclusive"] as const) {
            const ledger = new GoalInvariantLedger(contract, [
                { storyId: "S5", invariantIds: [invariantId] },
                { storyId: "S6", invariantIds: [invariantId] },
            ])
            for (const storyId of ["S5", "S6"]) {
                ledger.recordIntegration({
                    storyId,
                    leaseId: `lease-${storyId}`,
                })
                ledger.recordQuality({
                    storyId,
                    leaseId: `lease-${storyId}`,
                    evaluationId: `quality-${storyId}`,
                    status: storyId === "S5" ? "passed" : status,
                    independentlyPassed: storyId === "S5",
                })
            }

            const assessment = ledger.assess(["S5", "S6"], true)
            assert.deepEqual(
                assessment.rejectedInvariantIds,
                [invariantId],
                `${status} evidence rejects the aggregate invariant`,
            )
            assert.deepEqual(assessment.satisfiedInvariantIds, [])
        }
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

    it("binds remediation identity to its canonical integration witness set", () => {
        const contract = deriveGoalContract(envelope)!
        const invariantId = contract.invariants[0]!.id
        const ledger = new GoalInvariantLedger(contract)
        ledger.raiseChallenge({
            challengeId: "challenge-witness-identity",
            invariantId,
            raisedBy: "goal-guardian",
            reason: "quality evidence must be restored",
        })
        const first = {
            proposalId: "proposal-witness",
            storyId: "GREM-witness",
            status: "requested" as const,
            revalidates: [
                { storyId: "S1", leaseId: "lease-2" },
                { storyId: "S1", leaseId: "lease-1" },
            ],
        }
        ledger.bindChallengeRemediation(
            "challenge-witness-identity",
            first,
        )
        ledger.bindChallengeRemediation("challenge-witness-identity", {
            ...first,
            revalidates: [...first.revalidates].reverse(),
        })
        const canonical = ledger.snapshot(1)
        assert.deepEqual(canonical.protocolIssues, [])
        assert.deepEqual(
            canonical.challenges[0]?.remediation?.revalidates,
            [
                { storyId: "S1", leaseId: "lease-1" },
                { storyId: "S1", leaseId: "lease-2" },
            ],
        )

        ledger.bindChallengeRemediation("challenge-witness-identity", {
            ...first,
            revalidates: [{ storyId: "S1", leaseId: "lease-1" }],
        })
        assert.match(
            ledger.snapshot(2).protocolIssues[0]?.reason ?? "",
            /bound to conflicting remediation work/,
        )

        const challenge = canonical.challenges[0]!
        assert.throws(
            () => normalizeGoalLedgerProjection({
                ...canonical,
                challenges: [{
                    ...challenge,
                    remediation: {
                        ...challenge.remediation!,
                        revalidates: [
                            { storyId: "S1", leaseId: "lease-1" },
                            { storyId: "S1", leaseId: "lease-1" },
                        ],
                    },
                }],
            }, contract),
            /revalidation target contains duplicate keys/,
        )
        assert.throws(
            () => normalizeGoalLedgerProjection({
                ...canonical,
                challenges: [{
                    ...challenge,
                    remediation: {
                        ...challenge.remediation!,
                        remediationGroupId: "x".repeat(129),
                    },
                }],
            }, contract),
            /remediation binding is malformed/,
        )
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
