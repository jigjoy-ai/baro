import {
    goalEnvelopeFingerprint,
    validateGoalEnvelope,
    type GoalEnvelope,
} from "../session/conversation-contract.js"

export const GOAL_CONTRACT_SCHEMA_VERSION = 1 as const

export type GoalInvariantKind = "acceptance" | "constraint"

export interface GoalInvariant {
    id: string
    kind: GoalInvariantKind
    ordinal: number
    text: string
}

/**
 * Immutable, provider-neutral execution contract derived from exact user
 * intent.  The contract ID includes the complete GoalEnvelope fingerprint;
 * concise invariant IDs are always interpreted within that contract, so
 * evidence for an older intake cannot satisfy a revised goal.
 */
export interface GoalContract {
    schemaVersion: typeof GOAL_CONTRACT_SCHEMA_VERSION
    contractId: string
    fingerprint: string
    objective: string
    invariants: readonly GoalInvariant[]
    nonGoals: readonly string[]
    assumptions: readonly string[]
}

export interface GoalStoryInvariantMapping {
    storyId: string
    invariantIds: readonly string[]
}

export interface GoalIntegrationEvidence {
    storyId: string
    leaseId?: string
}

export interface GoalQualityEvidence {
    storyId: string
    leaseId: string
    evaluationId: string
    status: "passed" | "failed" | "inconclusive"
    /** True only for an evaluated, passing critique from the bound quality gate. */
    independentlyPassed: boolean
}

export interface GoalInvariantChallenge {
    challengeId: string
    invariantId: string
    raisedBy: string
    reason: string
    storyId?: string
}

export interface GoalInvariantChallengeResolution {
    challengeId: string
    resolution: "resolved" | "rejected"
    reason: string
}

export interface GoalInvariantChallengeRecord
    extends GoalInvariantChallenge {
    resolution?: GoalInvariantChallengeResolution
    remediation?: GoalInvariantRemediationBinding
}

export interface GoalInvariantRemediationBinding {
    proposalId: string
    storyId: string
    status: "requested" | "admitted"
    graphVersion?: number
}

export interface DisplacedGoalRemediation {
    challengeId: string
    invariantId: string
    previousProposalId: string
}

export interface GoalProtocolIssue {
    scope: "mapping" | "challenge"
    key: string
    reason: string
}

/**
 * Complete, replayable projection of the goal ledger.  It deliberately stores
 * semantic evidence rather than a derived green/red answer, so a restarted
 * Guardian can recompute completion against the exact current story set.
 */
export interface GoalLedgerProjection {
    schemaVersion: typeof GOAL_CONTRACT_SCHEMA_VERSION
    contractId: string
    revision: number
    mappings: readonly GoalStoryInvariantMapping[]
    integrations: readonly GoalIntegrationEvidence[]
    qualities: readonly GoalQualityEvidence[]
    challenges: readonly GoalInvariantChallengeRecord[]
    protocolIssues: readonly GoalProtocolIssue[]
}

export type GoalInvariantLedgerStatus = "satisfied" | "open" | "rejected"

export interface GoalInvariantLedgerEntry {
    invariantId: string
    status: GoalInvariantLedgerStatus
    mappedStoryIds: readonly string[]
    integratedStoryIds: readonly string[]
    independentlyReviewedStoryIds: readonly string[]
    reason: string
}

export interface GoalLedgerAssessment {
    status: "satisfied" | "incomplete"
    satisfiedInvariantIds: readonly string[]
    openInvariantIds: readonly string[]
    rejectedInvariantIds: readonly string[]
    invariants: readonly GoalInvariantLedgerEntry[]
    protocolIssues: readonly string[]
    reason: string
}

interface StoredChallenge extends GoalInvariantChallenge {
    resolution?: GoalInvariantChallengeResolution
    remediation?: GoalInvariantRemediationBinding
}

interface StoredQuality extends GoalQualityEvidence {
    sequence: number
}

/** Null means governance is deliberately disabled for a legacy/no-envelope run. */
export function deriveGoalContract(
    envelope: GoalEnvelope | null | undefined,
): GoalContract | null {
    if (envelope == null) return null

    const valid = validateGoalEnvelope(envelope)
    const fingerprint = goalEnvelopeFingerprint(valid)
    const contractId = `goal:${fingerprint}`
    const invariants: GoalInvariant[] = []

    valid.acceptanceCriteria.forEach((text, index) => {
        invariants.push({
            id: `G-A${index + 1}`,
            kind: "acceptance",
            ordinal: index + 1,
            text,
        })
    })
    valid.constraints.forEach((text, index) => {
        invariants.push({
            id: `G-C${index + 1}`,
            kind: "constraint",
            ordinal: index + 1,
            text,
        })
    })

    return deepFreeze({
        schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
        contractId,
        fingerprint,
        objective: valid.objective,
        invariants,
        nonGoals: [...valid.nonGoals],
        assumptions: [...valid.assumptions],
    })
}

