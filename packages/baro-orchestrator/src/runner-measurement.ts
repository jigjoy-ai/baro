import type {
    ModelInvocationMeasuredData,
    ModelInvocationPhase,
} from "./model-telemetry.js"
import type { RunnerInvocationObservation } from "./runner-invocation.js"

export interface RunnerMeasurementContext {
    invocationBaseId: string
    runId: string | null
    phase: ModelInvocationPhase
    storyId: string | null
    attempt?: number | null
    turn?: number | null
    backend: string
    requestedModel: string | null
}

/** Add Baro correlation/dimensions to one concrete runner observation. */
export function runnerMeasurement(
    context: RunnerMeasurementContext,
    observation: RunnerInvocationObservation,
): ModelInvocationMeasuredData {
    // One wrapper process can contain several provider rounds/turns (notably
    // OpenCode/Pi when a model uses a tool). Those are deltas, so each gets a
    // distinct invocationId; runner/gateway/cloud views of that same round can
    // later share the id and be reduced without double-counting.
    const invocationId = `${context.invocationBaseId}:provider:${observation.sequence}`
    return {
        schemaVersion: 1,
        measurementId: `${invocationId}:runner`,
        invocationId,
        runId: context.runId,
        phase: context.phase,
        storyId: context.storyId,
        attempt: context.attempt ?? null,
        turn: context.turn ?? null,
        round:
            observation.granularity === "round"
                ? observation.sequence
                : null,
        backend: context.backend,
        provider: observation.provider,
        requestedModel: context.requestedModel,
        resolvedModel: observation.resolvedModel,
        status: observation.status,
        durationMs: observation.durationMs,
        tokens: observation.tokens,
        cost: observation.cost,
        evidence: {
            producer: "runner",
            providerRequestId: observation.providerRequestId,
            rateCardVersion: null,
            granularity: observation.granularity,
        },
    }
}
