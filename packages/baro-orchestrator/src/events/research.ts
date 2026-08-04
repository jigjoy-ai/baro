import { defineSemanticEvent } from "./define.js"

/** One question the Architect asked, handed to a scout. */
export interface ScoutDispatchedData {
    scoutId: string
    question: string
    scope?: string
}

export const ScoutDispatched =
    defineSemanticEvent<ScoutDispatchedData>("scout_dispatched")

/**
 * A scout's answer, on the bus rather than in a return value: the Architect
 * consumes it the moment it lands, sibling scouts hear it while they are
 * still reading, and the audit log keeps it.
 */
export interface ScoutFindingPublishedData {
    scoutId: string
    question: string
    answer: string
    /** False when the scout failed or returned nothing usable. */
    ok: boolean
}

export const ScoutFindingPublished =
    defineSemanticEvent<ScoutFindingPublishedData>("scout_finding_published")
