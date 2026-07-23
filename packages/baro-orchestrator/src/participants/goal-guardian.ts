import { BaseObserver, type Participant, type SemanticEvent } from "../runtime/mozaik.js"
import { createHash } from "node:crypto"

import {
    GoalAggregateReviewCompleted,
    GoalAggregateReviewRequested,
    GoalCompletionAttested,
    GoalCompletionCheckRequested,
    GoalInvariantChallengeRaised,
    GoalInvariantChallengeResolved,
    GoalInvariantRemediationAdmitted,
    GoalInvariantRemediationProposed,
    GoalLedgerProjectionUpdated,
    GoalStoryInvariantMapped,
    PlanningStreamClosed,
    RunPreparationRequested,
    RuntimeReplanApplied,
    StoryMerged,
    StoryQualityCompleted,
    type GoalCompletionAttestedData,
    type GoalCompletionCheckRequestedData,
    type GoalAggregateReviewCompletedData,
    type GoalInvariantRemediationAdmittedData,
    type GoalInvariantRemediationProposedData,
} from "../semantic-events.js"
import {
    deriveGoalContract,
    GoalInvariantLedger,
    type DisplacedGoalRemediation,
    type GoalContract,
    type GoalAggregateReviewBasis,
    type GoalIntegrationEvidence,
    type GoalInvariant,
    type GoalInvariantChallenge,
    type GoalLedgerProjection,
    type GoalStoryInvariantMapping,
} from "../runtime/goal-contract.js"
import { goalAggregateStableBasisFingerprint } from "../runtime/goal-aggregate-review.js"
import type { GoalEnvelope } from "../session/conversation-contract.js"

const MAX_AGGREGATE_REMEDIATIONS_PER_INVARIANT = 3

export interface GoalGuardianOptions {
    runId: string
    /** Missing/null preserves legacy behavior: no contract is synthesized. */
    goalEnvelope?: GoalEnvelope | null
    /** Initial admitted DAG coverage; dynamic accepted work uses a mapping event. */
    storyMappings?: readonly GoalStoryInvariantMapping[]
    /** Passed stories restored from a durable PRD on resume (quality is not inferred). */
    integratedStoryIds?: readonly string[]
    /** Last Guardian-owned durable projection, restored verbatim on resume. */
    projection?: GoalLedgerProjection
    /** Collective quality mode fails open evidence without a passed Critic verdict. */
    requireIndependentQuality?: boolean
    /** Collective strict mode also requires one review of the merged run. */
    requireAggregateReview?: boolean
    /** Progressive planning starts from an intentionally empty graph. */
    deferCoverageUntilPlanningClosed?: boolean
}

interface CachedAttestation {
    requestKey: string
    data: GoalCompletionAttestedData
}

interface PendingAggregateReview {
    requestKey: string
    request: GoalCompletionCheckRequestedData
    basis: GoalAggregateReviewBasis
    reviewId: string
    goalRevision: number
    refreshCount: number
}

/**
 * Independent Mozaik projection and goal-level completion authority.
 *
 * The Guardian never schedules work and never mutates the DAG. It observes
 * source-bound integration and quality facts, accepts distributed challenges,
 * proposes invariant-scoped remediation through the Board's transaction lane,
 * then attests the resulting event ledger when the coordinator asks.
 */
export class GoalGuardian extends BaseObserver {
    readonly contract: GoalContract | null

    private readonly ledger: GoalInvariantLedger | null
    private readonly requireIndependentQuality: boolean
    private readonly requireAggregateReview: boolean
    private readonly completed = new Map<string, CachedAttestation>()
    private readonly pendingAggregateReviews = new Map<
        string,
        PendingAggregateReview
    >()
    private readonly mappingEvents = new Map<string, string>()
    private readonly emittedRemediationProposals = new Set<string>()
    private projectionRevision = 0
    private projectionFingerprint = ""
    private coverageDeferred: boolean
    private requestAuthority: Participant | null = null
    private integrationAuthority: Participant | null = null
    private qualityAuthority: Participant | null = null
    private challengeAuthority: Participant | null = null
    private aggregateReviewAuthority: Participant | null = null

