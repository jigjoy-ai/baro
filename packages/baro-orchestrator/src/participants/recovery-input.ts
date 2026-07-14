import type { SemanticEvent } from "@mozaik-ai/core"

import {
    StoryQualityCompleted,
    StoryResult,
    type ReplanData,
    type StoryResultData,
} from "../semantic-events.js"
import { isProviderCapacityFailure } from "../provider-failure.js"

/**
 * Normalize every terminal recovery trigger to the historical StoryResult
 * failure shape consumed by all Surgeon implementations.
 */
export function recoveryInput(
    event: SemanticEvent<unknown>,
): StoryResultData | null {
    if (StoryResult.is(event)) {
        return event.data.success ||
            isProviderCapacityFailure(event.data) ||
            (event.data.failure !== undefined &&
                !isSemanticWorkFailure(event.data))
            ? null
            : event.data
    }
    if (!StoryQualityCompleted.is(event) || event.data.status !== "failed") {
        return null
    }

    const violated = event.data.critique?.violatedCriteria ?? []
    const violationSuffix = violated.length > 0
        ? ` (violated: ${violated.join("; ")})`
        : ""
    return {
        storyId: event.data.storyId,
        success: false,
        // Execution itself succeeded; these neutral values let the existing
        // Surgeon prompt/replan contract represent a post-execution failure.
        attempts: 1,
        durationSecs: 0,
        error: `acceptance quality gate failed: ${event.data.reason}${violationSuffix}`,
        runId: event.data.runId,
        leaseId: event.data.leaseId,
        generation: event.data.generation,
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
