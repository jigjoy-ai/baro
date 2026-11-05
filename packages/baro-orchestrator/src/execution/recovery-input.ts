import type { SemanticEvent } from "../runtime/mozaik.js"

import {
    StoryQualityCompleted,
    StoryResult,
    type ReplanData,
    type StoryResultData,
} from "../semantic-events.js"
import { isProviderCapacityFailure } from "../harness/provider-failure.js"

/**
 * Normalize every terminal recovery trigger to the historical StoryResult
 * failure shape consumed by all Surgeon implementations.
 */
export function recoveryInput(
    event: SemanticEvent<string, unknown>,
): StoryResultData | null {
    if (StoryResult.is(event)) {
        return event.payload.suspension !== undefined ||
            event.payload.success ||
            isProviderCapacityFailure(event.payload) ||
            (event.payload.failure !== undefined &&
                !isSemanticWorkFailure(event.payload))
            ? null
            : event.payload
    }
    if (!StoryQualityCompleted.is(event) || event.payload.status !== "failed") {
        return null
    }

    const violated = event.payload.critique?.violatedCriteria ?? []
    const violationSuffix = violated.length > 0
        ? ` (violated: ${violated.join("; ")})`
        : ""
    return {
        storyId: event.payload.storyId,
        success: false,
        // Execution itself succeeded; these neutral values let the existing
        // Surgeon prompt/replan contract represent a post-execution failure.
        attempts: 1,
        durationSecs: 0,
        error: `acceptance quality gate failed: ${event.payload.reason}${violationSuffix}`,
        runId: event.payload.runId,
        leaseId: event.payload.leaseId,
        generation: event.payload.generation,
    }
}

function isSemanticWorkFailure(result: StoryResultData): boolean {
    const failure = result.failure
    return failure?.kind === "execution" ||
        (failure?.kind === "verification" &&
            (failure.code === "acceptance_not_met" ||
                failure.code === "canonical_check_failed"))
}

/** Bind a graph mutation to the exact failed execution that produced it. */
export function correlateRecoveryReplan(
    replan: ReplanData,
    failure: StoryResultData,
): ReplanData {
    return {
        ...replan,
        recovery: {
            ...(failure.runId ? { runId: failure.runId } : {}),
            storyId: failure.storyId,
            ...(failure.leaseId ? { leaseId: failure.leaseId } : {}),
            ...(failure.generation !== undefined
                ? { generation: failure.generation }
                : {}),
        },
    }
}
