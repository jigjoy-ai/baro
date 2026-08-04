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

/**
 * A story proved a factual claim the contract makes about this repository or
 * runtime to be false. A premise is not a decision: the ADR's decision stands,
 * the claim is withdrawn, and the host — never the model — holds the pen.
 */
export interface ArchitecturePremiseDisputedData {
    runId: string
    storyId: string
    /** The claim as the contract states it. */
    claim: string
    /** The command whose output withdraws it, and that output. */
    command: string
    output: string
    /** The obligation whose text embeds the claim, when the story names one. */
    obligationId?: string
}

export const ArchitecturePremiseDisputed =
    defineSemanticEvent<ArchitecturePremiseDisputedData>(
        "architecture_premise_disputed",
    )

/** The host's amendment, appended to the decision document the Critic reads. */
export interface ArchitecturePremiseAmendedData {
    runId: string
    storyId: string
    claim: string
    obligationId?: string
    /** Ordinal of this amendment within the run. */
    ordinal: number
}

export const ArchitecturePremiseAmended =
    defineSemanticEvent<ArchitecturePremiseAmendedData>(
        "architecture_premise_amended",
    )
