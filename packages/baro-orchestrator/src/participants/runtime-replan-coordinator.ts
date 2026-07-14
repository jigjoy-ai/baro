import {
    savePrdAtomic,
    type PrdFile,
    type PrdRuntimeGraphState,
} from "../prd.js"
import {
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    type RuntimeReplanAppliedData,
    type RuntimeReplanProposedData,
    type RuntimeReplanRejectedData,
} from "../semantic-events.js"
import {
    snapshotRuntimeReplanMutation,
    validateRuntimeReplanMutation,
} from "../runtime-replan.js"
import {
    runtimeDecisionFingerprintMatches,
    runtimeProposalFingerprint,
} from "../runtime/runtime-replan-fingerprint.js"

export interface RuntimeReplanCoordinatorOptions {
    runId: string
    prdPath: string
    maxDynamicStories: number
    adaptationBudget: number
    persist?: (path: string, prd: PrdFile) => void
}

export interface RuntimeReplanDecisionState {
    active: boolean
    prd: PrdFile | null
    immutableStoryIds: Iterable<string>
    activeLease:
        | { leaseId: string; generation: number }
        | undefined
    adaptationsSinceProgress: number
    /** Recovery policy commits are Board-authorized after the wave settles. */
    requireActiveLease?: boolean
    /** Recovery has its own bounded retry budget, separate from discovery. */
    storyAccounting?: "worker" | "policy"
    /** Override the remaining dynamic-add allowance for policy commits. */
    maxAddedStories?: number
}

export type RuntimeReplanDecisionEvent =
    | ReturnType<typeof RuntimeReplanApplied.create>
    | ReturnType<typeof RuntimeReplanRejected.create>

export interface RuntimeReplanDecisionOutcome {
    event: RuntimeReplanDecisionEvent
    /** Present only for the first successful application, never a replay. */
    applied?: {
        prd: PrdFile
        addedStoryIds: readonly string[]
        removedStoryIds: readonly string[]
        modifiedStoryIds: readonly string[]
        affectedStoryIds: readonly string[]
    }
}

interface RememberedDecision {
    fingerprint: string
    event: RuntimeReplanDecisionEvent
}

/**
 * Run-local transaction boundary for optimistic runtime DAG changes.
 *
 * It owns graph versions, idempotency, strict candidate validation, dynamic
 * story budget and persist-before-Applied ordering. The Board remains the
 * authority for lease identity and execution scheduling, and supplies those
 * facts as an immutable decision snapshot.
 */
export class RuntimeReplanCoordinator {
    private graphVersionValue = 0
    private dynamicStories = 0
    private policyStories = 0
    private readonly decisions = new Map<string, RememberedDecision>()
    private readonly persist: (path: string, prd: PrdFile) => void

    constructor(private readonly opts: RuntimeReplanCoordinatorOptions) {
        this.persist = opts.persist ?? savePrdAtomic
    }

    get graphVersion(): number {
        return this.graphVersionValue
    }

    start(prd: PrdFile): void {
        const durable = prd.runtimeGraph
        this.graphVersionValue = durable?.version ?? 1
        this.dynamicStories =
            durable?.runId === this.opts.runId
                ? durable.dynamicStories
                : 0
        this.policyStories =
            durable?.runId === this.opts.runId
                ? durable.policyStories ?? 0
                : 0
        this.decisions.clear()
        if (durable?.runId !== this.opts.runId) return
        const replayable = durable.appliedDecisions.filter(
            runtimeDecisionFingerprintMatches,
        )
        const proposalCounts = countProposalIds(replayable)
        for (const decision of replayable) {
            if (proposalCounts.get(decision.applied.proposalId) !== 1) continue
            const event = RuntimeReplanApplied.create({
                ...decision.applied,
                currentGraphVersion: this.graphVersionValue,
            })
            this.decisions.set(event.data.proposalId, {
                fingerprint: decision.fingerprint,
                event,
            })
        }
    }

