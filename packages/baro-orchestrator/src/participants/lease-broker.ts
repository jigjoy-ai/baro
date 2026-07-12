import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    RunCompleted,
    StoryQualityCompleted,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    StorySpawnFailed,
    WorkBid,
    WorkBidWindowClosed,
    WorkClaimed,
    WorkLeaseGranted,
    WorkLeaseExpired,
    WorkLeaseReleased,
    WorkOfferExpired,
    WorkOffered,
    WorkerCapabilityAdvertised,
    type WorkBidData,
    type WorkClaimedData,
    type WorkLeaseGrantedData,
    type WorkOfferedData,
    type WorkerCapabilityAdvertisedData,
} from "../semantic-events.js"
import {
    isValidWorkBidEstimate,
    selectWorkBid,
    type WorkBidPolicy,
} from "../work-market.js"
import { isProviderCapacityFailure } from "../provider-failure.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface LeaseBrokerOptions {
    runId: string
    /** Optional Board authority; setter form avoids the Board/Broker constructor cycle. */
    offerAuthority?: Participant
    /** Optional repository authority allowed to publish merge outcomes. */
    integrationAuthority?: Participant
    parallel?: number
    intraLevelDelaySecs?: number
    claimTimeoutMs?: number
    /** Optional hard cap for execution; disabled unless explicitly set. */
    leaseTimeoutMs?: number
    /** Optional cap after successful execution while repository integration runs. */
    integrationTimeoutMs?: number
    /** Opt-in deterministic bid market. Absent preserves first-claim behavior. */
    market?: {
        bidWindowMs?: number
        policy?: WorkBidPolicy
    }
    /** Dynamic execution capabilities for terminal result/spawn-failure sources. */
    outcomeAuthority?: StoryOutcomeAuthority
}

interface PendingClaim {
    offer: WorkOfferedData
    claim: WorkClaimedData
    /** Market alternatives retained so an unavailable winner can be replaced
     * without opening a second, order-sensitive auction. */
    candidates?: readonly WorkBidData[]
}

interface RegisteredWorker {
    source: Participant
    advertisement: WorkerCapabilityAdvertisedData
}

export class LeaseBroker extends SerializedObserver {
    private readonly opts: LeaseBrokerOptions
    private readonly offers = new Map<string, WorkOfferedData>()
    private readonly earlyClaims = new Map<string, WorkClaimedData>()
    private readonly workers = new Map<string, RegisteredWorker>()
    private readonly bids = new Map<string, Map<string, WorkBidData>>()
    private readonly earlyBids = new Map<string, Map<string, WorkBidData>>()
    private readonly closedOfferIds = new Set<string>()
    private readonly offerTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly pending: PendingClaim[] = []
    private readonly activeByStory = new Map<string, WorkLeaseGrantedData>()
    private readonly activeLeaseIds = new Set<string>()
    private readonly leaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly unavailableRouteIds = new Set<string>()
    private readonly unavailableWorkerIds = new Set<string>()
    private nextLease = 1
    private nextGrantAt = 0
    private grantTimer: ReturnType<typeof setTimeout> | null = null
    private stopped = false
    private offerAuthority: Participant | null
    private integrationAuthority: Participant | null
    private qualityAuthority: Participant | null = null

    constructor(opts: LeaseBrokerOptions) {
        super()
        this.opts = snapshotOptions(opts)
        this.offerAuthority = this.opts.offerAuthority ?? null
        this.integrationAuthority = this.opts.integrationAuthority ?? null
        if (this.opts.market) {
            const windowMs = this.opts.market.bidWindowMs ?? this.opts.claimTimeoutMs ?? 1_000
            if (!Number.isFinite(windowMs) || windowMs < 0) {
                throw new RangeError("market bidWindowMs must be finite and non-negative")
            }
            // Reuse the pure policy validator at configuration time so an
            // invalid policy cannot strand a live offer in the mailbox.
            selectWorkBid([], this.opts.market.policy)
        }
    }

    /** Bind the only Board allowed to publish work offers. */
    setOfferAuthority(authority: Participant): void {
        if (this.offerAuthority && this.offerAuthority !== authority) {
            throw new Error("lease broker offer authority is already bound")
        }
        this.offerAuthority = authority
    }