    constructor(private readonly opts: GoalGuardianOptions) {
        super()
        this.requireIndependentQuality = opts.requireIndependentQuality ?? false
        this.requireAggregateReview = opts.requireAggregateReview ?? false
        if (this.requireAggregateReview && !this.requireIndependentQuality) {
            throw new Error(
                "aggregate goal review requires independent story quality",
            )
        }
        this.contract = deriveGoalContract(opts.goalEnvelope)
        this.ledger = this.contract
            ? new GoalInvariantLedger(
                  this.contract,
                  undefined,
                  opts.projection,
              )
            : null
        if (this.ledger && opts.storyMappings !== undefined) {
            const displaced = this.ledger.reconcileAdmittedStories(
                opts.storyMappings,
            )
            this.bindDisplacedRemediations(displaced)
        }
        if (this.ledger) {
            for (const storyId of opts.integratedStoryIds ?? []) {
                if (!this.ledger.hasIntegration(storyId)) {
                    this.ledger.recordIntegration({ storyId })
                }
            }
            if (this.requireIndependentQuality) {
                const displaced =
                    this.ledger.displaceUnverifiableRemediations()
                this.bindDisplacedRemediations(displaced)
            }
            // Close the crash window where the PRD pass was persisted but the
            // corresponding live StoryMerged event never reached Guardian.
            // Strict Critic evidence must match the exact restored lease; an
            // uncorrelated PRD-only integration is retried above instead.
            this.ledger.resolveSatisfiedRemediations(
                this.requireIndependentQuality,
            )
        }
        this.projectionRevision = opts.projection?.revision ?? 0
        if (this.ledger) {
            this.projectionFingerprint = projectionContentFingerprint(
                this.ledger.snapshot(this.projectionRevision),
            )
        }
        this.coverageDeferred = opts.deferCoverageUntilPlanningClosed ?? false
    }

    setRequestAuthority(authority: Participant): void {
        this.requestAuthority = bindAuthority(
            this.requestAuthority,
            authority,
            "goal guardian request authority",
        )
    }

    setIntegrationAuthority(authority: Participant): void {
        this.integrationAuthority = bindAuthority(
            this.integrationAuthority,
            authority,
            "goal guardian integration authority",
        )
    }

    setQualityAuthority(authority: Participant): void {
        this.qualityAuthority = bindAuthority(
            this.qualityAuthority,
            authority,
            "goal guardian quality authority",
        )
    }

    /** Attribution-validating bridge allowed to relay leased worker challenges. */
    setChallengeAuthority(authority: Participant): void {
        this.challengeAuthority = bindAuthority(
            this.challengeAuthority,
            authority,
            "goal guardian challenge authority",
        )
    }

