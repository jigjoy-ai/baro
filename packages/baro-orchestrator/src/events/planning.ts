/** Progressive planning stream: planner fragments and stream lifecycle. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

// Progressive planning is an opt-in collective control-plane lane. Planner
// fragments are proposals until the Board validates and durably admits them;
// merely publishing one never grants execution authority.

export interface PlanningStreamOpenedData {
    runId: string
    planningId: string
}

export const PlanningStreamOpened =
    defineSemanticEvent<PlanningStreamOpenedData>("planning_stream_opened")

export interface PlanFragmentProposedData {
    runId: string
    planningId: string
    fragmentId: string
    /** One-based, gap-free position in the planner stream. */
    ordinal: number
    /** Add-only stories. Every dependency must already exist or be present
     * in this same fragment before the Board may admit it. */
    stories: readonly unknown[]
}

export const PlanFragmentProposed =
    defineSemanticEvent<PlanFragmentProposedData>("plan_fragment_proposed")

export interface PlanFragmentAdmittedData {
    runId: string
    planningId: string
    fragmentId: string
    ordinal: number
    graphVersion: number
    storyIds: readonly string[]
    replay: boolean
}

export const PlanFragmentAdmitted =
    defineSemanticEvent<PlanFragmentAdmittedData>("plan_fragment_admitted")

export type PlanFragmentRejectionCode =
    | "invalid_fragment"
    | "unauthorized"
    | "planning_not_open"
    | "planning_id_mismatch"
    | "ordinal_gap"
    | "fragment_id_conflict"
    | "final_plan_mismatch"
    | "graph_rejected"

export interface PlanFragmentRejectedData {
    runId: string
    planningId: string
    fragmentId?: string
    ordinal?: number
    code: PlanFragmentRejectionCode
    reason: string
}

export const PlanFragmentRejected =
    defineSemanticEvent<PlanFragmentRejectedData>("plan_fragment_rejected")

export interface PlanningStreamCompletedData {
    runId: string
    planningId: string
    /** Kept provider-neutral at the bus boundary; the Board normalizes it
     * through the canonical PRD loader before reconciliation. */
    finalPrd: unknown
}

export const PlanningStreamCompleted =
    defineSemanticEvent<PlanningStreamCompletedData>("planning_stream_completed")

export interface PlanningStreamFailedData {
    runId: string
    planningId: string
    code: string
    reason: string
}

export const PlanningStreamFailed =
    defineSemanticEvent<PlanningStreamFailedData>("planning_stream_failed")

export interface PlanningStreamClosedData {
    runId: string
    planningId: string
    status: "completed" | "failed"
    graphVersion: number
    reason?: string
}

export const PlanningStreamClosed =
    defineSemanticEvent<PlanningStreamClosedData>("planning_stream_closed")