/**
 * Deterministic prompt block shared by planner, worker and critic surfaces.
 * A story-specific view still includes every invariant so local scope never
 * erases the global contract.
 */
export function renderGoalContractPrompt(
    contract: GoalContract,
    storyInvariantIds?: readonly string[],
): string {
    const knownIds = new Set(contract.invariants.map(({ id }) => id))
    const assigned = new Set(storyInvariantIds ?? [])
    const unknown = [...assigned].filter((id) => !knownIds.has(id))
    if (unknown.length > 0) {
        throw new Error(
            `story references unknown goal invariant(s): ${unknown.join(", ")}`,
        )
    }

    const lines = [
        "GOAL CONTRACT (global, immutable)",
        `Contract: ${contract.contractId}`,
        `Objective: ${contract.objective}`,
        "Global invariants:",
        ...contract.invariants.map((invariant) => {
            const marker = assigned.has(invariant.id) ? " [ASSIGNED]" : ""
            return `- [${invariant.id}] (${invariant.kind})${marker} ${invariant.text}`
        }),
    ]

    if (storyInvariantIds !== undefined) {
        lines.push(
            assigned.size > 0
                ? `This story owns evidence for: ${[...assigned].join(", ")}`
                : "This story owns no goal invariant directly; it must still preserve all of them.",
        )
    }
    if (contract.nonGoals.length > 0) {
        lines.push("Non-goals:", ...contract.nonGoals.map((item) => `- ${item}`))
    }
    if (contract.assumptions.length > 0) {
        lines.push(
            "Assumptions to verify:",
            ...contract.assumptions.map((item) => `- ${item}`),
        )
    }
    lines.push(
        "If local scope cannot satisfy an assigned invariant, raise a goal challenge or discover/replan work; never silently ignore it.",
    )
    return lines.join("\n")
}

/**
 * Pure event projection for goal coverage.  It owns no scheduler state and
 * makes no model calls; callers feed it admitted mappings plus independently
 * sourced integration/quality/challenge facts.
 */
export class GoalInvariantLedger {
    private readonly invariantIds: ReadonlySet<string>
    private readonly mappings = new Map<string, readonly string[]>()
    private readonly integrations = new Map<string, GoalIntegrationEvidence>()
    private readonly qualities = new Map<string, Map<string, StoredQuality>>()
    private readonly challenges = new Map<string, StoredChallenge>()
    private readonly mappingIssues = new Map<string, string>()
    private readonly challengeIssues = new Map<string, string>()
    private qualitySequence = 0

    constructor(
        readonly contract: GoalContract,
        mappings?: readonly GoalStoryInvariantMapping[],
        projection?: GoalLedgerProjection,
    ) {
        this.invariantIds = new Set(contract.invariants.map(({ id }) => id))
        if (projection) this.restore(projection)
        if (mappings !== undefined) {
            for (const mapping of mappings) this.mapStory(mapping)
        }
    }

    snapshot(revision: number): GoalLedgerProjection {
        const qualities = [...this.qualities.values()]
            .flatMap((byLease) => [...byLease.values()])
            .sort(compareQuality)
            .map(({ sequence: _sequence, ...evidence }) => evidence)
        const challenges = [...this.challenges.values()]
            .sort((left, right) => left.challengeId.localeCompare(right.challengeId))
            .map((challenge) => structuredClone(challenge))
        const protocolIssues: GoalProtocolIssue[] = [
            ...[...this.mappingIssues.entries()].map(([key, reason]) => ({
                scope: "mapping" as const,
                key,
                reason,
            })),
            ...[...this.challengeIssues.entries()].map(([key, reason]) => ({
                scope: "challenge" as const,
                key,
                reason,
            })),
        ].sort(compareProtocolIssue)

        return normalizeGoalLedgerProjection(
            {
                schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
                contractId: this.contract.contractId,
                revision,
                mappings: [...this.mappings.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([storyId, invariantIds]) => ({
                        storyId,
                        invariantIds: [...invariantIds],
                    })),
                integrations: [...this.integrations.values()]
                    .sort((left, right) => left.storyId.localeCompare(right.storyId))
                    .map((evidence) => ({ ...evidence })),
                qualities,
                challenges,
                protocolIssues,
            },
            this.contract,
        )
    }

