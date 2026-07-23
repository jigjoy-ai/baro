/** Work market: capabilities, offers, bids, leases, and work context. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"
import type { WorkBidEstimate } from "../work-market.js"
import type { StorySpawnRequestData } from "./execution.js"

export type CoordinationMode = "legacy" | "collective"

export interface CoordinationModeSelectedData {
    runId: string
    mode: CoordinationMode
}

export const CoordinationModeSelected =
    defineSemanticEvent<CoordinationModeSelectedData>("coordination_mode_selected")

export interface WorkerCapabilities {
    backends: readonly string[]
    supportsAbort: boolean
    supportsLiveFeedback: boolean
    supportsPeerMessages: boolean
    /** Concrete credential-free routes this worker may bid. */
    routes?: readonly WorkRouteDescriptor[]
    /** Optional per-worker execution capacity advertised to the broker. */
    maxConcurrent?: number
}

export interface WorkerCapabilityAdvertisedData {
    runId: string
    workerId: string
    capabilities: WorkerCapabilities
}

export const WorkerCapabilityAdvertised =
    defineSemanticEvent<WorkerCapabilityAdvertisedData>("worker_capability_advertised")

export interface WorkOfferedData {
    runId: string
    offerId: string
    generation: number
    priority: number
    /** Credential-free routes that must not execute this attempt. The Board
     * only adds routes proven unavailable by an authoritative prior lease. */
    excludedRouteIds?: readonly string[]
    request: StorySpawnRequestData
}

export const WorkOffered = defineSemanticEvent<WorkOfferedData>("work_offered")

/** Board-to-Broker cancellation handshake for an offer that a runtime graph
 * mutation wants to retract. The Broker serializes this request against bid,
 * claim and lease decisions; the graph may change only after its resolution. */
export interface WorkOfferRetractionRequestedData {
    runId: string
    proposalId: string
    retractionId: string
    offerId: string
    storyId: string
    generation: number
    graphVersion: number
}

export const WorkOfferRetractionRequested =
    defineSemanticEvent<WorkOfferRetractionRequestedData>(
        "work_offer_retraction_requested",
    )

type WorkOfferRetractionResolutionCorrelation =
    WorkOfferRetractionRequestedData

export type WorkOfferRetractionResolvedData =
    | (WorkOfferRetractionResolutionCorrelation & {
          disposition: "retracted"
      })
    | (WorkOfferRetractionResolutionCorrelation & {
          disposition: "leased"
          leaseId: string
          workerId: string
      })

export const WorkOfferRetractionResolved =
    defineSemanticEvent<WorkOfferRetractionResolvedData>(
        "work_offer_retraction_resolved",
    )

/** Safe-to-audit route identity. Provider credentials never enter the bus. */
export interface WorkRouteDescriptor {
    routeId: string
    backend: string
    model: string
}

export interface WorkBidEstimateData extends WorkBidEstimate {
    estimateSource: "configured" | "historical"
}

export interface WorkBidData {
    runId: string
    offerId: string
    storyId: string
    generation: number
    bidId: string
    workerId: string
    route: WorkRouteDescriptor
    estimate: WorkBidEstimateData
    /** This concrete route/executor can stop retries and prove process/tool
     * quiescence before its worktree is snapshotted. */
    supportsCooperativeSuspend?: boolean
}

export const WorkBid = defineSemanticEvent<WorkBidData>("work_bid")

/** Event-sourced, credential-free route learning. It is advisory input to
 * later auctions, never execution or completion authority. */
export interface RouteEstimateUpdatedData {
    runId: string
    workerId: string
    route: WorkRouteDescriptor
    verifiedSuccesses: number
    workFailures: number
    observations: number
    estimate: WorkBidEstimateData
}

export const RouteEstimateUpdated =
    defineSemanticEvent<RouteEstimateUpdatedData>("route_estimate_updated")

/** Broker-owned semantic timer tick that closes one bounded bid window. */
export interface WorkBidWindowClosedData {
    runId: string
    offerId: string
    storyId: string
    generation: number
}

export const WorkBidWindowClosed =
    defineSemanticEvent<WorkBidWindowClosedData>("work_bid_window_closed")

export interface WorkClaimedData {
    runId: string
    offerId: string
    storyId: string
    workerId: string
    backend: string
    model: string
    bidId?: string
    route?: WorkRouteDescriptor
    supportsCooperativeSuspend?: boolean
}

export const WorkClaimed = defineSemanticEvent<WorkClaimedData>("work_claimed")

export interface WorkLeaseGrantedData {
    runId: string
    offerId: string
    leaseId: string
    workerId: string
    generation: number
    request: StorySpawnRequestData
    bidId?: string
    route?: WorkRouteDescriptor
    supportsCooperativeSuspend?: boolean
}

export const WorkLeaseGranted =
    defineSemanticEvent<WorkLeaseGrantedData>("work_lease_granted")

export interface WorkLeaseReleasedData {
    runId: string
    offerId: string
    leaseId: string
    storyId: string
    workerId: string
    reason: "integrated" | "execution_failed" | "operational_failed" | "quality_failed" | "quality_inconclusive" | "integration_failed" | "spawn_failed" | "dependency_blocked" | "aborted" | "expired"
    /** Present for a cooperative dependency suspension so retry/cost metrics
     * remain lossless even though no terminal execution result is settled. */
    attempts?: number
    durationSecs?: number
}

export const WorkLeaseReleased =
    defineSemanticEvent<WorkLeaseReleasedData>("work_lease_released")

export interface WorkLeaseExpiredData {
    runId: string
    offerId: string
    leaseId: string
    storyId: string
    workerId: string
    reason: string
}

export const WorkLeaseExpired =
    defineSemanticEvent<WorkLeaseExpiredData>("work_lease_expired")

export interface WorkOfferExpiredData {
    runId: string
    offerId: string
    storyId: string
    reason: string
}

export const WorkOfferExpired =
    defineSemanticEvent<WorkOfferExpiredData>("work_offer_expired")

export interface WorkContextRequestedData {
    runId: string
    requestId: string
    storyId: string
    hints: readonly string[]
}

export const WorkContextRequested =
    defineSemanticEvent<WorkContextRequestedData>("work_context_requested")

export interface WorkContextProvidedData {
    runId: string
    requestId: string
    storyId: string
    context: string | null
}

export const WorkContextProvided =
    defineSemanticEvent<WorkContextProvidedData>("work_context_provided")
