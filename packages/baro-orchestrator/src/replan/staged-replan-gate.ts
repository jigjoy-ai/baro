/**
 * Serializes runtime replan proposals against the offer lifecycle: a
 * proposal touching stories with open offers must first retract each
 * offer through the Broker — or fail closed at the retraction watchdog —
 * before its graph transaction may run. One stage at a time; later
 * proposals queue behind it. The host keeps the graph transaction
 * itself, the rejection protocol, and the timer clock.
 */

import type { SemanticEvent } from "../runtime/mozaik.js"

import {
    sameOfferRetractionCorrelation,
    type WorkOfferDesk,
} from "../market/work-offer-desk.js"
import { runtimeProposalFingerprint } from "../runtime/runtime-replan-fingerprint.js"
import {
    WorkOfferRetractionRequested,
    defineSemanticEvent,
    type RuntimeReplanProposedData,
    type WorkOfferRetractionRequestedData,
    type WorkOfferRetractionResolvedData,
} from "../semantic-events.js"

export interface QueuedRuntimeReplan {
    proposal: RuntimeReplanProposedData
    fingerprint: string
    requireActiveLease: boolean
}

interface StagedRuntimeReplan extends QueuedRuntimeReplan {
    stageId: string
    retractions: Map<
        string,
        {
            request: WorkOfferRetractionRequestedData
            resolution?: WorkOfferRetractionResolvedData
        }
    >
}

export interface RuntimeReplanRetractionTimedOutData {
    runId: string
    stageId: string
    proposalId: string
}

export const RuntimeReplanRetractionTimedOut =
    defineSemanticEvent<RuntimeReplanRetractionTimedOutData>(
        "runtime_replan_retraction_timed_out",
    )

export function runtimeReplanTargetIds(
    proposal: RuntimeReplanProposedData | undefined,
): Set<string> {
    if (!proposal) return new Set()
    return new Set([
        ...proposal.mutation.removedStoryIds,
        ...Object.keys(proposal.mutation.modifiedDeps),
    ])
}

export interface StagedReplanGateHost {
    emit(event: SemanticEvent<unknown>): void
    planningFailed(): boolean
    graphVersion(): number
    /** Run the graph transaction now. Stories whose offers resolved as
     * leased are pinned immutable; retracted ones ride along so a
     * replayed decision can restore them. */
    execute(
        queued: QueuedRuntimeReplan,
        leasedStoryIds: readonly string[],
        retractedStoryIds: readonly string[],
    ): void
    armRetractionTimer(fire: () => void): void
    clearRetractionTimer(): void
    /** Fail the stage closed after the retraction watchdog. */
    rejectRetractionTimeout(
        proposal: RuntimeReplanProposedData,
        retractedStoryIds: readonly string[],
    ): void
}

export class StagedReplanGate {
    private stageSequence = 0
    private readonly queue: QueuedRuntimeReplan[] = []
    private staged: StagedRuntimeReplan | null = null

    constructor(
        private readonly runId: string,
        private readonly offers: WorkOfferDesk,
        private readonly host: StagedReplanGateHost,
    ) {}

    enqueue(
        proposal: RuntimeReplanProposedData,
        options: { requireActiveLease?: boolean } = {},
    ): void {
        if (this.host.planningFailed()) return
        const queued: QueuedRuntimeReplan = {
            proposal: structuredClone(proposal),
            fingerprint: runtimeProposalFingerprint(proposal),
            requireActiveLease: options.requireActiveLease !== false,
        }
        const duplicate = [
            ...(this.staged ? [this.staged] : []),
            ...this.queue,
        ].some(
            (candidate) =>
                candidate.proposal.proposalId === proposal.proposalId &&
                candidate.fingerprint === queued.fingerprint,
        )
        if (duplicate) return
        this.queue.push(queued)
        this.drain()
    }

    targetsStory(storyId: string): boolean {
        return runtimeReplanTargetIds(this.staged?.proposal).has(storyId)
    }