    private restore(projection: GoalLedgerProjection): void {
        const normalized = normalizeGoalLedgerProjection(
            projection,
            this.contract,
        )
        for (const mapping of normalized.mappings) this.mapStory(mapping)
        for (const integration of normalized.integrations) {
            this.recordIntegration(integration)
        }
        for (const quality of normalized.qualities) this.recordQuality(quality)
        for (const challenge of normalized.challenges) {
            this.raiseChallenge(challenge)
            if (challenge.remediation) {
                this.bindChallengeRemediation(
                    challenge.challengeId,
                    challenge.remediation,
                )
                if (challenge.remediation.status === "admitted") {
                    this.admitChallengeRemediation(
                        challenge.challengeId,
                        challenge.remediation.proposalId,
                        challenge.remediation.storyId,
                        challenge.remediation.graphVersion!,
                    )
                }
            }
            if (challenge.resolution) {
                this.resolveChallenge(challenge.resolution)
            }
        }
        for (const issue of normalized.protocolIssues) {
            const target = issue.scope === "mapping"
                ? this.mappingIssues
                : this.challengeIssues
            target.set(issue.key, issue.reason)
        }
    }

    mapStory(mapping: GoalStoryInvariantMapping): void {
        const storyId = nonEmpty(mapping.storyId)
        const invariantIds = unique(mapping.invariantIds.map(nonEmpty))
        const unknown = invariantIds.filter((id) => !this.invariantIds.has(id))
        if (unknown.length > 0) {
            this.mappings.delete(storyId)
            this.mappingIssues.set(
                storyId,
                `story ${storyId} maps unknown invariant(s): ${unknown.join(", ")}`,
            )
            return
        }
        this.mappingIssues.delete(storyId)
        this.mappings.set(storyId, Object.freeze(invariantIds))
    }

    unmapStory(storyIdValue: string): void {
        const storyId = nonEmpty(storyIdValue)
        this.mappings.delete(storyId)
        this.mappingIssues.delete(storyId)
    }

    /** Remove a story from the admitted graph and invalidate all of its proof. */
    removeStory(storyIdValue: string): readonly DisplacedGoalRemediation[] {
        const storyId = nonEmpty(storyIdValue)
        const displaced: DisplacedGoalRemediation[] = []
        this.unmapStory(storyId)
        this.integrations.delete(storyId)
        this.qualities.delete(storyId)
        for (const [challengeId, challenge] of this.challenges) {
            if (
                challenge.remediation?.status !== "admitted" ||
                challenge.remediation.storyId !== storyId
            ) continue
            displaced.push({
                challengeId,
                invariantId: challenge.invariantId,
                previousProposalId: challenge.remediation.proposalId,
            })
            const {
                remediation: _remediation,
                resolution: _resolution,
                ...reopened
            } = challenge
            this.challenges.set(
                challengeId,
                Object.freeze(reopened),
            )
        }
        return displaced
    }

    /**
     * Reconcile a restored projection to the exact currently admitted PRD.
     * This closes the crash window where a graph commit persisted but its
     * RuntimeReplanApplied event never reached the Guardian.
     */
    reconcileAdmittedStories(
        mappings: readonly GoalStoryInvariantMapping[],
    ): readonly DisplacedGoalRemediation[] {
        const admitted = new Set(mappings.map(({ storyId }) => nonEmpty(storyId)))
        const known = new Set([
            ...this.mappings.keys(),
            ...this.integrations.keys(),
            ...this.qualities.keys(),
            ...[...this.challenges.values()].flatMap(({ remediation }) =>
                remediation?.status === "admitted"
                    ? [remediation.storyId]
                    : [],
            ),
        ])
        const displaced: DisplacedGoalRemediation[] = []
        for (const storyId of known) {
            if (!admitted.has(storyId)) {
                displaced.push(...this.removeStory(storyId))
            }
        }
        for (const mapping of mappings) this.mapStory(mapping)
        return displaced
    }

    unmappedInvariantIds(): readonly string[] {
        const mapped = new Set(
            [...this.mappings.values()].flatMap((ids) => [...ids]),
        )
        return this.contract.invariants
            .map(({ id }) => id)
            .filter((id) => !mapped.has(id))
    }

