import type {
    RuntimeReplanAppliedData,
    RuntimeReplanProposedData,
} from "../semantic-events.js"

/** Stable content identity shared by live decisions and durable-ledger reads. */
export function runtimeProposalFingerprint(
    proposal: RuntimeReplanProposedData,
): string {
    try {
        return JSON.stringify(canonicalValue(proposal))
    } catch {
        return "<unserializable>"
    }
}

/** Rebuild the exact proposal payload embedded in an authoritative Applied. */
export function runtimeAppliedProposalFingerprint(
    applied: RuntimeReplanAppliedData,
): string {
    return runtimeProposalFingerprint({
        runId: applied.runId,
        proposalId: applied.proposalId,
        sourceStoryId: applied.sourceStoryId,
        leaseId: applied.leaseId,
        generation: applied.generation,
        baseGraphVersion: applied.baseGraphVersion,
        reason: applied.reason,
        mutation: applied.mutation,
    })
}

export function runtimeDecisionFingerprintMatches(decision: {
    fingerprint: string
    applied: RuntimeReplanAppliedData
}): boolean {
    return (
        decision.fingerprint ===
        runtimeAppliedProposalFingerprint(decision.applied)
    )
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (!value || typeof value !== "object") return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .map((key) => [key, canonicalValue(record[key])]),
    )
}