    setAggregateReviewAuthority(authority: Participant): void {
        this.aggregateReviewAuthority = bindAuthority(
            this.aggregateReviewAuthority,
            authority,
            "goal guardian aggregate review authority",
        )
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (
            GoalStoryInvariantMapped.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (!this.isRequestAuthority(source) || !this.ledger) return
            const requestKey = JSON.stringify([
                event.data.storyId,
                event.data.invariantIds,
            ])
            const seen = this.mappingEvents.get(event.data.mappingId)
            if (seen !== undefined) return
            this.mappingEvents.set(event.data.mappingId, requestKey)
            this.ledger.mapStory({
                storyId: event.data.storyId,
                invariantIds: event.data.invariantIds,
            })
            this.publishProjection()
            return
        }

        if (
            RuntimeReplanApplied.is(event) &&
            event.data.runId === this.opts.runId &&
            this.isRequestAuthority(source) &&
            this.ledger
        ) {
            const displaced: DisplacedGoalRemediation[] = []
            for (const storyId of event.data.mutation.removedStoryIds) {
                displaced.push(...this.ledger.removeStory(storyId))
            }
            this.bindDisplacedRemediations(displaced)
            for (const story of event.data.mutation.addedStories) {
                this.ledger.mapStory({
                    storyId: story.id,
                    invariantIds: story.goalInvariantIds ?? [],
                })
            }
            this.ensureGoalRemediations()
            this.publishProjection()
            this.emitPendingRemediations()
            return
        }

        if (StoryMerged.is(event) && event.data.runId === this.opts.runId) {
            if (
                !this.ledger ||
                !this.integrationAuthority ||
                source !== this.integrationAuthority
            ) return
            this.ledger.recordIntegration({
                storyId: event.data.storyId,
                ...(event.data.leaseId ? { leaseId: event.data.leaseId } : {}),
            })
            const resolutions = this.ledger.resolveSatisfiedRemediations(
                this.requireIndependentQuality,
            )
            this.publishProjection()
            this.emitResolutions(resolutions)
            return
        }

        if (
            StoryQualityCompleted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (
                !this.ledger ||
                !this.qualityAuthority ||
                source !== this.qualityAuthority
            ) return
            const critique = event.data.critique
            this.ledger.recordQuality({
                storyId: event.data.storyId,
                leaseId: event.data.leaseId,
                evaluationId: event.data.evaluationId,
                status: event.data.status,
                independentlyPassed:
                    event.data.status === "passed" &&
                    critique?.verdict === "pass" &&
                    (critique.status ?? "evaluated") === "evaluated",
            })
            const resolutions = this.ledger.resolveSatisfiedRemediations(
                this.requireIndependentQuality,
            )
            this.publishProjection()
            this.emitResolutions(resolutions)
            return
        }

        if (
            GoalInvariantChallengeRaised.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (!this.ledger) return
            if (this.challengeAuthority) {
                if (source !== this.challengeAuthority) return
            } else if (participantId(source) !== event.data.raisedBy) return
            this.ledger.raiseChallenge({
                challengeId: event.data.challengeId,
                invariantId: event.data.invariantId,
                raisedBy: event.data.raisedBy,
                reason: event.data.reason,
                ...(event.data.storyId ? { storyId: event.data.storyId } : {}),
            })
            // A retained bridge outbox may replay the original challenge after
            // restart.  Reconciliation may already have retry-linked it to a
            // fresh remediation, which must not be replaced by the original
            // deterministic proposal identity.
            if (!this.ledger.hasChallengeRemediation(event.data.challengeId)) {
                this.bindRemediation(
                    event.data.challengeId,
                    event.data.invariantId,
                )
            }
            this.publishProjection()
            this.emitPendingRemediations()
            return
        }

        if (
            GoalInvariantRemediationAdmitted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (
                !this.isRequestAuthority(source) ||
                !this.ledger ||
                event.data.contractId !== this.contract?.contractId
            ) return
            const challengeIds = remediationChallengeIds(event.data)
            const invariantIds = remediationInvariantIds(event.data)
            if (
                challengeIds.length !== invariantIds.length ||
                event.data.challengeId !== challengeIds[0] ||
                event.data.invariantId !== invariantIds[0] ||
                (event.data.remediationGroupId !== undefined &&
                    (event.data.remediationGroupId.trim().length === 0 ||
                        event.data.remediationGroupId.length > 128)) ||
                !this.ledger.matchesChallengeRemediationTargets(
                    challengeIds,
                    invariantIds,
                    event.data.proposalId,
                    event.data.storyId,
                    event.data.remediationGroupId,
                )
            ) return
            this.ledger.admitChallengeRemediationGroup(
                challengeIds,
                event.data.proposalId,
                event.data.storyId,
                event.data.graphVersion,
            )
            const resolutions = this.ledger.resolveSatisfiedRemediations(
                this.requireIndependentQuality,
            )
            this.publishProjection()
            this.emitResolutions(resolutions)
            return
        }

        if (
            GoalInvariantChallengeResolved.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (!this.isRequestAuthority(source) || !this.ledger) return
            this.ledger.resolveChallenge(event.data)
            this.publishProjection()
            return
        }

        if (
            GoalAggregateReviewCompleted.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (source !== this.aggregateReviewAuthority || !this.ledger) return
            this.onAggregateReviewCompleted(event.data)
            return
        }

        if (
            RunPreparationRequested.is(event) &&
            event.data.runId === this.opts.runId &&
            this.isRequestAuthority(source)
        ) {
            // A challenge can arrive from the durable Bridge before Board has
            // entered its preparation phase. Re-emit every still-requested
            // proposal at this explicit run boundary; Board admission is
            // idempotent and will ignore an exact replay it already accepted.
            this.emittedRemediationProposals.clear()
            this.ensureGoalRemediations()
            // Establish the new run's durable protocol domain before any
            // runtime graph transaction can accidentally carry a prior run's
            // completion receipt forward.
            this.publishProjection(true)
            this.emitPendingRemediations()
            return
        }

        if (
            PlanningStreamClosed.is(event) &&
            event.data.runId === this.opts.runId &&
            event.data.status === "completed" &&
            this.isRequestAuthority(source)
        ) {
            this.coverageDeferred = false
            this.ensureGoalRemediations()
            this.publishProjection()
            this.emitPendingRemediations()
            return
        }

        if (
            GoalCompletionCheckRequested.is(event) &&
            event.data.runId === this.opts.runId
        ) {
            if (!this.isRequestAuthority(source)) return
            this.onCompletionCheck(event.data)
        }
    }

    private isRequestAuthority(source: Participant): boolean {
        return this.requestAuthority !== null && source === this.requestAuthority
    }

