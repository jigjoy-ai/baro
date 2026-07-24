import {
    classifyStoryFailure,
    compactProviderFailureDetail,
} from "../provider-failure.js"
import type { StoryFailureData } from "../semantic-events.js"

export interface DescribedCliStoryFailure {
    error: string
    failure: StoryFailureData
}

/** Keep enough stderr for classification without retaining an unbounded log. */
export function appendCliDiagnosticTail(
    current: string,
    chunk: string,
    maxChars = 8 * 1024,
): string {
    if (maxChars <= 0) return ""
    const combined = current + chunk
    return combined.length <= maxChars
        ? combined
        : combined.slice(combined.length - maxChars)
}

/**
 * Classify an already-failed one-shot CLI attempt. Provider envelopes win;
 * otherwise the caller supplies the local/model fallback based on the exact
 * lifecycle path that failed.
 */
export function describeCliStoryFailure(
    error: string,
    fallback: StoryFailureData,
    providerSignals: readonly unknown[] = [],
): DescribedCliStoryFailure {
    const classified = classifyStoryFailure(...providerSignals)
    if (classified) return { error, failure: classified }

    const diagnostic = [
        error,
        ...providerSignals.map((item) => compactProviderFailureDetail(item)),
    ]
        .filter(Boolean)
        .join(" ")
    if (
        /\b(?:401|403)\b|unauthori[sz]ed|authentication (?:failed|required)|invalid api key|missing (?:api key|credentials?)/i.test(
            diagnostic,
        )
    ) {
        return {
            error,
            failure: {
                kind: "infrastructure",
                code: "authentication_failed",
            },
        }
    }
    if (
        /sandbox (?:denied|violation)|permission denied|operation not permitted/i.test(
            diagnostic,
        )
    ) {
        return {
            error,
            failure: { kind: "infrastructure", code: "sandbox_denied" },
        }
    }
    if (
        /missing required (?:local )?(?:tool|executable)|required (?:local )?(?:tool|executable).{0,80}(?:not found|not installed|unavailable)/i.test(
            diagnostic,
        )
    ) {
        return {
            error,
            failure: { kind: "infrastructure", code: "tool_unavailable" },
        }
    }
    return { error, failure: fallback }
}

/** Keep only envelopes that can explain a terminal CLI failure. */
export function isCliFailureSignal(value: unknown, eventType: string): boolean {
    if (classifyStoryFailure(value)) return true
    if (/error|fail|abort|denied|unauthori[sz]ed/i.test(eventType)) return true
    const detail = compactProviderFailureDetail(value)
    return /authentication (?:failed|required)|invalid api key|missing (?:api key|credentials?)|sandbox (?:denied|violation)|permission denied|operation not permitted|missing required (?:local )?(?:tool|executable)|required (?:local )?(?:tool|executable).{0,80}(?:not found|not installed|unavailable)/i.test(
        detail,
    )
}

/** Typed operational lanes are recovered by Board/Broker, not local retry. */
export function boardOwnsCliRecovery(
    failure: StoryFailureData | undefined,
): boolean {
    return failure !== undefined && failure.kind !== "execution"
}
