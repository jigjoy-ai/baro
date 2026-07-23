import type { Participant } from "./mozaik.js"

import type { AgentTargetedMessageData } from "../semantic-events.js"

/** Exact execution capability to which one collective message is delivered. */
export interface TargetedMessageCorrelation {
    runId: string
    recipientId: string
    leaseId: string
    generation: number
}

/**
 * Legacy agents intentionally remain recipient-only. Supplying an authority
 * opts an agent into fail-closed collective delivery: source identity and the
 * complete active lease capability must then match.
 */
export function acceptsTargetedMessage(
    source: Participant,
    data: AgentTargetedMessageData,
    recipientId: string,
    authority: Participant | undefined,
    correlation: Readonly<{
        runId?: string
        leaseId?: string
        generation?: number
    }>,
): boolean {
    if (data.recipientId !== recipientId) return false
    if (!authority) return true
    return (
        source === authority &&
        typeof correlation.runId === "string" &&
        correlation.runId.length > 0 &&
        typeof correlation.leaseId === "string" &&
        correlation.leaseId.length > 0 &&
        Number.isInteger(correlation.generation) &&
        correlation.generation! >= 0 &&
        data.runId === correlation.runId &&
        data.leaseId === correlation.leaseId &&
        data.generation === correlation.generation
    )
}

export function correlatedTargetedMessage(
    data: AgentTargetedMessageData,
    correlation: TargetedMessageCorrelation,
): AgentTargetedMessageData {
    return {
        recipientId: correlation.recipientId,
        text: data.text,
        metadata: Object.freeze({ ...data.metadata }),
        runId: correlation.runId,
        leaseId: correlation.leaseId,
        generation: correlation.generation,
    }
}