    private bindRemediation(
        challengeId: string,
        invariantId: string,
        retryOf?: string,
        revalidates?: readonly GoalIntegrationEvidence[],
    ): void {
        this.bindRemediationGroup(
            [{ challengeId, invariantId }],
            retryOf,
            revalidates,
        )
    }

    private bindRemediationGroup(
        targets: readonly { challengeId: string; invariantId: string }[],
        retryOf?: string,
        revalidates?: readonly GoalIntegrationEvidence[],
        remediationGroupId?: string,
    ): boolean {
        if (!this.contract || !this.ledger) return false
        if (
            targets.length === 0 ||
            targets.some(
                ({ invariantId }) =>
                    !this.contract!.invariants.some(({ id }) => id === invariantId),
            )
        ) return false
        const canonical = [...targets].sort((left, right) =>
            left.invariantId.localeCompare(right.invariantId) ||
            left.challengeId.localeCompare(right.challengeId))
        const digest = createHash("sha256")
            .update(this.contract.contractId)
            .update("\u0000")
            // Preserve the historic singleton identity byte-for-byte so
            // projections and PRDs created before grouping replay exactly.
            .update(canonical.length === 1
                ? canonical[0]!.challengeId
                : canonical.map(({ challengeId, invariantId }) =>
                    `${invariantId}\u0000${challengeId}`).join("\u0000"))
            .update(retryOf ? `\u0000retry-of\u0000${retryOf}` : "")
            .digest("hex")
        return this.ledger.bindChallengeRemediationGroup(
            canonical.map(({ challengeId }) => challengeId),
            {
            proposalId: `goal-remediation-${digest.slice(0, 24)}`,
            storyId: `GREM-${digest.slice(0, 12)}`,
            ...(remediationGroupId ? { remediationGroupId } : {}),
            status: "requested",
            ...(revalidates && revalidates.length > 0
                ? { revalidates }
                : {}),
            },
        )
    }

    private bindDisplacedRemediations(
        displaced: readonly DisplacedGoalRemediation[],
    ): void {
        const byProposal = new Map<string, DisplacedGoalRemediation[]>()
        for (const remediation of displaced) {
            const group = byProposal.get(remediation.previousProposalId)
            if (group) group.push(remediation)
            else byProposal.set(remediation.previousProposalId, [remediation])
        }
        for (const [previousProposalId, group] of byProposal) {
            const revalidates = uniqueIntegrations(
                group.flatMap(({ revalidates: targets }) => targets ?? []),
            )
            const remediationGroupIds = new Set(
                group.flatMap(({ remediationGroupId }) =>
                    remediationGroupId ? [remediationGroupId] : []),
            )
            this.bindRemediationGroup(
                group.map(({ challengeId, invariantId }) => ({
                    challengeId,
                    invariantId,
                })),
                previousProposalId,
                revalidates.length > 0 ? revalidates : undefined,
                remediationGroupIds.size === 1
                    ? [...remediationGroupIds][0]
                    : undefined,
            )
        }
    }

    private ensureGoalRemediations(): void {
        if (this.coverageDeferred || !this.contract || !this.ledger) return
        for (const invariantId of this.ledger.unmappedInvariantIds()) {
            const invariant = this.contract.invariants.find(
                ({ id }) => id === invariantId,
            )!
            this.raiseSyntheticChallenge(
                "coverage",
                invariantId,
                `No admitted story owns evidence for ${invariantId}: ` +
                    invariant.text,
            )
        }
        if (!this.requireIndependentQuality) return
        for (const invariantId of
            this.ledger.invariantsNeedingIndependentQuality()) {
            const invariant = this.contract.invariants.find(
                ({ id }) => id === invariantId,
            )!
            this.raiseSyntheticChallenge(
                "revalidation",
                invariantId,
                `Previously integrated work for ${invariantId} has no ` +
                    `durable passing independent critique: ${invariant.text}`,
                this.ledger.qualityRevalidationTargets(invariantId),
            )
        }
    }

    private raiseSyntheticChallenge(
        kind: "coverage" | "revalidation" | "aggregate",
        invariantId: string,
        reason: string,
        revalidates?: readonly GoalIntegrationEvidence[],
    ): boolean {
        if (!this.contract || !this.ledger) return false
        if (this.ledger.hasOpenChallenge(invariantId)) return false
        if (
            kind === "aggregate" &&
            this.ledger.aggregateRemediationCount(invariantId) >=
                MAX_AGGREGATE_REMEDIATIONS_PER_INVARIANT
        ) return false
        const ordinal = this.ledger.challengeCount(invariantId) + 1
        const digest = createHash("sha256")
            .update(this.contract.contractId)
            .update(`\u0000${kind}\u0000`)
            .update(invariantId)
            .update("\u0000")
            .update(String(ordinal))
            .digest("hex")
        const challengeId =
            `${kind}-${invariantId.toLowerCase()}-${digest.slice(0, 12)}`
        this.ledger.raiseChallenge({
            challengeId,
            invariantId,
            raisedBy: "goal-guardian",
            reason,
        })
        this.bindRemediation(
            challengeId,
            invariantId,
            undefined,
            revalidates,
        )
        return true
    }