    isOfferAwaitingRetraction(offerId: string): boolean {
        for (const entry of this.staged?.retractions.values() ?? []) {
            if (entry.request.offerId === offerId) return true
        }
        return false
    }

    /** True when the resolution belongs to the active stage (consumed
     * or dropped there); false hands it to the host's abandoned-ledger
     * path. */
    onRetractionResolved(
        resolution: WorkOfferRetractionResolvedData,
    ): boolean {
        const staged = this.staged
        const entry = staged?.retractions.get(resolution.retractionId)
        if (!staged || !entry) return false
        if (
            entry.resolution ||
            !sameOfferRetractionCorrelation(entry.request, resolution)
        ) return true
        entry.resolution = structuredClone(resolution)
        if (resolution.disposition === "retracted") {
            const active = this.offers.offerFor(resolution.storyId)
            if (active?.data.offerId === resolution.offerId) {
                this.offers.deleteOffer(resolution.storyId)
            }
        }
        if (
            [...staged.retractions.values()].every(
                (candidate) => candidate.resolution !== undefined,
            )
        ) {
            this.finishStage(staged)
        }
        return true
    }

    onRetractionTimedOut(
        timeout: RuntimeReplanRetractionTimedOutData,
    ): void {
        const staged = this.staged
        if (
            !staged ||
            staged.stageId !== timeout.stageId ||
            staged.proposal.proposalId !== timeout.proposalId
        ) return
        this.host.clearRetractionTimer()
        this.staged = null
        const retractedStoryIds: string[] = []
        for (const entry of staged.retractions.values()) {
            if (entry.resolution?.disposition === "retracted") {
                retractedStoryIds.push(entry.request.storyId)
            } else if (!entry.resolution) {
                this.offers.abandonRetraction(entry.request)
            }
        }
        this.host.rejectRetractionTimeout(staged.proposal, retractedStoryIds)
        this.drain()
    }

    private drain(): void {
        if (this.staged || this.host.planningFailed()) return
        for (;;) {
            const queued = this.queue.shift()
            if (!queued) return
            const targetIds = runtimeReplanTargetIds(queued.proposal)
            const offers = this.offers.offersFor(targetIds)
            if (offers.length === 0) {
                this.host.execute(queued, [], [])
                continue
            }

            const stageId =
                `${this.runId}:runtime-replan-stage:` +
                `${++this.stageSequence}`
            const staged: StagedRuntimeReplan = {
                ...queued,
                stageId,
                retractions: new Map(),
            }
            for (const offer of offers) {
                const data = offer.data
                const request: WorkOfferRetractionRequestedData = {
                    runId: this.runId,
                    proposalId: queued.proposal.proposalId,
                    retractionId: `${stageId}:${data.offerId}`,
                    offerId: data.offerId,
                    storyId: data.request.storyId,
                    generation: data.generation,
                    graphVersion: this.host.graphVersion(),
                }
                staged.retractions.set(request.retractionId, { request })
            }
            this.staged = staged
            this.host.armRetractionTimer(() => {
                this.host.emit(
                    RuntimeReplanRetractionTimedOut.create({
                        runId: this.runId,
                        stageId: staged.stageId,
                        proposalId: staged.proposal.proposalId,
                    }),
                )
            })
            for (const { request } of staged.retractions.values()) {
                this.host.emit(WorkOfferRetractionRequested.create(request))
            }
            return
        }
    }

    private finishStage(staged: StagedRuntimeReplan): void {
        if (this.staged !== staged) return
        this.host.clearRetractionTimer()
        this.staged = null
        const resolutions = [...staged.retractions.values()].map(
            ({ resolution }) => resolution!,
        )
        const retractedStoryIds = resolutions
            .filter(({ disposition }) => disposition === "retracted")
            .map(({ storyId }) => storyId)
        const leasedStoryIds = resolutions
            .filter(({ disposition }) => disposition === "leased")
            .map(({ storyId }) => storyId)

        this.host.execute(staged, leasedStoryIds, retractedStoryIds)
        this.drain()
    }
}