    /**
     * Invariants whose admitted mapped work is already integrated, but whose
     * durable projection has no passing independent critique. Unintegrated
     * mapped stories are excluded because the normal scheduler can still
     * produce fresh evidence for them.
     */
    invariantsNeedingIndependentQuality(): readonly string[] {
        return this.contract.invariants
            .filter((invariant) => {
                const mappedStoryIds = [...this.mappings.entries()]
                    .filter(([, ids]) => ids.includes(invariant.id))
                    .map(([storyId]) => storyId)
                if (mappedStoryIds.length === 0) return false
                if (
                    mappedStoryIds.some(
                        (storyId) => !this.integrations.has(storyId),
                    )
                ) return false
                return mappedStoryIds.every(
                    (storyId) =>
                        this.qualityForIntegration(storyId)
                            ?.independentlyPassed !== true,
                )
            })
            .map(({ id }) => id)
    }

    /**
     * A requested or admitted remediation restored only from PRD state has no
     * durable lease identity. In strict quality mode, an older Critic verdict
     * for the same story ID therefore cannot prove that the restored
     * integration is the attempt that was reviewed. Reopen that challenge
     * with a fresh, retry-linked remediation while retaining the old story as
     * historical graph evidence. Including `requested` closes the crash
     * window where graph persistence won but the admission event did not
     * reach Guardian.
     */
    displaceUnverifiableRemediations(): readonly DisplacedGoalRemediation[] {
        const displaced: DisplacedGoalRemediation[] = []
        for (const [challengeId, challenge] of this.challenges) {
            const remediation = challenge.remediation
            if (
                !remediation ||
                !this.integrations.has(remediation.storyId) ||
                this.qualityForIntegration(remediation.storyId)
                    ?.independentlyPassed === true
            ) continue
            displaced.push({
                challengeId,
                invariantId: challenge.invariantId,
                previousProposalId: remediation.proposalId,
            })
            const {
                remediation: _remediation,
                resolution: _resolution,
                ...reopened
            } = challenge
            this.challenges.set(challengeId, Object.freeze(reopened))
        }
        return displaced
    }

    hasOpenChallenge(invariantIdValue: string): boolean {
        const invariantId = nonEmpty(invariantIdValue)
        return [...this.challenges.values()].some(
            (challenge) =>
                challenge.invariantId === invariantId && !challenge.resolution,
        )
    }

    hasChallengeRemediation(challengeIdValue: string): boolean {
        const challenge = this.challenges.get(nonEmpty(challengeIdValue))
        return challenge?.remediation !== undefined
    }

    challengeCount(invariantIdValue: string): number {
        const invariantId = nonEmpty(invariantIdValue)
        return [...this.challenges.values()].filter(
            (challenge) => challenge.invariantId === invariantId,
        ).length
    }

    recordIntegration(evidence: GoalIntegrationEvidence): void {
        const storyId = nonEmpty(evidence.storyId)
        this.integrations.set(
            storyId,
            Object.freeze({
                storyId,
                ...(evidence.leaseId
                    ? { leaseId: nonEmpty(evidence.leaseId) }
                    : {}),
            }),
        )
    }

    hasIntegration(storyIdValue: string): boolean {
        return this.integrations.has(nonEmpty(storyIdValue))
    }

    recordQuality(evidence: GoalQualityEvidence): void {
        const storyId = nonEmpty(evidence.storyId)
        const leaseId = nonEmpty(evidence.leaseId)
        const stored: StoredQuality = Object.freeze({
            storyId,
            leaseId,
            evaluationId: nonEmpty(evidence.evaluationId),
            status: evidence.status,
            independentlyPassed:
                evidence.status === "passed" && evidence.independentlyPassed,
            sequence: ++this.qualitySequence,
        })
        let byLease = this.qualities.get(storyId)
        if (!byLease) {
            byLease = new Map()
            this.qualities.set(storyId, byLease)
        }
        byLease.set(leaseId, stored)
    }