    /**
     * Raise and bind one aggregate-review root cause as a single repair unit.
     * Caps and open-challenge checks are evaluated for the complete target set
     * before any challenge is created; a group is never partially dispatched.
     */
    private raiseAggregateChallengeGroup(
        remediationGroupId: string,
        reviews: readonly { invariantId: string; reason: string }[],
        reviewId: string,
    ): boolean {
        if (!this.contract || !this.ledger || reviews.length === 0) return false
        const uniqueReviews = [...new Map(
            reviews.map((review) => [review.invariantId, review]),
        ).values()].sort((left, right) =>
            left.invariantId.localeCompare(right.invariantId))
        if (
            uniqueReviews.length !== reviews.length ||
            uniqueReviews.some(
                ({ invariantId }) =>
                    !this.contract!.invariants.some(({ id }) => id === invariantId) ||
                    this.ledger!.hasOpenChallenge(invariantId) ||
                    this.ledger!.aggregateRemediationCount(invariantId) >=
                        MAX_AGGREGATE_REMEDIATIONS_PER_INVARIANT,
            )
        ) return false

        const targets = uniqueReviews.map(({ invariantId, reason }) => {
            const ordinal = this.ledger!.challengeCount(invariantId) + 1
            const digest = createHash("sha256")
                .update(this.contract!.contractId)
                .update("\u0000aggregate-group\u0000")
                .update(remediationGroupId)
                .update("\u0000")
                .update(invariantId)
                .update("\u0000")
                .update(String(ordinal))
                .digest("hex")
            return {
                challengeId:
                    `aggregate-${invariantId.toLowerCase()}-${digest.slice(0, 12)}`,
                invariantId,
                reason:
                    `Run-level semantic review ${reviewId} rejected ` +
                    `the invariant: ${reason}`,
            }
        })
        for (const target of targets) {
            this.ledger.raiseChallenge({
                challengeId: target.challengeId,
                invariantId: target.invariantId,
                raisedBy: "goal-guardian",
                reason: target.reason,
            })
        }
        return this.bindRemediationGroup(
            targets,
            undefined,
            undefined,
            remediationGroupId,
        )
    }

    private emitPendingRemediations(): void {
        if (!this.contract || !this.ledger) return
        for (const { challenges, remediation } of
            this.ledger.pendingRemediationGroups()) {
            if (this.emittedRemediationProposals.has(remediation.proposalId)) {
                continue
            }
            const targets = challenges.flatMap((challenge) => {
                const invariant = this.contract!.invariants.find(
                    ({ id }) => id === challenge.invariantId,
                )
                return invariant ? [{ challenge, invariant }] : []
            })
            if (targets.length !== challenges.length || targets.length === 0) {
                continue
            }
            const challengeIds = targets.map(
                ({ challenge }) => challenge.challengeId,
            )
            const invariantIds = targets.map(({ invariant }) => invariant.id)
            const remediationGroupId = remediation.remediationGroupId
            const grouped = targets.length > 1
            const [singleton] = targets
            this.emittedRemediationProposals.add(remediation.proposalId)
            this.emit(
                GoalInvariantRemediationProposed.create({
                    runId: this.opts.runId,
                    contractId: this.contract.contractId,
                    challengeId: challengeIds[0]!,
                    ...(challengeIds.length > 1
                        ? { challengeIds }
                        : {}),
                    invariantId: invariantIds[0]!,
                    ...(invariantIds.length > 1
                        ? { invariantIds }
                        : {}),
                    ...(remediationGroupId
                        ? { remediationGroupId }
                        : {}),
                    proposalId: remediation.proposalId,
                    reason: grouped
                        ? targets.map(({ challenge }) =>
                            `[${challenge.invariantId}] ${challenge.reason}`).join("\n")
                        : singleton!.challenge.reason,
                    story: grouped
                        ? groupedRemediationStory(
                            remediation.storyId,
                            targets,
                        )
                        : legacyRemediationStory(
                            remediation.storyId,
                            singleton!,
                        ),
                }),
            )
        }
    }

