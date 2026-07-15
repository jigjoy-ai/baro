import type { ModelInvocationPhase } from "../model-telemetry.js"
import { assertCorrelationId } from "./conversation-contract.js"

export type FrontDoorBillingRole = "conversation" | "repository_scout"

/** Pre-PRD billing identity is owned by the durable conversation session. */
export function trustedFrontDoorBillingRunId(sessionId: unknown): string {
    assertCorrelationId(sessionId, "front-door billing sessionId")
    return sessionId
}

/**
 * Reuse existing lossless telemetry phases without extending the public wire
 * schema: user dialogue remains `dialogue`, repository intake is `intake`.
 */
export function frontDoorBillingPhase(
    role: FrontDoorBillingRole | undefined,
): ModelInvocationPhase {
    return role === "repository_scout" ? "intake" : "dialogue"
}
