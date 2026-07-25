/**
 * Bookkeeping for the offer lifecycle between "story is ready" and the
 * Broker's lease boundary: pending context requests, published offers,
 * exact-correlation lease consumption, and the retraction ledger for offers
 * whose graph transaction already failed closed. Pure state + validation —
 * the Board keeps every policy decision (who may be offered, offer payload,
 * what a consumed grant or restored story triggers next).
 */

import { isDeepStrictEqual } from "node:util"

import type { PrdStory } from "../prd.js"
import type {
    WorkContextRequestedData,
    WorkLeaseGrantedData,
    WorkOfferedData,
    WorkOfferRetractionRequestedData,
    WorkOfferRetractionResolvedData,
} from "../semantic-events.js"

export interface ActiveWorkOffer {
    data: WorkOfferedData
}

/** One retraction request/resolution pair describes the same exact offer. */
export function sameOfferRetractionCorrelation(
    request: WorkOfferRetractionRequestedData,
    resolution: WorkOfferRetractionResolvedData,
): boolean {
    return (
        request.runId === resolution.runId &&
        request.proposalId === resolution.proposalId &&
        request.retractionId === resolution.retractionId &&
        request.offerId === resolution.offerId &&
        request.storyId === resolution.storyId &&
        request.generation === resolution.generation &&
        request.graphVersion === resolution.graphVersion
    )
}

export class WorkOfferDesk {
    private contextSequence = 0
    private offerSequence = 0
    private readonly contextRequests = new Map<string, PrdStory>()
    /** Published offers which have not crossed the Broker's lease boundary.
     * Planned/context-pending stories deliberately do not appear here. */
    private readonly activeOffers = new Map<string, ActiveWorkOffer>()
    /** A timed-out retraction can still resolve later. Retain its exact
     * correlation so a late retraction restores that story without touching
     * a newer offer. */
    private readonly abandonedRetractions = new Map<
        string,
        WorkOfferRetractionRequestedData
    >()

    constructor(private readonly runId: string) {}

    beginContextRequest(
        story: PrdStory,
        hints: readonly string[],
    ): WorkContextRequestedData {
        const requestId =
            `${this.runId}:context:${++this.contextSequence}:${story.id}`
        this.contextRequests.set(requestId, story)
        return { runId: this.runId, requestId, storyId: story.id, hints }
    }

    /** Consume a provided context; undefined when correlation does not match. */
    takeContextStory(requestId: string, storyId: string): PrdStory | undefined {
        const story = this.contextRequests.get(requestId)
        if (!story || story.id !== storyId) return undefined
        this.contextRequests.delete(requestId)
        return story
    }

    hasContextRequest(storyId: string): boolean {
        for (const story of this.contextRequests.values()) {
            if (story.id === storyId) return true
        }
        return false
    }

    cancelContextRequests(storyId: string): void {
        for (const [requestId, story] of this.contextRequests) {
            if (story.id === storyId) this.contextRequests.delete(requestId)
        }
    }

    nextOfferId(storyId: string): string {
        return `${this.runId}:offer:${++this.offerSequence}:${storyId}`
    }

    recordOffer(offered: WorkOfferedData): void {
        this.activeOffers.set(offered.request.storyId, {
            data: structuredClone(offered),
        })
    }

    offerFor(storyId: string): ActiveWorkOffer | undefined {
        return this.activeOffers.get(storyId)
    }

    offersFor(storyIds: Iterable<string>): ActiveWorkOffer[] {
        const offers: ActiveWorkOffer[] = []
        for (const storyId of storyIds) {
            const offer = this.activeOffers.get(storyId)
            if (offer) offers.push(offer)
        }
        return offers
    }

    hasOffer(storyId: string): boolean {
        return this.activeOffers.has(storyId)
    }

    deleteOffer(storyId: string): void {
        this.activeOffers.delete(storyId)
    }

    /**
     * Consume the offer a Broker grant claims, only on exact correlation
     * (run, offer, generation, and byte-identical request). False leaves
     * every ledger untouched.
     */
    consumeLeaseGrant(grant: WorkLeaseGrantedData): boolean {
        const offer = this.activeOffers.get(grant.request.storyId)
        if (
            !offer ||
            offer.data.runId !== grant.runId ||
            offer.data.offerId !== grant.offerId ||
            offer.data.generation !== grant.generation ||
            !isDeepStrictEqual(offer.data.request, grant.request)
        ) return false
        this.activeOffers.delete(grant.request.storyId)
        return true
    }

    abandonRetraction(request: WorkOfferRetractionRequestedData): void {
        this.abandonedRetractions.set(request.retractionId, request)
    }

    /** Drop every abandoned retraction naming this offer; true if any did. */
    consumeAbandonedByOffer(offerId: string): boolean {
        let consumed = false
        for (const [retractionId, request] of this.abandonedRetractions) {
            if (request.offerId !== offerId) continue
            this.abandonedRetractions.delete(retractionId)
            consumed = true
        }
        return consumed
    }

    /**
     * Settle a late resolution for an abandoned retraction. Returns the
     * story to restore when the resolution proves the old offer was
     * retracted (after dropping any matching still-active offer);
     * null for unknown, mismatched, or non-retracted resolutions.
     */
    resolveAbandonedRetraction(
        resolution: WorkOfferRetractionResolvedData,
    ): string | null {
        const abandoned = this.abandonedRetractions.get(resolution.retractionId)
        if (
            !abandoned ||
            !sameOfferRetractionCorrelation(abandoned, resolution)
        ) return null
        this.abandonedRetractions.delete(resolution.retractionId)
        if (resolution.disposition !== "retracted") return null
        const active = this.activeOffers.get(resolution.storyId)
        if (active?.data.offerId === resolution.offerId) {
            this.activeOffers.delete(resolution.storyId)
        }
        return resolution.storyId
    }
}