    private emitResolutions(
        resolutions: readonly {
            challengeId: string
            resolution: "resolved" | "rejected"
            reason: string
        }[],
    ): void {
        for (const resolution of resolutions) {
            this.emit(
                GoalInvariantChallengeResolved.create({
                    runId: this.opts.runId,
                    ...resolution,
                }),
            )
        }
    }

    private publishProjection(force = false): void {
        if (!this.contract || !this.ledger) return
        const candidate = this.ledger.snapshot(this.projectionRevision + 1)
        const fingerprint = projectionContentFingerprint(candidate)
        if (!force && fingerprint === this.projectionFingerprint) return
        this.projectionRevision = candidate.revision
        this.projectionFingerprint = fingerprint
        this.emit(
            GoalLedgerProjectionUpdated.create({
                runId: this.opts.runId,
                contractId: this.contract.contractId,
                revision: candidate.revision,
                projection: candidate,
            }),
        )
    }

    private onCompletionCheck(request: GoalCompletionCheckRequestedData): void {
        const requestKey = JSON.stringify(request)
        const cached = this.completed.get(request.checkId)
        if (cached) {
            if (cached.requestKey === requestKey) {
                this.emit(GoalCompletionAttested.create(cached.data))
            }
            return
        }

        if (
            this.requireAggregateReview &&
            this.contract &&
            this.ledger &&
            request.contractId === this.contract.contractId
        ) {
            const localAssessment = this.ledger.assess(
                request.storyIds,
                this.requireIndependentQuality,
            )
            if (localAssessment.status === "satisfied") {
                const basis = this.ledger.aggregateReviewBasis(
                    request.storyIds,
                    request.verificationId,
                )
                if (!this.ledger.aggregateReviewForBasis(
                    basis.fingerprint,
                    basis.verificationId,
                )) {
                    this.requestAggregateReview(requestKey, request, basis)
                    return
                }
                this.publishProjection(true)
                const data = this.attest(request, basis)
                this.completed.set(request.checkId, { requestKey, data })
                this.emit(GoalCompletionAttested.create(data))
                return
            }
        }

        // Publish the complete source-of-truth projection immediately before
        // its derived decision. The serialized Board therefore persists the
        // evidence before it can persist or act on the attestation.
        this.publishProjection(true)
        const data = this.attest(request)
        this.completed.set(request.checkId, { requestKey, data })
        this.emit(GoalCompletionAttested.create(data))
    }

    private requestAggregateReview(
        requestKey: string,
        request: GoalCompletionCheckRequestedData,
        basis: GoalAggregateReviewBasis,
        refreshCount = 0,
    ): void {
        const reviewId = `goal-review:${basis.fingerprint}`
        const pending = this.pendingAggregateReviews.get(reviewId)
        if (pending) {
            if (pending.requestKey === requestKey) {
                this.emit(
                    GoalAggregateReviewRequested.create({
                        runId: this.opts.runId,
                        reviewId,
                        checkId: request.checkId,
                        goalRevision: pending.goalRevision,
                        basis,
                    }),
                )
            }
            return
        }
        this.publishProjection(true)
        const goalRevision = this.projectionRevision
        this.pendingAggregateReviews.set(reviewId, {
            requestKey,
            request: structuredClone(request),
            basis,
            reviewId,
            goalRevision,
            refreshCount,
        })
        this.emit(
            GoalAggregateReviewRequested.create({
                runId: this.opts.runId,
                reviewId,
                checkId: request.checkId,
                goalRevision,
                basis,
            }),
        )
    }