    raiseChallenge(challenge: GoalInvariantChallenge): void {
        const challengeId = nonEmpty(challenge.challengeId)
        const invariantId = nonEmpty(challenge.invariantId)
        if (!this.invariantIds.has(invariantId)) {
            this.challengeIssues.set(
                challengeId,
                `challenge ${challengeId} references unknown invariant ${invariantId}`,
            )
            return
        }
        const stored: StoredChallenge = Object.freeze({
            challengeId,
            invariantId,
            raisedBy: nonEmpty(challenge.raisedBy),
            reason: nonEmpty(challenge.reason),
            ...(challenge.storyId
                ? { storyId: nonEmpty(challenge.storyId) }
                : {}),
        })
        const previous = this.challenges.get(challengeId)
        if (previous) {
            if (!sameChallenge(previous, stored)) {
                this.challengeIssues.set(
                    challengeId,
                    `challenge id ${challengeId} was replayed with different content`,
                )
            }
            return
        }
        this.challengeIssues.delete(challengeId)
        this.challenges.set(challengeId, stored)
    }

    resolveChallenge(resolution: GoalInvariantChallengeResolution): void {
        const challengeId = nonEmpty(resolution.challengeId)
        const challenge = this.challenges.get(challengeId)
        if (!challenge) {
            this.challengeIssues.set(
                challengeId,
                `resolution references unknown challenge ${challengeId}`,
            )
            return
        }
        if (challenge.resolution) {
            if (
                challenge.resolution.resolution !== resolution.resolution ||
                challenge.resolution.reason !== resolution.reason
            ) {
                this.challengeIssues.set(
                    challengeId,
                    `challenge ${challengeId} was resolved more than once with conflicting content`,
                )
            }
            return
        }
        this.challengeIssues.delete(challengeId)
        this.challenges.set(
            challengeId,
            Object.freeze({
                ...challenge,
                resolution: Object.freeze({
                    challengeId,
                    resolution: resolution.resolution,
                    reason: nonEmpty(resolution.reason),
                }),
            }),
        )
    }

    bindChallengeRemediation(
        challengeIdValue: string,
        remediation: GoalInvariantRemediationBinding,
    ): void {
        const challengeId = nonEmpty(challengeIdValue)
        const challenge = this.challenges.get(challengeId)
        if (!challenge) {
            this.challengeIssues.set(
                challengeId,
                `remediation references unknown challenge ${challengeId}`,
            )
            return
        }
        const normalized = normalizeRemediationBinding(remediation)
        if (challenge.remediation) {
            if (
                challenge.remediation.proposalId !== normalized.proposalId ||
                challenge.remediation.storyId !== normalized.storyId
            ) {
                this.challengeIssues.set(
                    challengeId,
                    `challenge ${challengeId} was bound to conflicting remediation work`,
                )
            }
            return
        }
        this.challenges.set(
            challengeId,
            Object.freeze({ ...challenge, remediation: normalized }),
        )
    }

    admitChallengeRemediation(
        challengeIdValue: string,
        proposalIdValue: string,
        storyIdValue: string,
        graphVersion: number,
    ): void {
        const challengeId = nonEmpty(challengeIdValue)
        const challenge = this.challenges.get(challengeId)
        const proposalId = nonEmpty(proposalIdValue)
        const storyId = nonEmpty(storyIdValue)
        if (
            !challenge?.remediation ||
            challenge.remediation.proposalId !== proposalId ||
            challenge.remediation.storyId !== storyId ||
            !Number.isSafeInteger(graphVersion) ||
            graphVersion < 1
        ) {
            this.challengeIssues.set(
                challengeId,
                `challenge ${challengeId} received mismatched remediation admission`,
            )
            return
        }
        this.challengeIssues.delete(challengeId)
        this.challenges.set(
            challengeId,
            Object.freeze({
                ...challenge,
                remediation: Object.freeze({
                    proposalId,
                    storyId,
                    status: "admitted" as const,
                    graphVersion,
                }),
            }),
        )
    }

    pendingRemediations(): readonly {
        challenge: GoalInvariantChallenge
        remediation: GoalInvariantRemediationBinding
    }[] {
        return [...this.challenges.values()]
            .filter(
                (challenge) =>
                    !challenge.resolution &&
                    challenge.remediation?.status === "requested",
            )
            .sort((left, right) => left.challengeId.localeCompare(right.challengeId))
            .map((challenge) => ({
                challenge: {
                    challengeId: challenge.challengeId,
                    invariantId: challenge.invariantId,
                    raisedBy: challenge.raisedBy,
                    reason: challenge.reason,
                    ...(challenge.storyId
                        ? { storyId: challenge.storyId }
                        : {}),
                },
                remediation: { ...challenge.remediation! },
            }))
    }