    /** Bind the only repository participant allowed to settle merge outcomes. */
    setIntegrationAuthority(authority: Participant): void {
        if (
            this.integrationAuthority &&
            this.integrationAuthority !== authority
        ) {
            throw new Error("lease broker integration authority is already bound")
        }
        this.integrationAuthority = authority
    }

    /** Bind the only participant allowed to fail a lease on quality policy. */
    setQualityAuthority(authority: Participant): void {
        if (this.qualityAuthority && this.qualityAuthority !== authority) {
            throw new Error("lease broker quality authority is already bound")
        }
        this.qualityAuthority = authority
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event } = context
        if (WorkerCapabilityAdvertised.is(event)) {
            if (this.opts.market) this.onCapability(event.data, context.source)
            return
        }
        if (WorkOffered.is(event)) {
            if (
                this.offerAuthority !== null &&
                context.source !== this.offerAuthority
            ) return
            this.onOffer(event.data)
            return
        }
        if (WorkBid.is(event)) {
            if (this.opts.market) this.onBid(event.data, context.source)
            return
        }
        if (WorkBidWindowClosed.is(event)) {
            if (this.opts.market && context.internal) {
                this.onBidWindowClosed(event.data)
            }
            return
        }
        if (WorkClaimed.is(event)) {
            // In market mode only the Broker's selected bid may claim work.
            // The selected claim is accepted directly and its bus copy is
            // visibility/audit only, so every external claim is a bypass.
            if (!this.opts.market) this.onClaim(event.data)
            return
        }
        if (StoryMerged.is(event)) {
            if (
                this.integrationAuthority !== null &&
                context.source !== this.integrationAuthority
            ) return
            if (!this.matchesLease(event.data.storyId, event.data.runId, event.data.leaseId)) return
            this.release(event.data.storyId, "integrated")
            return
        }
        if (StoryMergeFailed.is(event)) {
            if (
                this.integrationAuthority !== null &&
                context.source !== this.integrationAuthority
            ) return
            if (!this.matchesLease(event.data.storyId, event.data.runId, event.data.leaseId)) return
            this.release(event.data.storyId, "integration_failed")
            return
        }
        if (StorySpawnFailed.is(event)) {
            if (
                this.opts.outcomeAuthority &&
                !this.opts.outcomeAuthority.matchesSpawnFailure(
                    context.source,
                    event.data,
                )
            ) return
            if (!this.matchesLease(event.data.storyId, event.data.runId, event.data.leaseId)) return
            this.release(event.data.storyId, "spawn_failed")
            return
        }
        if (StoryResult.is(event)) {
            if (
                this.opts.outcomeAuthority &&
                !this.opts.outcomeAuthority.matchesResult(
                    context.source,
                    event.data,
                )
            ) return
            const lease = this.activeByStory.get(event.data.storyId)
            if (
                !lease ||
                event.data.runId !== this.opts.runId ||
                event.data.leaseId !== lease.leaseId ||
                event.data.generation !== lease.generation
            ) return
            if (event.data.success) {
                const integrationTimeoutMs =
                    this.opts.integrationTimeoutMs ?? this.opts.leaseTimeoutMs
                if (integrationTimeoutMs && integrationTimeoutMs > 0) {
                    this.armLeaseTimer(lease, integrationTimeoutMs, "integration")
                }
            } else {
                if (isProviderCapacityFailure(event.data)) {
                    this.suppressLeaseRoute(lease)
                }
                this.release(event.data.storyId, "execution_failed")
            }
            return
        }
        if (StoryQualityCompleted.is(event)) {
            if (
                this.qualityAuthority !== null &&
                context.source === this.qualityAuthority &&
                event.data.status === "failed" &&
                this.matchesLease(
                    event.data.storyId,
                    event.data.runId,
                    event.data.leaseId,
                )
            ) {
                this.release(event.data.storyId, "quality_failed")
            }
            return
        }
        if (
            WorkLeaseExpired.is(event) &&
            context.internal &&
            this.matchesLease(event.data.storyId, event.data.runId, event.data.leaseId)
        ) {
            this.release(event.data.storyId, "expired")
            return
        }
        if (RunCompleted.is(event)) {
            if (
                (this.offerAuthority !== null &&
                    context.source !== this.offerAuthority) ||
                (event.data.runId !== undefined &&
                    event.data.runId !== this.opts.runId)
            ) return
            this.stop()
        }
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        process.stderr.write(`[lease-broker] ${failure.error.message}\n`)
    }

    private onOffer(offer: WorkOfferedData): void {
        if (this.stopped || offer.runId !== this.opts.runId) return
        offer = snapshotOffer(offer)
        if (
            this.closedOfferIds.has(offer.offerId) ||
            this.offers.has(offer.offerId) ||
            this.activeByStory.has(offer.request.storyId)
        ) {
            return
        }
        this.offers.set(offer.offerId, offer)
        if (this.opts.market) {
            const early = this.earlyBids.get(offer.offerId)
            if (early) {
                this.earlyBids.delete(offer.offerId)
                for (const bid of early.values()) {
                    if (this.matchesOffer(bid, offer) && this.isRegisteredBid(bid)) {
                        this.storeBid(this.bids, bid)
                    }
                }
            }
            this.armBidWindow(offer)
            return
        }
        const earlyClaim = this.earlyClaims.get(offer.offerId)
        if (earlyClaim) {
            this.earlyClaims.delete(offer.offerId)
            this.onClaim(earlyClaim)
            return
        }
        const timeoutMs = this.opts.claimTimeoutMs ?? 1_000
        const timer = setTimeout(() => {
            this.offerTimers.delete(offer.offerId)
            if (!this.offers.delete(offer.offerId)) return
            this.emit(
                WorkOfferExpired.create({
                    runId: this.opts.runId,
                    offerId: offer.offerId,
                    storyId: offer.request.storyId,
                    reason: `no worker claimed the offer within ${timeoutMs}ms`,
                }),
            )
        }, timeoutMs)
        this.offerTimers.set(offer.offerId, timer)
    }

    private onCapability(
        advertisement: WorkerCapabilityAdvertisedData,
        source: Participant,
    ): void {
        if (
            this.stopped ||
            advertisement.runId !== this.opts.runId ||
            !validAdvertisement(advertisement)
        ) return

        const existing = this.workers.get(advertisement.workerId)
        if (existing && existing.source !== source) return
        this.workers.set(advertisement.workerId, {
            source,
            advertisement: snapshotAdvertisement(advertisement),
        })
    }

    private onBid(bid: WorkBidData, source: Participant): void {
        if (
            this.stopped ||
            bid.runId !== this.opts.runId ||
            this.closedOfferIds.has(bid.offerId) ||
            !this.isRegisteredBid(bid, source)
        ) return

        const offer = this.offers.get(bid.offerId)
        if (offer) {
            if (!this.matchesOffer(bid, offer)) return
            this.storeBid(this.bids, bid)
            return
        }
        this.storeBid(this.earlyBids, bid)
    }

    private onBidWindowClosed(data: {
        runId: string
        offerId: string
        storyId: string
        generation: number
    }): void {
        if (this.stopped || data.runId !== this.opts.runId) return
        const offer = this.offers.get(data.offerId)
        if (
            !offer ||
            offer.request.storyId !== data.storyId ||
            offer.generation !== data.generation
        ) return

        this.closedOfferIds.add(offer.offerId)
        this.offers.delete(offer.offerId)
        this.clearOfferTimer(offer.offerId)

        const candidates = [...(this.bids.get(offer.offerId)?.values() ?? [])]
            .filter((bid) => this.matchesOffer(bid, offer) && this.isRegisteredBid(bid))
        this.bids.delete(offer.offerId)
        this.earlyBids.delete(offer.offerId)

        const winner = selectWorkBid(candidates, this.opts.market?.policy)
        if (!winner) {
            const timeoutMs = this.marketBidWindowMs()
            this.emit(
                WorkOfferExpired.create({
                    runId: this.opts.runId,
                    offerId: offer.offerId,
                    storyId: offer.request.storyId,
                    reason: `no eligible worker bid within ${timeoutMs}ms`,
                }),
            )
            return
        }

        const claim: WorkClaimedData = {
            runId: this.opts.runId,
            offerId: offer.offerId,
            storyId: offer.request.storyId,
            workerId: winner.workerId,
            backend: winner.route.backend,
            model: winner.route.model,
            bidId: winner.bidId,
            route: { ...winner.route },
        }
        this.emit(WorkClaimed.create(claim))
        this.acceptClaim(offer, claim, candidates)
    }

    private armBidWindow(offer: WorkOfferedData): void {
        const timeoutMs = this.marketBidWindowMs()
        const timer = setTimeout(() => {
            if (this.stopped || !this.offers.has(offer.offerId)) return
            this.emit(
                WorkBidWindowClosed.create({
                    runId: this.opts.runId,
                    offerId: offer.offerId,
                    storyId: offer.request.storyId,
                    generation: offer.generation,
                }),
            )
        }, timeoutMs)
        this.offerTimers.set(offer.offerId, timer)
    }

    private marketBidWindowMs(): number {
        return this.opts.market?.bidWindowMs ?? this.opts.claimTimeoutMs ?? 1_000
    }

    private matchesOffer(bid: WorkBidData, offer: WorkOfferedData): boolean {
        return (
            bid.runId === offer.runId &&
            bid.offerId === offer.offerId &&
            bid.storyId === offer.request.storyId &&
            bid.generation === offer.generation &&
            !this.bidUnavailable(bid) &&
            !offer.excludedRouteIds?.includes(bid.route.routeId)
        )
    }

    private isRegisteredBid(bid: WorkBidData, source?: Participant): boolean {
        if (
            !bid.bidId ||
            !bid.workerId ||
            this.bidUnavailable(bid) ||
            !validRoute(bid.route) ||
            !isValidWorkBidEstimate(bid.estimate) ||
            (bid.estimate.estimateSource !== "configured" &&
                bid.estimate.estimateSource !== "historical")
        ) return false

        const worker = this.workers.get(bid.workerId)
        if (!worker || (source !== undefined && worker.source !== source)) return false
        const capabilities = worker.advertisement.capabilities
        if (!capabilities.backends.includes(bid.route.backend)) return false
        const routes = capabilities.routes
        return !routes?.length || routes.some((route) => sameRoute(route, bid.route))
    }

    private storeBid(
        target: Map<string, Map<string, WorkBidData>>,
        bid: WorkBidData,
    ): void {
        let byId = target.get(bid.offerId)
        if (!byId) {
            byId = new Map()
            target.set(bid.offerId, byId)
        }
        if (!byId.has(bid.bidId)) byId.set(bid.bidId, snapshotBid(bid))
    }

    private onClaim(claim: WorkClaimedData): void {
        if (
            this.stopped ||
            claim.runId !== this.opts.runId
        ) return
        const offer = this.offers.get(claim.offerId)
        if (!offer) {
            if (
                !this.claimUnavailable(claim) &&
                !this.earlyClaims.has(claim.offerId)
            ) {
                this.earlyClaims.set(claim.offerId, snapshotClaim(claim))
            }
            return
        }
        if (offer.request.storyId !== claim.storyId) return
        this.acceptClaim(offer, claim)
    }

    private acceptClaim(
        offer: WorkOfferedData,
        claim: WorkClaimedData,
        candidates?: readonly WorkBidData[],
    ): void {
        if (this.pending.some((entry) => entry.offer.offerId === claim.offerId)) return
        if (this.claimUnavailable(claim)) {
            this.offers.delete(claim.offerId)
            this.clearOfferTimer(claim.offerId)
            this.emit(
                WorkOfferExpired.create({
                    runId: this.opts.runId,
                    offerId: offer.offerId,
                    storyId: offer.request.storyId,
                    reason: `worker ${claim.workerId} is unavailable for this run`,
                }),
            )
            return
        }

        this.offers.delete(claim.offerId)
        this.clearOfferTimer(claim.offerId)
        this.pending.push({
            offer,
            claim,
            ...(candidates
                ? { candidates: candidates.map((candidate) => snapshotBid(candidate)) }
                : {}),
        })
        this.pump()
    }

    private pump(): void {
        if (this.stopped || this.grantTimer) return
        const cap = this.opts.parallel && this.opts.parallel > 0
            ? this.opts.parallel
            : Number.MAX_SAFE_INTEGER
        if (this.activeByStory.size >= cap || this.pending.length === 0) return

        const now = Date.now()
        if (now < this.nextGrantAt) {
            this.grantTimer = setTimeout(() => {
                this.grantTimer = null
                this.pump()
            }, this.nextGrantAt - now)
            return
        }

        this.refreshUnavailablePending()
        if (this.pending.length === 0) return

        const pendingIndex = this.pending.findIndex(({ claim }) =>
            this.workerHasCapacity(claim.workerId),
        )
        if (pendingIndex < 0) return
        const [{ offer, claim }] = this.pending.splice(pendingIndex, 1)
        if (this.activeByStory.has(offer.request.storyId)) {
            this.pump()
            return
        }

        const lease: WorkLeaseGrantedData = {
            runId: this.opts.runId,
            offerId: offer.offerId,
            leaseId: `${this.opts.runId}:lease:${this.nextLease++}`,
            workerId: claim.workerId,
            generation: offer.generation,
            request: offer.request,
            ...(claim.bidId ? { bidId: claim.bidId } : {}),
            ...(claim.route ? { route: { ...claim.route } } : {}),
        }
        this.activeByStory.set(offer.request.storyId, lease)
        this.activeLeaseIds.add(lease.leaseId)
        const delayMs = Math.max(0, this.opts.intraLevelDelaySecs ?? 0) * 1_000
        this.nextGrantAt = Date.now() + delayMs
        this.emit(WorkLeaseGranted.create(lease))
        if (this.opts.leaseTimeoutMs && this.opts.leaseTimeoutMs > 0) {
            this.armLeaseTimer(lease, this.opts.leaseTimeoutMs, "execution")
        }
        this.pump()
    }

    private workerHasCapacity(workerId: string): boolean {
        const limit = this.workers.get(workerId)?.advertisement.capabilities.maxConcurrent
        if (limit === undefined) return true
        let active = 0
        for (const lease of this.activeByStory.values()) {
            if (lease.workerId === workerId) active += 1
        }
        return active < limit
    }

    private suppressLeaseRoute(lease: WorkLeaseGrantedData): void {
        this.unavailableWorkerIds.add(lease.workerId)
        if (lease.route?.routeId) {
            this.unavailableRouteIds.add(lease.route.routeId)
        }
    }

    private bidUnavailable(bid: Pick<WorkBidData, "workerId" | "route">): boolean {
        return (
            this.unavailableWorkerIds.has(bid.workerId) ||
            this.unavailableRouteIds.has(bid.route.routeId)
        )
    }

    private claimUnavailable(claim: WorkClaimedData): boolean {
        return (
            this.unavailableWorkerIds.has(claim.workerId) ||
            (claim.route !== undefined &&
                this.unavailableRouteIds.has(claim.route.routeId))
        )
    }

    private refreshUnavailablePending(): void {
        for (let index = this.pending.length - 1; index >= 0; index -= 1) {
            const entry = this.pending[index]!
            if (!this.claimUnavailable(entry.claim)) continue

            const winner = entry.candidates
                ? selectWorkBid(
                      entry.candidates.filter(
                          (candidate) =>
                              this.matchesOffer(candidate, entry.offer) &&
                              this.isRegisteredBid(candidate),
                      ),
                      this.opts.market?.policy,
                  )
                : null
            if (winner) {
                entry.claim = claimFromBid(this.opts.runId, entry.offer, winner)
                this.emit(WorkClaimed.create(entry.claim))
                continue
            }

            this.pending.splice(index, 1)
            this.emit(
                WorkOfferExpired.create({
                    runId: this.opts.runId,
                    offerId: entry.offer.offerId,
                    storyId: entry.offer.request.storyId,
                    reason: "all eligible routes for the pending offer became unavailable",
                }),
            )
        }
    }

    private clearOfferTimer(offerId: string): void {
        const timer = this.offerTimers.get(offerId)
        if (timer) clearTimeout(timer)
        this.offerTimers.delete(offerId)
    }

    private release(
        storyId: string,
        reason: "integrated" | "execution_failed" | "quality_failed" | "integration_failed" | "spawn_failed" | "aborted" | "expired",
    ): void {
        const lease = this.activeByStory.get(storyId)
        if (!lease || !this.activeLeaseIds.delete(lease.leaseId)) return
        this.activeByStory.delete(storyId)
        const timer = this.leaseTimers.get(lease.leaseId)
        if (timer) clearTimeout(timer)
        this.leaseTimers.delete(lease.leaseId)
        this.emit(
            WorkLeaseReleased.create({
                runId: this.opts.runId,
                offerId: lease.offerId,
                leaseId: lease.leaseId,
                storyId,
                workerId: lease.workerId,
                reason,
            }),
        )
        this.pump()
    }

    private matchesLease(
        storyId: string,
        runId: string | undefined,
        leaseId: string | undefined,
    ): boolean {
        return (
            runId === this.opts.runId &&
            leaseId !== undefined &&
            this.activeByStory.get(storyId)?.leaseId === leaseId
        )
    }

    private armLeaseTimer(
        lease: WorkLeaseGrantedData,
        timeoutMs: number,
        phase: "execution" | "integration",
    ): void {
        const previous = this.leaseTimers.get(lease.leaseId)
        if (previous) clearTimeout(previous)
        const timer = setTimeout(() => {
            const active = this.activeByStory.get(lease.request.storyId)
            if (active?.leaseId !== lease.leaseId) return
            this.emit(
                WorkLeaseExpired.create({
                    runId: this.opts.runId,
                    offerId: lease.offerId,
                    leaseId: lease.leaseId,
                    storyId: lease.request.storyId,
                    workerId: lease.workerId,
                    reason: `${phase} lease expired after ${timeoutMs}ms`,
                }),
            )
        }, timeoutMs)
        this.leaseTimers.set(lease.leaseId, timer)
    }

    private stop(): void {
        this.stopped = true
        if (this.grantTimer) clearTimeout(this.grantTimer)
        this.grantTimer = null
        for (const timer of this.offerTimers.values()) clearTimeout(timer)
        for (const timer of this.leaseTimers.values()) clearTimeout(timer)
        this.offerTimers.clear()
        this.leaseTimers.clear()
        this.offers.clear()
        this.earlyClaims.clear()
        this.workers.clear()
        this.bids.clear()
        this.earlyBids.clear()
        this.closedOfferIds.clear()
        this.unavailableRouteIds.clear()
        this.unavailableWorkerIds.clear()
        this.pending.length = 0
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}