    private onAggregateReviewCompleted(
        review: GoalAggregateReviewCompletedData,
    ): void {
        if (!this.ledger || !this.contract) return
        const pending = this.pendingAggregateReviews.get(review.reviewId)
        if (!pending) return
        if (
            review.checkId !== pending.request.checkId ||
            review.contractId !== this.contract.contractId ||
            review.goalRevision !== pending.goalRevision ||
            review.basisFingerprint !== pending.basis.fingerprint ||
            review.verificationId !== pending.basis.verificationId
        ) return

        const currentBasis = this.ledger.aggregateReviewBasis(
            pending.request.storyIds,
            pending.request.verificationId,
        )
        this.pendingAggregateReviews.delete(review.reviewId)
        if (currentBasis.fingerprint !== pending.basis.fingerprint) {
            const localAssessment = this.ledger.assess(
                pending.request.storyIds,
                this.requireIndependentQuality,
            )
            const qualityOnlyChange =
                goalAggregateStableBasisFingerprint(currentBasis) ===
                    goalAggregateStableBasisFingerprint(pending.basis)
            if (
                pending.refreshCount < 1 &&
                localAssessment.status === "satisfied" &&
                qualityOnlyChange
            ) {
                this.requestAggregateReview(
                    pending.requestKey,
                    pending.request,
                    currentBasis,
                    pending.refreshCount + 1,
                )
                return
            }
            this.publishProjection(true)
            const data = this.attest(pending.request, currentBasis)
            this.completed.set(pending.request.checkId, {
                requestKey: pending.requestKey,
                data,
            })
            this.emit(GoalCompletionAttested.create(data))
            return
        }

        try {
            this.ledger.recordAggregateReview(review)
        } catch {
            this.publishProjection(true)
            const data = this.attest(pending.request, currentBasis)
            this.completed.set(pending.request.checkId, {
                requestKey: pending.requestKey,
                data,
            })
            this.emit(GoalCompletionAttested.create(data))
            return
        }

        const rejected = review.invariants.filter(
            ({ status }) => status === "failed",
        )
        if (review.status === "failed" && rejected.length > 0) {
            let remediationRequested = false
            const groups = new Map<string, typeof rejected>()
            for (const invariant of rejected) {
                const groupId = invariant.remediationGroupId ??
                    `legacy-singleton:${review.reviewId}:${invariant.invariantId}`
                const group = groups.get(groupId)
                if (group) group.push(invariant)
                else groups.set(groupId, [invariant])
            }
            for (const [groupId, invariants] of groups) {
                remediationRequested =
                    this.raiseAggregateChallengeGroup(
                        groupId,
                        invariants,
                        review.reviewId,
                    ) || remediationRequested
            }
            if (remediationRequested) {
                // A semantic rejection is actionable repository work, not a
                // terminal coordinator verdict. Publish the rejected evidence
                // and its exact invariant-scoped challenges before asking
                // Board to reopen scheduling. The remediation integration
                // changes the source-bound basis, so completion requires a
                // fresh verifier receipt and aggregate review.
                this.publishProjection(true)
                this.emitPendingRemediations()
                return
            }
        }
        this.publishProjection(true)
        const data = this.attest(pending.request, currentBasis)
        this.completed.set(pending.request.checkId, {
            requestKey: pending.requestKey,
            data,
        })
        this.emit(GoalCompletionAttested.create(data))
    }