    resolveSatisfiedRemediations(
        requireIndependentQuality: boolean,
    ): readonly GoalInvariantChallengeResolution[] {
        const resolved: GoalInvariantChallengeResolution[] = []
        for (const challenge of this.challenges.values()) {
            const remediation = challenge.remediation
            if (
                challenge.resolution ||
                remediation?.status !== "admitted" ||
                !this.integrations.has(remediation.storyId)
            ) continue
            const quality = this.qualityForIntegration(remediation.storyId)
            if (
                requireIndependentQuality &&
                quality?.independentlyPassed !== true
            ) continue
            const resolution = {
                challengeId: challenge.challengeId,
                resolution: "resolved" as const,
                reason:
                    `remediation story ${remediation.storyId} integrated` +
                    (requireIndependentQuality
                        ? " with an independent passing critique"
                        : " with goal-mapped evidence"),
            }
            this.resolveChallenge(resolution)
            resolved.push(resolution)
        }
        return resolved
    }

    assess(
        storyIds: readonly string[],
        requireIndependentQuality: boolean,
    ): GoalLedgerAssessment {
        const selectedStories = new Set(storyIds.map(nonEmpty))
        const invariants = this.contract.invariants.map((invariant) =>
            this.assessInvariant(
                invariant,
                selectedStories,
                requireIndependentQuality,
            ),
        )
        const satisfiedInvariantIds = invariants
            .filter(({ status }) => status === "satisfied")
            .map(({ invariantId }) => invariantId)
        const openInvariantIds = invariants
            .filter(({ status }) => status === "open")
            .map(({ invariantId }) => invariantId)
        const rejectedInvariantIds = invariants
            .filter(({ status }) => status === "rejected")
            .map(({ invariantId }) => invariantId)
        const protocolIssues = [
            ...this.mappingIssues.values(),
            ...this.challengeIssues.values(),
        ].sort()
        const satisfied =
            openInvariantIds.length === 0 &&
            rejectedInvariantIds.length === 0 &&
            protocolIssues.length === 0
        const reason = satisfied
            ? `all ${invariants.length} goal invariants have integrated${requireIndependentQuality ? ", independently reviewed" : ""} evidence`
            : [
                  openInvariantIds.length > 0
                      ? `${openInvariantIds.length} open invariant(s)`
                      : "",
                  rejectedInvariantIds.length > 0
                      ? `${rejectedInvariantIds.length} rejected invariant(s)`
                      : "",
                  protocolIssues.length > 0
                      ? `${protocolIssues.length} ledger protocol issue(s)`
                      : "",
              ]
                  .filter(Boolean)
                  .join(", ")

        return deepFreeze({
            status: satisfied ? "satisfied" : "incomplete",
            satisfiedInvariantIds,
            openInvariantIds,
            rejectedInvariantIds,
            invariants,
            protocolIssues,
            reason,
        })
    }

    private assessInvariant(
        invariant: GoalInvariant,
        selectedStories: ReadonlySet<string>,
        requireIndependentQuality: boolean,
    ): GoalInvariantLedgerEntry {
        const mappedStoryIds = [...this.mappings.entries()]
            .filter(
                ([storyId, ids]) =>
                    selectedStories.has(storyId) && ids.includes(invariant.id),
            )
            .map(([storyId]) => storyId)
            .sort()
        const integratedStoryIds = mappedStoryIds.filter((storyId) =>
            this.integrations.has(storyId),
        )
        const quality = integratedStoryIds.map((storyId) => ({
            storyId,
            evidence: this.qualityForIntegration(storyId),
        }))
        const independentlyReviewedStoryIds = quality
            .filter(({ evidence }) => evidence?.independentlyPassed === true)
            .map(({ storyId }) => storyId)
            .sort()
        const challenges = [...this.challenges.values()].filter(
            ({ invariantId }) => invariantId === invariant.id,
        )
        const rejectedChallenge = challenges.find(
            ({ resolution }) => resolution?.resolution === "rejected",
        )
        const openChallenge = challenges.find(({ resolution }) => !resolution)

        let status: GoalInvariantLedgerStatus
        let reason: string
        if (rejectedChallenge) {
            status = "rejected"
            reason = `challenge ${rejectedChallenge.challengeId} rejected the invariant: ${rejectedChallenge.resolution?.reason ?? rejectedChallenge.reason}`
        } else if (
            requireIndependentQuality &&
            quality.some(
                ({ evidence }) =>
                    evidence?.status === "failed" ||
                    evidence?.status === "inconclusive",
            )
        ) {
            status = "rejected"
            reason = "integrated mapped evidence failed independent quality review"
        } else if (openChallenge) {
            status = "open"
            reason = `open challenge ${openChallenge.challengeId}: ${openChallenge.reason}`
        } else if (integratedStoryIds.length === 0) {
            status = "open"
            reason = "no mapped story in the completion set has integrated evidence"
        } else if (
            requireIndependentQuality &&
            independentlyReviewedStoryIds.length === 0
        ) {
            status = "open"
            reason = "integrated mapped evidence lacks a passed independent critique"
        } else {
            status = "satisfied"
            reason = requireIndependentQuality
                ? "mapped story evidence is integrated and independently reviewed"
                : "mapped story evidence is integrated"
        }

        return deepFreeze({
            invariantId: invariant.id,
            status,
            mappedStoryIds,
            integratedStoryIds,
            independentlyReviewedStoryIds,
            reason,
        })
    }