function validAdvertisement(item: WorkerCapabilityAdvertisedData): boolean {
    const { capabilities } = item
    if (
        !item.workerId ||
        !capabilities.backends.every((backend) => backend.length > 0) ||
        (capabilities.maxConcurrent !== undefined &&
            (!Number.isInteger(capabilities.maxConcurrent) ||
                capabilities.maxConcurrent <= 0))
    ) return false
    return capabilities.routes?.every(validRoute) ?? true
}

function validRoute(route: {
    routeId: string
    backend: string
    model: string
}): boolean {
    return Boolean(route.routeId && route.backend && route.model)
}

function sameRoute(
    a: { routeId: string; backend: string; model: string },
    b: { routeId: string; backend: string; model: string },
): boolean {
    return (
        a.routeId === b.routeId &&
        a.backend === b.backend &&
        a.model === b.model
    )
}

function snapshotAdvertisement(
    item: WorkerCapabilityAdvertisedData,
): WorkerCapabilityAdvertisedData {
    return {
        ...item,
        capabilities: {
            ...item.capabilities,
            backends: [...item.capabilities.backends],
            ...(item.capabilities.routes
                ? { routes: item.capabilities.routes.map((route) => ({ ...route })) }
                : {}),
        },
    }
}

function snapshotBid(bid: WorkBidData): WorkBidData {
    return {
        ...bid,
        route: { ...bid.route },
        estimate: { ...bid.estimate },
    }
}