    private attest(
        request: GoalCompletionCheckRequestedData,
        aggregateBasis?: GoalAggregateReviewBasis,
    ): GoalCompletionAttestedData {
        if (!this.contract || !this.ledger) {
            if (request.contractId !== null) {
                return {
                    runId: this.opts.runId,
                    checkId: request.checkId,
                    contractId: null,
                    goalRevision: null,
                    verificationId: request.verificationId,
                    status: "incomplete",
                    satisfiedInvariantIds: [],
                    openInvariantIds: [],
                    rejectedInvariantIds: [],
                    invariants: [],
                    reason: "completion request claims a goal contract, but this legacy run has no GoalEnvelope",
                }
            }
            return {
                runId: this.opts.runId,
                checkId: request.checkId,
                contractId: null,
                goalRevision: null,
                verificationId: request.verificationId,
                status: "disabled",
                satisfiedInvariantIds: [],
                openInvariantIds: [],
                rejectedInvariantIds: [],
                invariants: [],
                reason: "goal governance disabled: run has no GoalEnvelope",
            }
        }

        if (request.contractId !== this.contract.contractId) {
            const openInvariantIds = this.contract.invariants.map(({ id }) => id)
            return {
                runId: this.opts.runId,
                checkId: request.checkId,
                contractId: this.contract.contractId,
                goalRevision: this.projectionRevision,
                verificationId: request.verificationId,
                status: "incomplete",
                satisfiedInvariantIds: [],
                openInvariantIds,
                rejectedInvariantIds: [],
                invariants: this.contract.invariants.map(({ id }) => ({
                    invariantId: id,
                    status: "open",
                    mappedStoryIds: [],
                    integratedStoryIds: [],
                    independentlyReviewedStoryIds: [],
                    reason: "completion request contractId does not match the bound GoalEnvelope",
                })),
                reason: "goal contract correlation mismatch",
            }
        }

        const assessment = this.ledger.assess(
            request.storyIds,
            this.requireIndependentQuality,
            aggregateBasis,
        )
        return {
            runId: this.opts.runId,
            checkId: request.checkId,
            contractId: this.contract.contractId,
            goalRevision: this.projectionRevision,
            verificationId: request.verificationId,
            status: assessment.status,
            satisfiedInvariantIds: assessment.satisfiedInvariantIds,
            openInvariantIds: assessment.openInvariantIds,
            rejectedInvariantIds: assessment.rejectedInvariantIds,
            invariants: assessment.invariants,
            reason: assessment.reason,
        }
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

/** Naming alias for call sites that treat the participant as the collective ledger. */
export { GoalGuardian as CollectiveGoalLedger }

interface RemediationTarget {
    challenge: GoalInvariantChallenge
    invariant: GoalInvariant
}

function legacyRemediationStory(
    storyId: string,
    { challenge, invariant }: RemediationTarget,
): GoalInvariantRemediationProposedData["story"] {
    // Kept byte-for-byte compatible with pre-grouping GREM stories so an
    // admitted PRD can replay through Board's exact story collision check.
    return {
        id: storyId,
        priority: -1,
        title: `Resolve goal challenge ${invariant.id}`,
        description:
            `Autonomously investigate and resolve challenge ` +
            `${challenge.challengeId} against ${invariant.id}. ` +
            `Invariant: ${invariant.text}\n` +
            `Observed risk: ${challenge.reason}\n` +
            "Implement the smallest correct fix and focused regression evidence; preserve every other GoalContract invariant.",
        dependsOn: [],
        retries: 2,
        acceptance: [
            `[${invariant.id}] ${invariant.text}`,
            `Challenge ${challenge.challengeId} is addressed: ${challenge.reason}`,
            "Focused regression evidence demonstrates the corrected behavior.",
        ],
        tests: ["git diff --check"],
        model: "heavy",
        goalInvariantIds: [invariant.id],
    }
}

function groupedRemediationStory(
    storyId: string,
    targets: readonly RemediationTarget[],
): GoalInvariantRemediationProposedData["story"] {
    const challengeIds = targets.map(({ challenge }) => challenge.challengeId)
    const invariantIds = targets.map(({ invariant }) => invariant.id)
    return {
        id: storyId,
        priority: -1,
        title: `Resolve goal challenges ${invariantIds.join(", ")}`,
        description:
            `Autonomously investigate and resolve one shared root cause ` +
            `across ${challengeIds.join(", ")}.\n` +
            targets.map(({ challenge, invariant }) =>
                `[${invariant.id}] ${invariant.text}\n` +
                `Observed risk: ${challenge.reason}`).join("\n") +
            "\n" +
            "Implement the smallest correct fix and focused regression evidence; preserve every other GoalContract invariant.",
        dependsOn: [],
        retries: 2,
        acceptance: [
            ...targets.map(({ invariant }) =>
                `[${invariant.id}] ${invariant.text}`),
            ...targets.map(({ challenge }) =>
                `Challenge ${challenge.challengeId} is addressed: ${challenge.reason}`),
            "Focused regression evidence demonstrates the corrected behavior.",
        ],
        tests: ["git diff --check"],
        model: "heavy",
        goalInvariantIds: invariantIds,
    }
}

function remediationChallengeIds(
    remediation: GoalInvariantRemediationAdmittedData,
): readonly string[] {
    return validRemediationIds(
        remediation.challengeIds ?? [remediation.challengeId],
    )
}

function remediationInvariantIds(
    remediation: GoalInvariantRemediationAdmittedData,
): readonly string[] {
    return validRemediationIds(
        remediation.invariantIds ?? [remediation.invariantId],
    )
}

function validRemediationIds(values: readonly string[]): readonly string[] {
    if (
        values.length === 0 ||
        values.some(
            (value) => value.trim().length === 0 || value !== value.trim(),
        ) ||
        new Set(values).size !== values.length
    ) return []
    return [...values]
}

function uniqueIntegrations(
    integrations: readonly GoalIntegrationEvidence[],
): readonly GoalIntegrationEvidence[] {
    const unique = new Map<string, GoalIntegrationEvidence>()
    for (const integration of integrations) {
        const key = `${integration.storyId}\u0000${integration.leaseId ?? ""}`
        unique.set(key, { ...integration })
    }
    return [...unique.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, integration]) => integration)
}

function bindAuthority(
    current: Participant | null,
    authority: Participant,
    label: string,
): Participant {
    if (current && current !== authority) {
        throw new Error(`${label} is already bound`)
    }
    return authority
}

function participantId(participant: Participant): string | null {
    const value = (participant as Participant & { agentId?: unknown }).agentId
    return typeof value === "string" && value.length > 0 ? value : null
}

function projectionContentFingerprint(projection: GoalLedgerProjection): string {
    return JSON.stringify({ ...projection, revision: 0 })
}