    private qualityForIntegration(storyId: string): StoredQuality | undefined {
        const integration = this.integrations.get(storyId)
        if (!integration) return undefined
        if (!integration.leaseId) return undefined
        return this.qualities.get(storyId)?.get(integration.leaseId)
    }
}

/** Strict persistence boundary for runtimeGraph.protocol.goal. */
export function normalizeGoalLedgerProjection(
    value: unknown,
    expectedContract?: GoalContract,
): GoalLedgerProjection {
    if (!plainRecord(value)) {
        throw new Error("goal ledger projection is not an object")
    }
    if (
        value.schemaVersion !== GOAL_CONTRACT_SCHEMA_VERSION ||
        !nonBlank(value.contractId) ||
        !Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 0 ||
        !Array.isArray(value.mappings) ||
        !Array.isArray(value.integrations) ||
        !Array.isArray(value.qualities) ||
        !Array.isArray(value.challenges) ||
        !Array.isArray(value.protocolIssues)
    ) {
        throw new Error("goal ledger projection is malformed")
    }
    if (
        expectedContract &&
        value.contractId !== expectedContract.contractId
    ) {
        throw new Error("goal ledger projection contract does not match GoalEnvelope")
    }

    const knownInvariantIds = expectedContract
        ? new Set(expectedContract.invariants.map(({ id }) => id))
        : null
    const mappings = value.mappings.map((item, index) => {
        if (
            !plainRecord(item) ||
            !nonBlank(item.storyId) ||
            !stringArray(item.invariantIds) ||
            new Set(item.invariantIds).size !== item.invariantIds.length ||
            (knownInvariantIds &&
                item.invariantIds.some((id) => !knownInvariantIds.has(id)))
        ) {
            throw new Error(`goal ledger mapping ${index} is malformed`)
        }
        return {
            storyId: item.storyId,
            invariantIds: [...item.invariantIds],
        }
    })
    assertUnique(mappings.map(({ storyId }) => storyId), "goal ledger story mapping")

    const integrations = value.integrations.map((item, index) => {
        if (
            !plainRecord(item) ||
            !nonBlank(item.storyId) ||
            (item.leaseId !== undefined && !nonBlank(item.leaseId))
        ) {
            throw new Error(`goal ledger integration ${index} is malformed`)
        }
        return {
            storyId: item.storyId,
            ...(item.leaseId ? { leaseId: item.leaseId } : {}),
        }
    })
    assertUnique(
        integrations.map(({ storyId }) => storyId),
        "goal ledger integration",
    )

    const qualities = value.qualities.map((item, index) => {
        if (
            !plainRecord(item) ||
            !nonBlank(item.storyId) ||
            !nonBlank(item.leaseId) ||
            !nonBlank(item.evaluationId) ||
            (item.status !== "passed" &&
                item.status !== "failed" &&
                item.status !== "inconclusive") ||
            typeof item.independentlyPassed !== "boolean" ||
            (item.independentlyPassed && item.status !== "passed")
        ) {
            throw new Error(`goal ledger quality ${index} is malformed`)
        }
        return {
            storyId: item.storyId,
            leaseId: item.leaseId,
            evaluationId: item.evaluationId,
            status: item.status,
            independentlyPassed: item.independentlyPassed,
        } as GoalQualityEvidence
    })
    assertUnique(
        qualities.map(({ storyId, leaseId }) => `${storyId}\u0000${leaseId}`),
        "goal ledger story/lease quality",
    )

    const challenges = value.challenges.map((item, index) => {
        if (
            !plainRecord(item) ||
            !nonBlank(item.challengeId) ||
            !nonBlank(item.invariantId) ||
            !nonBlank(item.raisedBy) ||
            !nonBlank(item.reason) ||
            (item.storyId !== undefined && !nonBlank(item.storyId)) ||
            (knownInvariantIds && !knownInvariantIds.has(item.invariantId))
        ) {
            throw new Error(`goal ledger challenge ${index} is malformed`)
        }
        let resolution: GoalInvariantChallengeResolution | undefined
        if (item.resolution !== undefined) {
            if (
                !plainRecord(item.resolution) ||
                item.resolution.challengeId !== item.challengeId ||
                (item.resolution.resolution !== "resolved" &&
                    item.resolution.resolution !== "rejected") ||
                !nonBlank(item.resolution.reason)
            ) {
                throw new Error(
                    `goal ledger challenge resolution ${index} is malformed`,
                )
            }
            resolution = {
                challengeId: item.challengeId,
                resolution: item.resolution.resolution,
                reason: item.resolution.reason,
            }
        }
        const remediation = item.remediation === undefined
            ? undefined
            : normalizeRemediationBinding(item.remediation)
        return {
            challengeId: item.challengeId,
            invariantId: item.invariantId,
            raisedBy: item.raisedBy,
            reason: item.reason,
            ...(item.storyId ? { storyId: item.storyId } : {}),
            ...(remediation ? { remediation } : {}),
            ...(resolution ? { resolution } : {}),
        }
    })
    assertUnique(
        challenges.map(({ challengeId }) => challengeId),
        "goal ledger challenge",
    )

    const protocolIssues = value.protocolIssues.map((item, index) => {
        if (
            !plainRecord(item) ||
            (item.scope !== "mapping" && item.scope !== "challenge") ||
            !nonBlank(item.key) ||
            !nonBlank(item.reason)
        ) {
            throw new Error(`goal ledger protocol issue ${index} is malformed`)
        }
        return {
            scope: item.scope,
            key: item.key,
            reason: item.reason,
        } as GoalProtocolIssue
    })
    assertUnique(
        protocolIssues.map(({ scope, key }) => `${scope}\u0000${key}`),
        "goal ledger protocol issue",
    )

    return deepFreeze({
        schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
        contractId: value.contractId,
        revision: Number(value.revision),
        mappings,
        integrations,
        qualities,
        challenges,
        protocolIssues,
    })
}

