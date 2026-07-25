/** Acceptance evaluation: Critic verdicts and story quality decisions. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

/**
 * Verdict from the Critic. Historic wire JSON used snake_case keys to
 * match the Rust TUI; the interface is camelCase — no in-process consumer
 * reads snake_case, so any mapping happens at the audit-log boundary.
 */
export interface CritiqueData {
    agentId: string
    /** Exact producer-issued terminal turn this verdict evaluates. Optional
     * only for replay compatibility with audit logs written before the
     * continuation handshake existed. */
    terminalId?: string
    /** `inconclusive` means the evaluator/protocol failed; it is never
     * evidence that the candidate code is wrong. Missing means `evaluated`
     * for replay compatibility. */
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: readonly string[]
    turn: number
    modelUsed: string
    /** Exact changed-content fingerprint bracketed around the complete Critic
     * evidence capture. Present only when that live repository snapshot stayed
     * stable; collective integration rechecks it immediately before merge. */
    repositoryFingerprint?: string
}

export const Critique = defineSemanticEvent<CritiqueData>("critique")

export interface StoryQualityCritiqueSnapshot {
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: readonly string[]
    turn: number
    modelUsed: string
    /** Stable repository identity carried from the authoritative Critic. */
    repositoryFingerprint?: string
}

export interface StoryQualityCompletedData {
    runId: string
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    status: "passed" | "failed" | "inconclusive"
    /** Null only when no acceptance criteria exist or no terminal turn arrived. */
    targetTurn: number | null
    reason: string
    critique?: StoryQualityCritiqueSnapshot
}

export const StoryQualityCompleted =
    defineSemanticEvent<StoryQualityCompletedData>("story_quality_completed")

/**
 * AcceptanceGate asks the neutral terminal projector to present the exact
 * same candidate to Critic again after an operationally inconclusive verdict.
 * The lease/worktree remain active; this event never authorizes execution or
 * a new WorkOffer.
 */
export interface StoryQualityReverificationRequestedData {
    runId: string
    requestId: string
    /** Evaluation superseded by this bounded recheck. */
    previousEvaluationId: string
    /** Evaluation id that will settle from the replayed terminal turn. */
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    /** Critic/AcceptanceGate turn containing the original candidate. */
    targetTurn: number
    /** Stable producer identity when the original stream supplied one. */
    terminalId?: string
    /** One-based recheck count for this unchanged candidate. */
    attempt: number
    reason: string
}

export const StoryQualityReverificationRequested =
    defineSemanticEvent<StoryQualityReverificationRequestedData>(
        "story_quality_reverification_requested",
    )

/** Gate-owned semantic timer tick for a missing terminal turn or critique. */
export interface StoryQualityTimedOutData {
    runId: string
    evaluationId: string
    storyId: string
    leaseId: string
    generation: number
    targetTurn: number | null
    timeoutMs: number
}

export const StoryQualityTimedOut =
    defineSemanticEvent<StoryQualityTimedOutData>("story_quality_timed_out")