    decide(
        proposal: RuntimeReplanProposedData,
        state: RuntimeReplanDecisionState,
    ): RuntimeReplanDecisionOutcome {
        const fingerprint = runtimeProposalFingerprint(proposal)
        const remembered = this.decisions.get(proposal.proposalId)
        if (remembered) {
            if (remembered.fingerprint === fingerprint) {
                return { event: this.refreshRemembered(remembered.event) }
            }
            return {
                event: this.rejection(
                    proposal,
                    "proposal_id_conflict",
                    `proposal id ${proposal.proposalId || "(missing)"} was already used with different content`,
                ),
            }
        }

        if (!state.active || !state.prd) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "run_not_active",
                "runtime graph adaptation is only available while the collective run is active",
            )
        }
        if (proposal.runId !== this.opts.runId) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "invalid_proposal",
                `proposal run ${proposal.runId || "(missing)"} does not match active run ${this.opts.runId}`,
            )
        }
        if (!validRuntimeCorrelation(proposal)) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "invalid_proposal",
                "runtime replan correlation is malformed",
            )
        }
        if (
            state.requireActiveLease !== false &&
            (!state.activeLease ||
                state.activeLease.leaseId !== proposal.leaseId ||
                state.activeLease.generation !== proposal.generation)
        ) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "inactive_source",
                `story ${proposal.sourceStoryId} no longer owns the correlated active lease`,
            )
        }
        if (proposal.baseGraphVersion !== this.graphVersionValue) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "stale_graph_version",
                `proposal was based on graph version ${proposal.baseGraphVersion}; current version is ${this.graphVersionValue}`,
            )
        }
        if (
            this.opts.adaptationBudget > 0 &&
            state.storyAccounting !== "policy" &&
            state.adaptationsSinceProgress >= this.opts.adaptationBudget
        ) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "adaptation_budget_exhausted",
                `runtime adaptation budget (${this.opts.adaptationBudget}) was exhausted without an integrated story`,
            )
        }

        const validation = validateRuntimeReplanMutation(
            state.prd,
            proposal.mutation,
            {
                immutableStoryIds: state.immutableStoryIds,
                maxAddedStories:
                    state.maxAddedStories ??
                    Math.max(
                        0,
                        this.opts.maxDynamicStories - this.dynamicStories,
                    ),
            },
        )
        if (!validation.ok) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                validation.code,
                validation.reason,
            )
        }

        const previousGraphVersion = this.graphVersionValue
        const graphVersion = previousGraphVersion + 1
        const dynamicStories =
            this.dynamicStories +
            (state.storyAccounting === "policy"
                ? 0
                : validation.addedStoryIds.length)
        const policyStories =
            this.policyStories +
            (state.storyAccounting === "policy"
                ? validation.addedStoryIds.length
                : 0)
        const event = RuntimeReplanApplied.create({
            runId: proposal.runId,
            proposalId: proposal.proposalId,
            sourceStoryId: proposal.sourceStoryId,
            leaseId: proposal.leaseId,
            generation: proposal.generation,
            baseGraphVersion: proposal.baseGraphVersion,
            previousGraphVersion,
            graphVersion,
            currentGraphVersion: graphVersion,
            reason: proposal.reason,
            mutation: snapshotRuntimeReplanMutation(proposal.mutation),
        })
        const persistedPrd: PrdFile = {
            ...validation.prd,
            runtimeGraph: this.nextDurableState(
                graphVersion,
                dynamicStories,
                policyStories,
                fingerprint,
                event.data,
            ),
        }
        try {
            // Graph, version and idempotency decision cross one atomic commit
            // boundary. A crash can lose event delivery, never its truth.
            this.persist(this.opts.prdPath, persistedPrd)
        } catch (error) {
            return this.rememberRejected(
                proposal,
                fingerprint,
                "persistence_failed",
                `could not persist runtime graph: ${messageOf(error)}`,
            )
        }

        this.graphVersionValue = graphVersion
        this.dynamicStories = dynamicStories
        this.policyStories = policyStories
        this.decisions.set(proposal.proposalId, { fingerprint, event })
        return {
            event,
            applied: {
                prd: persistedPrd,
                addedStoryIds: validation.addedStoryIds,
                removedStoryIds: validation.removedStoryIds,
                modifiedStoryIds: validation.modifiedStoryIds,
                affectedStoryIds: validation.affectedStoryIds,
            },
        }
    }

    private refreshRemembered(
        event: RuntimeReplanDecisionEvent,
    ): RuntimeReplanDecisionEvent {
        if (RuntimeReplanApplied.is(event)) {
            return RuntimeReplanApplied.create({
                ...event.data,
                currentGraphVersion: this.graphVersionValue,
            })
        }
        return RuntimeReplanRejected.create({
            ...event.data,
            currentGraphVersion: this.graphVersionValue,
        })
    }

    private nextDurableState(
        version: number,
        dynamicStories: number,
        policyStories: number,
        fingerprint: string,
        applied: RuntimeReplanAppliedData,
    ): PrdRuntimeGraphState {
        const appliedDecisions: PrdRuntimeGraphState["appliedDecisions"] = []
        for (const decision of this.decisions.values()) {
            if (!RuntimeReplanApplied.is(decision.event)) continue
            appliedDecisions.push({
                fingerprint: decision.fingerprint,
                applied: structuredClone(decision.event.data),
            })
        }
        appliedDecisions.push({
            fingerprint,
            applied: structuredClone(applied),
        })
        return {
            runId: this.opts.runId,
            version,
            dynamicStories,
            policyStories,
            appliedDecisions: appliedDecisions.slice(-32),
        }
    }

    private rememberRejected(
        proposal: RuntimeReplanProposedData,
        fingerprint: string,
        code: RuntimeReplanRejectedData["code"],
        reason: string,
    ): RuntimeReplanDecisionOutcome {
        const event = this.rejection(proposal, code, reason)
        if (proposal.proposalId) {
            this.decisions.set(proposal.proposalId, { fingerprint, event })
        }
        return { event }
    }

    private rejection(
        proposal: RuntimeReplanProposedData,
        code: RuntimeReplanRejectedData["code"],
        reason: string,
    ): ReturnType<typeof RuntimeReplanRejected.create> {
        return RuntimeReplanRejected.create({
            runId: proposal.runId,
            proposalId: proposal.proposalId,
            sourceStoryId: proposal.sourceStoryId,
            leaseId: proposal.leaseId,
            generation: proposal.generation,
            baseGraphVersion: proposal.baseGraphVersion,
            currentGraphVersion: this.graphVersionValue,
            code,
            reason,
        })
    }
}

function validRuntimeCorrelation(proposal: RuntimeReplanProposedData): boolean {
    return (
        typeof proposal.runId === "string" &&
        proposal.runId.trim().length > 0 &&
        typeof proposal.proposalId === "string" &&
        proposal.proposalId.trim().length > 0 &&
        proposal.proposalId.length <= 256 &&
        typeof proposal.sourceStoryId === "string" &&
        proposal.sourceStoryId.trim().length > 0 &&
        typeof proposal.leaseId === "string" &&
        proposal.leaseId.trim().length > 0 &&
        Number.isInteger(proposal.generation) &&
        proposal.generation >= 0 &&
        Number.isInteger(proposal.baseGraphVersion) &&
        proposal.baseGraphVersion >= 1 &&
        typeof proposal.reason === "string" &&
        proposal.reason.trim().length > 0
    )
}

function countProposalIds(
    decisions: readonly { applied: RuntimeReplanAppliedData }[],
): Map<string, number> {
    const counts = new Map<string, number>()
    for (const decision of decisions) {
        const proposalId = decision.applied.proposalId
        counts.set(proposalId, (counts.get(proposalId) ?? 0) + 1)
    }
    return counts
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}