function nonEmpty(value: string): string {
    const normalized = value.trim()
    if (normalized.length === 0) throw new Error("goal ledger ids and text cannot be empty")
    return normalized
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)]
}

function sameChallenge(left: StoredChallenge, right: StoredChallenge): boolean {
    return (
        left.challengeId === right.challengeId &&
        left.invariantId === right.invariantId &&
        left.raisedBy === right.raisedBy &&
        left.reason === right.reason &&
        left.storyId === right.storyId
    )
}

function normalizeRemediationBinding(
    value: unknown,
): GoalInvariantRemediationBinding {
    if (
        !plainRecord(value) ||
        !nonBlank(value.proposalId) ||
        !nonBlank(value.storyId) ||
        (value.status !== "requested" && value.status !== "admitted") ||
        (value.status === "requested" && value.graphVersion !== undefined) ||
        (value.status === "admitted" &&
            (!Number.isSafeInteger(value.graphVersion) ||
                Number(value.graphVersion) < 1))
    ) {
        throw new Error("goal challenge remediation binding is malformed")
    }
    return Object.freeze({
        proposalId: value.proposalId,
        storyId: value.storyId,
        status: value.status,
        ...(value.status === "admitted"
            ? { graphVersion: Number(value.graphVersion) }
            : {}),
    })
}

function compareQuality(left: StoredQuality, right: StoredQuality): number {
    return (
        left.storyId.localeCompare(right.storyId) ||
        left.leaseId.localeCompare(right.leaseId) ||
        left.evaluationId.localeCompare(right.evaluationId)
    )
}

function compareProtocolIssue(
    left: GoalProtocolIssue,
    right: GoalProtocolIssue,
): number {
    return left.scope.localeCompare(right.scope) || left.key.localeCompare(right.key)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function assertUnique(values: readonly string[], label: string): void {
    if (new Set(values).size !== values.length) {
        throw new Error(`${label} contains duplicate keys`)
    }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || typeof value !== "object") return value
    const object = value as object
    if (seen.has(object)) return value
    seen.add(object)
    for (const key of Reflect.ownKeys(object)) {
        deepFreeze((object as Record<PropertyKey, unknown>)[key], seen)
    }
    return Object.freeze(value)
}