function snapshotOffer(offer: WorkOfferedData): WorkOfferedData {
    return {
        ...offer,
        ...(offer.excludedRouteIds
            ? { excludedRouteIds: [...offer.excludedRouteIds] }
            : {}),
        request: {
            ...offer.request,
            ...(offer.request.recovery
                ? { recovery: { ...offer.request.recovery } }
                : {}),
        },
    }
}

function claimFromBid(
    runId: string,
    offer: WorkOfferedData,
    winner: WorkBidData,
): WorkClaimedData {
    return {
        runId,
        offerId: offer.offerId,
        storyId: offer.request.storyId,
        workerId: winner.workerId,
        backend: winner.route.backend,
        model: winner.route.model,
        bidId: winner.bidId,
        route: { ...winner.route },
    }
}

function snapshotClaim(claim: WorkClaimedData): WorkClaimedData {
    return {
        ...claim,
        ...(claim.route ? { route: { ...claim.route } } : {}),
    }
}

function snapshotOptions(opts: LeaseBrokerOptions): LeaseBrokerOptions {
    return {
        ...opts,
        ...(opts.market
            ? {
                  market: {
                      bidWindowMs: opts.market.bidWindowMs,
                      ...(opts.market.policy
                          ? { policy: { ...opts.market.policy } }
                          : {}),
                  },
              }
            : {}),
    }
}
